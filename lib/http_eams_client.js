/**
 * HTTP 直连版 EAMS 客户端：不启动 Chromium，纯 Node fetch + cookie jar。
 * 接口与 Playwright 版 EamsClient 对齐，monitor.js 无感知。
 *
 * 登录流程参考 tju-notify/utils/login.py，但 service 指向 EAMS（classes.tju.edu.cn）。
 */
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { CookieJar } = require('./cookie_jar');
const { strEnc } = require('./tju_cas_des');
const { parseGradeTables, normalizeSemesterOptions } = require('./eams');
const { extractSemestersFromHtml, extractAllGradesFromHtml, semesterIdFromLabel } = require('./semester');
const { atomicWriteFile } = require('./storage');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

class HttpEamsClient {
  constructor(config, options = {}) {
    this.config = config;
    this.env = options.env || process.env;
    this.log = options.log || (() => {});
    this.jar = new CookieJar();
    this.usr = this.env.EAMS_USERNAME || '';
    this.pwd = this.env.EAMS_PASSWORD || '';
    this.loggedIn = false;
    this.finalUrl = '';
    this.maxRedirects = 12;
    this.timeoutMs = 20_000;
    this.maxLoginAttempts = Number(this.env.EAMS_LOGIN_ATTEMPTS || 3);
    this.casBase = this.config.casBaseUrl || 'https://sso.tju.edu.cn/cas';
    // 会话 Cookie 持久化文件（含 CASTGC），进程重启后复用，减少完整登录/验证码次数
    this.cookieFile = path.join(this.config.rootDir, 'data', '.eams_cookies.json');
    this._loadCookies();
  }

  // ---------- Cookie 持久化 ----------
  _loadCookies() {
    try {
      if (fs.existsSync(this.cookieFile)) {
        const data = JSON.parse(fs.readFileSync(this.cookieFile, 'utf8'));
        this.jar.load(data);
        this.log('LOGIN', `已加载 ${this.jar.toJSON().length} 个会话 Cookie`);
      }
    } catch (e) {
      this.log('LOGIN', `Cookie 文件加载失败（忽略，重新登录即可）: ${e.message}`);
    }
  }

  _saveCookies() {
    try {
      atomicWriteFile(this.cookieFile, JSON.stringify(this.jar.toJSON(), null, 1));
    } catch (e) {
      this.log('LOGIN', `Cookie 保存失败: ${e.message}`);
    }
  }

  _hasCookie(url, name) {
    const h = this.jar.headersFor(url);
    return Boolean(h.Cookie && h.Cookie.split('; ').some(c => c.startsWith(name + '=')));
  }

  // ---------- tju-auth 共享登录服务模式 ----------
  // 配置了 AUTH_SERVICE_URL 后，续期/登录统一由 tju-auth 提供，本进程不再自己走 CAS。
  async _renewFromAuthService() {
    try {
      const url = this.config.authServiceUrl + '/cookies?service=eams';
      const headers = {};
      if (this.config.authToken) headers['X-TJU-Auth-Token'] = this.config.authToken;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
      const data = await res.json().catch(() => null);
      if (!data || !data.ok || !Array.isArray(data.cookies) || !data.cookies.length) {
        this.log('LOGIN', 'tju-auth 拉取失败: HTTP ' + res.status + (data && data.error ? ' ' + data.error : ''));
        return false;
      }
      // tju-auth 返回 domain 格式，CookieJar.load 需要 origin 格式
      const converted = data.cookies.map(c => ({ origin: 'https://' + c.domain, name: c.name, value: c.value, path: c.path || '/' }));
      this.jar.load(converted);
      this.loggedIn = true;
      this.finalUrl = this.config.eamsEntry;
      this._saveCookies();
      this.log('LOGIN', 'tju-auth 会话刷新成功（' + data.cookies.length + ' 条 cookie）');
      return true;
    } catch (e) {
      this.log('LOGIN', 'tju-auth 连接异常: ' + e.message);
      return false;
    }
  }

