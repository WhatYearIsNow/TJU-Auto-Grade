const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execFile } = require('child_process');

function normalizeCell(value) {
  return String(value ?? '').replace(/\u00a0/g, '').replace(/\s+/g, ' ').trim();
}

function parseGradeTables(tables) {
  const grades = [];
  for (const table of tables) {
    const headers = (table.headers || []).map(value => normalizeCell(value).replace(/\s/g, ''));
    if (headers.length < 2) continue;
    const scoreIndex = headers.findIndex(header => header === '总评成绩' || header.includes('总评'));
    const nameIndex = headers.findIndex(header => header === '课程名称');
    if (scoreIndex < 0 || nameIndex < 0) continue;

    for (const sourceRow of table.rows || []) {
      if (/title|head|info/i.test(sourceRow.className || '')) continue;
      const cells = sourceRow.cells || [];
      if (cells.length < headers.length) continue;
      const grade = {};
      for (let index = 0; index < headers.length; index++) {
        const text = normalizeCell(cells[index]);
        grade[headers[index]] = index === scoreIndex && text !== '' && Number.isFinite(Number(text))
          ? Number(text)
          : text;
      }
      if (grade[headers[nameIndex]] && grade[headers[scoreIndex]] !== '') grades.push(grade);
    }
  }
  return grades;
}

function isFatalBrowserError(error) {
  const message = String(error?.message || '').toLowerCase();
  return message.includes('has been closed') || message.includes('target closed');
}

function normalizeSemesterOptions(options) {
  const semesters = [];
  const seen = new Set();
  for (const option of options || []) {
    const id = String(option?.id || '').trim();
    const label = normalizeCell(option?.label);
    if (!/^\d+$/.test(id) || !label || seen.has(id)) continue;
    seen.add(id);
    semesters.push({ id, label, current: Boolean(option.current) });
  }
  return semesters;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => {
    rl.close();
    resolve(answer.trim());
  }));
}

class EamsClient {
  constructor(page, config, options = {}) {
    this.page = page;
    this.config = config;
    this.env = options.env || process.env;
    this.log = options.log || (() => {});
    this.ask = options.ask || ask;
    this.execFile = options.execFile || execFile;
  }

  isOnCasPage() {
    return this.page.url().includes('sso.tju.edu.cn');
  }

  isOnEamsPage() {
    return this.page.url().includes('classes.tju.edu.cn') && !this.isOnCasPage();
  }