  /**
   * 检测 tju-auth 服务可达性（不修改任何状态）
   * 用于 /api/health 和健康日志
   */
  async checkAuthService() {
    if (!this.config.authServiceUrl) return { available: false, reason: '未配置 AUTH_SERVICE_URL' };
    try {
      const url = this.config.authServiceUrl + '/cookies?service=eams';
      const headers = {};
      if (this.config.authToken) headers['X-TJU-Auth-Token'] = this.config.authToken;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(5_000) });
      if (!res.ok) return { available: false, reason: 'HTTP ' + res.status };
      const data = await res.json().catch(() => null);
      if (!data || !data.ok) return { available: false, reason: data && data.error ? data.error : '响应格式异常' };
      return { available: true, reason: null, cookies: data.cookies?.length || 0 };
    } catch (e) {
      return { available: false, reason: e.message };
    }
  }

  // ---------- CASTGC 静默续期（免密码、免验证码） ----------
  // 原理：TJU CAS 的 CASTGC（单点登录会话 Cookie）未过期时，
  // 访问 cas/login?service=... 会直接 302 发新 ticket，跟随跳转即可换到新会话。
  // 参考 kissTJU server/sniper.mjs 的 renewSession()。
  async renewSession() {
    if (this.config.authServiceUrl) {
      return this._renewFromAuthService();
    }
    const service = this.config.eamsEntry;
    const casLogin = 'https://sso.tju.edu.cn/cas/login?service=' + encodeURIComponent(service);
    try {
      // 1) 带 CASTGC 访问 CAS，期望 302 + ticket
      const first = await fetch(casLogin, {
        headers: { 'User-Agent': UA, ...this.jar.headersFor(casLogin) },
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      for (const sc of first.headers.getSetCookie ? first.headers.getSetCookie() : []) {
        this.jar.setFromSetCookie(sc, casLogin);
      }
      const loc = first.headers.get('location') || '';
      if (first.status !== 302 || !/ticket=/.test(loc)) {
        this.log('LOGIN', 'CASTGC 静默续期未成功（CAS 未发 ticket），走完整登录');
        return false;
      }
      // 2) 跟随跳转链（最多 6 跳），每跳带对应 host 的 cookie
      let next = new URL(loc, casLogin);
      for (let hop = 0; hop < 6; hop++) {
        const r = await fetch(next, {
          headers: { 'User-Agent': UA, ...this.jar.headersFor(next.toString()) },
          redirect: 'manual',
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        for (const sc of r.headers.getSetCookie ? r.headers.getSetCookie() : []) {
          this.jar.setFromSetCookie(sc, next.toString());
        }
        const l = r.headers.get('location');
        if (r.status >= 300 && r.status < 400 && l) {
          next = new URL(l, next);
          continue;
        }
        break;
      }
      this.finalUrl = next.toString();
      // 3) 判定：最终落在 EAMS 域即视为续期成功（落在 sso 登录页 = ticket 无效）
      if (next.hostname === 'classes.tju.edu.cn' || next.hostname.endsWith('.tju.edu.cn')) {
        this.loggedIn = true;
        this.log('LOGIN', `CASTGC 静默续期成功 → ${next.pathname}`);
        this._saveCookies();
        return true;
      }
      this.log('LOGIN', `续期后落在 ${next.hostname}，判定为失败`);
      return false;
    } catch (e) {
      this.log('LOGIN', `续期异常: ${e.message}`);
      return false;
    }
  }

  // ---------- 基础请求（手动跟随重定向，每跳都带/存 cookie） ----------
  async request(url, init = {}) {
    let current = url;
    let method = (init.method || 'GET').toUpperCase();
    let body = init.body;
    let headers = {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...(init.headers || {}),
    };
    for (let hop = 0; hop < this.maxRedirects; hop++) {
      const cookieH = this.jar.headersFor(current);
      const res = await fetch(current, {
        method,
        headers: { ...headers, ...cookieH },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const sc of setCookies) this.jar.setFromSetCookie(sc, current);
      this.finalUrl = current;
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        current = new URL(loc, current).toString();
        method = 'GET';
        body = undefined;
        headers = { 'User-Agent': UA, Accept: headers.Accept };
        continue;
      }
      return {
        status: res.status,
        url: current,
        headers: res.headers,
        text: async () => await res.text(),
        buffer: async () => Buffer.from(await res.arrayBuffer()),
      };
    }
    throw new Error(`重定向次数过多: ${url}`);
  }

  // ---------- 状态判断 ----------
  isOnCasPage() { return !this.loggedIn; }
  isOnEamsPage() { return this.loggedIn; }

  // ---------- 登录 ----------
  async autoLogin() {
    if (!this.usr || !this.pwd) {
      this.log('LOGIN', '未配置 EAMS_USERNAME / EAMS_PASSWORD');
      return false;
    }
    // 总超时：避免登录路径挂起（CASTGC + OCR 登录全链路）
    const loginTimeout = this.config.loginTimeoutMs || 120_000; // 默认 2 分钟
    let timedOut = false;
    const timeoutId = setTimeout(() => { timedOut = true; }, loginTimeout);
    try {
      const result = await this._doAutoLogin();
      if (timedOut) throw new Error('登录超时');
      return result;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async _doAutoLogin() {
    // 优先 CASTGC 静默续期：会话过期但 CAS 会话仍在时，免密码、免验证码恢复
    if (await this.renewSession()) return true;
    this.loggedIn = false;
    for (let attempt = 1; attempt <= this.maxLoginAttempts; attempt++) {
      try {
        const ok = await this._attemptLogin();
        if (ok) {
          this.log('LOGIN', `登录成功 (第 ${attempt} 次)`);
          this._saveCookies(); // 完整登录成功，持久化新 CASTGC
          return true;
        }
        this.log('LOGIN', `第 ${attempt} 次登录被打回，换验证码重试`);
      } catch (e) {
        this.log('LOGIN', `第 ${attempt} 次登录异常: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    return false;
  }

  async login() { return this.autoLogin(); }

  async waitForEams(/* timeoutMs */) {
    // HTTP 无头版没有"等人在浏览器登录"的语义，直接返回当前状态
    return this.loggedIn;
  }

  async _attemptLogin() {
    // 1) 访问 EAMS 入口，会被 302 到 CAS，建立会话
    const entry = await this.request(this.config.eamsEntry);
    if (!entry.url.includes('sso.tju.edu.cn/cas/login')) {
      // 已经有会话（理论上第一次不会发生）
      const html0 = await entry.text();
      if (html0 && !html0.includes('loginForm') && !html0.includes('id="loginForm"')) {
        this.loggedIn = true;
        return true;
      }
    }
    const casUrl = entry.url;

    // 2) 先取验证码（这一步会刷新 CAS 会话里的票据）
    const captchaRes = await this.request(this.config.casCodeUrl || 'https://sso.tju.edu.cn/cas/code');
    const captchaBuf = await captchaRes.buffer();
    const { recognizeCode } = require('./captcha_ocr');
    const code = await recognizeCode(captchaBuf, this.config);
    if (!code) throw new Error('验证码识别失败');
    this.log('LOGIN', `验证码识别: ${code}`);

    // 3) 再重新拉一次登录页，拿最新的 lt / execution（必须在取验证码之后）
    const formRes = await this.request(casUrl, { headers: { Referer: casUrl } });
    const html = await formRes.text();
    const lt = (html.match(/id="lt"\s+[^>]*value="([^"]*)"/) || [])[1] ||
               (html.match(/name="lt"\s+[^>]*value="([^"]*)"/) || [])[1] || '';
    const execution = (html.match(/name="execution"\s+[^>]*value="([^"]*)"/) || [])[1] ||
                      (html.match(/value="([^"]*)"\s+[^>]*name="execution"/) || [])[1] || '';
    if (!execution) throw new Error('登录页里找不到 execution 字段');
    this.log('LOGIN', `lt=${lt.slice(0, 12)}... execution=${execution.slice(0, 20)}...`);

    // 4) 加密密码并 POST
    const rsa = strEnc(this.usr + this.pwd + lt, '1', '2', '3');
    const form = new URLSearchParams();
    form.set('code', code);
    form.set('rsa', rsa);
    form.set('ul', String(this.usr.length));
    form.set('pl', String(this.pwd.length));
    form.set('lt', lt);
    form.set('execution', execution);
    form.set('_eventId', 'submit');

    const postRes = await this.request(casUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: casUrl,
        Origin: 'https://sso.tju.edu.cn',
      },
      body: form.toString(),
    });
    const postHtml = await postRes.text();
    // 5) 判定：最终落在 EAMS 且没有登录表单
    if (postRes.url.includes('sso.tju.edu.cn/cas/login')) {
      if (/验证码|captcha|code/i.test(postHtml)) this.log('LOGIN', 'CAS 提示验证码错误');
      return false;
    }
    if (postHtml.includes('id="loginForm"') || postHtml.includes('name="lt"')) {
      return false;
    }
    this.loggedIn = true;
    return true;
  }

  // ---------- 取数 ----------
  async _getHtml(url, logTag = 'FETCH') {
    const res = await this.request(url);
    const html = await res.text();

    // 0) 检测 EAMS 服务端故障页（500 / 出错了 / Hibernate 异常）
    if (html && (
      html.includes('出错了') ||
      html.includes('Error happened') ||
      html.includes('CannotCreateTransactionException') ||
      html.includes('JDBC begin transaction failed') ||
      html.includes('org.springframework')
    )) {
      this.log(logTag, 'EAMS 服务端返回错误页，跳过本次检查');
      // 抛 ServerError，让监控层分类处理（不计入普通失败，可重试）
      const { ServerError } = require('./errors');
      throw new ServerError('EAMS 服务端故障: ' + html.slice(0, 200).replace(/[\r\n]+/g, ' ').trim(), { cause: null });
    }

    // 1) 检测 CAS 登录页（会话过期）
    if (res.url.includes('sso.tju.edu.cn/cas/login') ||
        (html && (html.includes('id="loginForm"') || html.includes('name="lt"')))) {
      this.loggedIn = false;
      this.log(logTag, '被重定向到 CAS，会话过期');
      return null;
    }
    return { html, url: res.url };
  }

  /** 把一张 HTML 表格转成和 Playwright readGradeTables 同结构 */
  _tablesFromHtml(html) {
    const $ = cheerio.load(html);
    const out = [];
    $('table').each((_, table) => {
      const headerRow = $(table).find('tr').filter((_, tr) => $(tr).find('th').length >= 2).first();
      const headers = headerRow.find('th').map((_, th) => $(th).text() || '').get();
      const rows = [];
      $(table).find('tr').each((_, tr) => {
        const cells = $(tr).find('td').map((_, td) => $(td).text() || '').get();
        if (cells.length > 0) rows.push({ className: $(tr).attr('class') || '', cells });
      });
      out.push({ headers, rows });
    });
    return out;
  }

  async extractGrades(options = {}) {
    const semesterId = options.semesterId;
    const logTag = options.logTag || 'EXTRACT';
    const url = new URL(this.config.gradeUrl, this.config.eamsEntry);
    if (semesterId !== undefined) {
      if (!/^\d+$/.test(String(semesterId))) throw new Error('学期编号不正确');
      url.searchParams.set('semesterId', String(semesterId));
    }
    const page = await this._getHtml(url.toString(), logTag);
    if (!page) return [];
    let grades = parseGradeTables(this._tablesFromHtml(page.html));
    // 空表重试一次
    if (grades.length === 0) {
      this.log(logTag, '表格为空，重试一次');
      await new Promise(r => setTimeout(r, 2000));
      const retry = await this._getHtml(url.toString(), logTag);
      if (retry) grades = parseGradeTables(this._tablesFromHtml(retry.html));
    }
    this.log(logTag, `共 ${grades.length} 门课程`);
    return grades;
  }

  async extractWeightedGrades() {
    const page = await this._getHtml(this.config.weightedGradeUrl, 'WEIGHT');
    if (!page) return null;
    const $ = cheerio.load(page.html);
    const summary = new Set();
    $('td, th, span, div, p, font').each((_, el) => {
      const t = ($(el).text() || '').trim();
      if (t && /(?:平均|加权|总学|GPA|绩点|均分|累计)/i.test(t)) summary.add(t);
    });
    const tableGrades = [];
    $('table').each((_, table) => {
      $(table).find('tr').each((_, tr) => {
        const cells = $(tr).find('td, th').map((_, td) =>
          ($(td).text() || '').trim().replace(/\s+/g, ' ')).get();
        if (cells.length >= 2) tableGrades.push(cells);
      });
    });
    const result = { summary: [...summary], tableGrades };
    this.log('WEIGHT', `提取到 ${result.summary.length} 条汇总, ${result.tableGrades.length} 行表格`);
    return result;
  }

  async listSemesters() {
    // 从 historyCourseGrade 端点提取学期列表（该端点返回完整表格，不依赖 JS 渲染）
    const page = await this._getHtml(this.config.weightedGradeUrl, 'SEMESTER');
    if (!page) return [];
    const labels = extractSemestersFromHtml(page.html);
    if (labels.length === 0) return [];

    // 将学期字符串映射为 semesterId
    const results = labels.map(label => {
      const id = semesterIdFromLabel(label);
      return { id: id !== null ? String(id) : label, label, current: false };
    });
    this.log('SEMESTER', `发现 ${results.length} 个学期`);
    return results;
  }
}

module.exports = { HttpEamsClient };