  async retry(fn, times, label) {
    for (let attempt = 0; attempt < times; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (isFatalBrowserError(error) || attempt === times - 1) throw error;
        const delay = Math.min((attempt + 1) * 3000, 15_000);
        this.log('RETRY', `${label} 第${attempt + 1}次失败（${error.message.slice(0, 60)}），${delay / 1000}s后重试...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    throw new Error(`${label} 重试失败`);
  }

  async autoLogin() {
    const username = this.env.EAMS_USERNAME;
    const password = this.env.EAMS_PASSWORD;
    if (!username || !password || !this.env.DASHSCOPE_API_KEY) return false;
    const captchaPath = path.join(this.config.rootDir, '.captcha_tmp.png');

    for (let attempt = 1; attempt <= 3; attempt++) {
      this.log('LOGIN', `AI 自动登录 第 ${attempt}/3 次...`);
      try { await this.page.waitForSelector('#codeImage', { timeout: 10_000 }); }
      catch { continue; }
      await this.page.waitForTimeout(500);
      const captcha = await this.page.$('#codeImage');
      if (!captcha) continue;
      await captcha.screenshot({ path: captchaPath });

      let code = null;
      try {
        code = await new Promise((resolve, reject) => {
          this.execFile(process.execPath, [
            path.join(this.config.rootDir, 'vision.js'),
            captchaPath,
            '只返回验证码字符，不要任何解释',
          ], { timeout: 15_000, env: this.env }, (error, stdout) => {
            if (error) return reject(error);
            resolve((stdout || '').trim().match(/[a-zA-Z0-9]{4,6}/)?.[0] || null);
          });
        });
      } catch (error) {
        this.log('LOGIN', `AI 识别失败: ${error.message}`);
      } finally {
        try { fs.unlinkSync(captchaPath); } catch {}
      }
      if (!code) continue;

      await this.page.fill('#un', username);
      await this.page.fill('#pd', password);
      await this.page.fill('#code', code);
      await this.page.press('#code', 'Enter');
      if (await this.waitForEams(10_000)) {
        this.log('LOGIN', 'AI 登录成功');
        return true;
      }

      const errorText = await this.page.evaluate(() => {
        const element = document.querySelector('#loginErrorMessage, .error, .msg, .alert-error, [class*="error"]');
        return element?.textContent?.trim() || null;
      });
      this.log('LOGIN', `失败: ${errorText || '验证码错误'}`);
      try {
        await this.page.click('#a_changeCode');
        await this.page.waitForTimeout(800);
      } catch {}
    }
    return false;
  }

  async manualLogin() {
    if (this.config.headless) {
      this.log('LOGIN', 'HEADLESS=true 时无法手动登录');
      return false;
    }
    console.log('\n请在浏览器窗口中完成登录，登录后脚本会自动接管。\n');
    let username = this.env.EAMS_USERNAME || '';
    let password = this.env.EAMS_PASSWORD || '';
    if (process.stdin.isTTY) {
      username ||= await this.ask('学号 (直接回车跳过) > ');
      password ||= await this.ask('密码 (直接回车跳过) > ');
    }

    if (username && password) {
      await this.page.waitForSelector('#un', { timeout: 60_000 }).catch(() => {});
      if (await this.page.$('#un')) {
        await this.page.fill('#un', username);
        await this.page.fill('#pd', password);
        this.log('LOGIN', '已填写账号密码，请在浏览器中输入验证码并登录');
      }
    } else {
      this.log('LOGIN', '请在浏览器中自行填写登录信息');
    }
    const success = await this.waitForEams(5 * 60 * 1000);
    this.log('LOGIN', success ? '登录成功' : '等待登录超时');
    return success;
  }

  async waitForEams(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.isOnEamsPage()) return true;
      await this.page.waitForTimeout(1000);
    }
    return false;
  }

  async login() {
    if (await this.autoLogin()) return true;
    return this.manualLogin();
  }

  async readGradeTables() {
    return this.page.$$eval('table', tables => tables.map(table => {
      const headerRow = Array.from(table.querySelectorAll('tr'))
        .find(row => row.querySelectorAll('th').length >= 2);
      const headers = headerRow
        ? Array.from(headerRow.querySelectorAll('th')).map(cell => cell.textContent || '')
        : [];
      const rows = Array.from(table.querySelectorAll('tr')).map(row => ({
        className: row.getAttribute('class') || '',
        cells: Array.from(row.querySelectorAll('td')).map(cell => cell.textContent || ''),
      })).filter(row => row.cells.length > 0);
      return { headers, rows };
    }));
  }

  gradePageUrl(semesterId) {
    const gradePageUrl = new URL(this.config.gradeUrl, this.config.eamsEntry);
    if (semesterId !== undefined) {
      const id = String(semesterId);
      if (!/^\d+$/.test(id)) throw new Error('学期编号不正确');
      gradePageUrl.searchParams.set('semesterId', id);
    }
    return gradePageUrl.toString();
  }

  semesterPageUrl() {
    const semesterPageUrl = new URL(this.gradePageUrl());
    semesterPageUrl.pathname = semesterPageUrl.pathname.replace(/person!search\.action$/, 'person.action');
    semesterPageUrl.search = '';
    return semesterPageUrl.toString();
  }

  async navigateGradePage(semesterId, logTag = 'EXTRACT') {
    const gradePageUrl = this.gradePageUrl(semesterId);
    await this.retry(() => this.page.goto(gradePageUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    }), 5, '成绩页面加载');
    await this.page.waitForTimeout(2000);
    if (this.isOnCasPage()) {
      this.log(logTag, '页面重定向到 CAS，会话过期');
      return false;
    }
    return true;
  }

  async listSemesters() {
    await this.retry(() => this.page.goto(this.semesterPageUrl(), {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    }), 3, '学期列表页面加载');
    await this.page.waitForTimeout(2000);
    if (this.isOnCasPage()) {
      this.log('SEMESTER', '页面重定向到 CAS，会话过期');
      return [];
    }
    const options = await this.page.evaluate(async () => {
      const results = [];
      const add = (id, label, current = false) => results.push({ id, label, current });
      const currentId = document.querySelector('#semesterCalendar_target')?.value || '';
      const yearCells = Array.from(document.querySelectorAll('#semesterCalendar_yearTb td[index]'));
      if (yearCells.length > 0) {
        for (const yearCell of yearCells) {
          const year = (yearCell.textContent || '').trim();
          yearCell.click();
          await new Promise(resolve => setTimeout(resolve, 20));
          for (const termCell of document.querySelectorAll('#semesterCalendar_termTb td[val]')) {
            const id = termCell.getAttribute('val');
            const term = (termCell.querySelector('span')?.textContent || termCell.textContent || '').trim();
            add(id, `${year} ${term}`, id === currentId);
          }
        }
        const currentIndex = results.findIndex(item => item.current);
        return (currentIndex >= 0 ? results.slice(0, currentIndex + 1) : results).reverse();
      }
      for (const select of document.querySelectorAll('select')) {
        const identity = `${select.name || ''} ${select.id || ''}`;
        const optionList = Array.from(select.options || []);
        const looksLikeSemester = /semester|学期/i.test(identity) || optionList.some(option =>
          /20\d{2}\s*[-—]\s*20\d{2}|20\d{2}\s*[-—]\s*\d{2}/.test(option.textContent || '')
        );
        if (!looksLikeSemester) continue;
        optionList.forEach(option => add(option.value, option.textContent, option.selected));
      }
      for (const link of document.querySelectorAll('a[href*="semesterId="]')) {
        try {
          const url = new URL(link.href, location.href);
          add(url.searchParams.get('semesterId'), link.textContent, false);
        } catch {}
      }
      return results;
    });
    const semesters = normalizeSemesterOptions(options);
    this.log('SEMESTER', `发现 ${semesters.length} 个可查询学期`);
    return semesters;
  }

  async extractGrades(options = {}) {
    const semesterId = options.semesterId;
    const logTag = options.logTag || 'EXTRACT';
    if (!await this.navigateGradePage(semesterId, logTag)) return [];

    try {
      const allCheckbox = this.page.locator('input[type="checkbox"]').first();
      if (await allCheckbox.count() > 0 && !await allCheckbox.isChecked()) {
        await allCheckbox.check();
        await this.page.waitForTimeout(2000);
      }
    } catch {}

    try { await this.page.waitForSelector('table', { timeout: 20_000 }); } catch {}
    let grades = parseGradeTables(await this.readGradeTables());
    for (let attempt = 1; grades.length === 0 && attempt <= 2; attempt++) {
      this.log(logTag, `表格为空，刷新重试 (${attempt}/2)...`);
      try {
        await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
        await this.page.waitForTimeout(3000);
        if (this.isOnCasPage()) break;
        await this.page.waitForSelector('table', { timeout: 20_000 });
        grades = parseGradeTables(await this.readGradeTables());
      } catch (error) {
        this.log(logTag, `刷新重试异常: ${error.message}`);
      }
    }
    this.log(logTag, `共 ${grades.length} 门课程`);
    return grades;
  }

  async extractWeightedGrades() {
    await this.page.goto(this.config.weightedGradeUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await this.page.waitForTimeout(2000);
    if (this.isOnCasPage()) {
      this.log('WEIGHT', '总加权页面重定向到 CAS，会话过期');
      return null;
    }

    const result = await this.page.evaluate(() => {
      const summary = Array.from(document.querySelectorAll('td, th, span, div, p, font'))
        .map(element => element.textContent?.trim() || '')
        .filter(text => text && /(?:平均|加权|总学|GPA|绩点|均分|累计)/i.test(text));
      const tableGrades = [];
      for (const table of document.querySelectorAll('table')) {
        for (const row of table.querySelectorAll('tr')) {
          const cells = Array.from(row.querySelectorAll('td, th'))
            .map(cell => (cell.textContent || '').trim().replace(/\s+/g, ' '));
          if (cells.length >= 2) tableGrades.push(cells);
        }
      }
      return { summary: [...new Set(summary)], tableGrades };
    });
    this.log('WEIGHT', `提取到 ${result.summary.length} 条汇总, ${result.tableGrades.length} 行表格`);
    return result;
  }
}

module.exports = {
  EamsClient,
  isFatalBrowserError,
  normalizeCell,
  normalizeSemesterOptions,
  parseGradeTables,
};
