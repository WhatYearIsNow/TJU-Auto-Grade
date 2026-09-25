const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { createConfig, parseEnv } = require('./config');
const { isValidEmail } = require('./mailer');
const { atomicWriteFile, readGradesSnapshot, readJson } = require('./storage');

const EDITABLE_KEYS = new Set([
  'EAMS_USERNAME', 'EAMS_PASSWORD', 'DASHSCOPE_API_KEY', 'VISION_MODEL', 'CAPTCHA_PROVIDER',
  'QQ_EMAIL', 'QQ_SMTP_CODE', 'NOTIFY_EMAIL', 'COMMAND_EMAIL', 'COMMAND_TOKEN',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS',
  'IMAP_HOST', 'IMAP_PORT', 'IMAP_USER', 'IMAP_PASS',
  'CHECK_INTERVAL_MINUTES', 'RELOGIN_TIMEOUT_MINUTES', 'BROWSER_CHANNEL', 'HEADLESS',
  'IMAP_ENABLED', 'IMAP_INTERVAL_SECONDS', 'IMAP_SOCKET_TIMEOUT_SECONDS',
  'OUTBOX_POLL_INTERVAL_SECONDS', 'OUTBOX_RETRY_BASE_SECONDS', 'OUTBOX_RETRY_MAX_SECONDS',
  'OUTBOX_RETENTION_DAYS',
]);

const SECRET_KEYS = new Set([
  'EAMS_PASSWORD', 'QQ_SMTP_CODE', 'DASHSCOPE_API_KEY', 'COMMAND_TOKEN',
  'SMTP_PASS', 'IMAP_PASS',
]);

const PUBLIC_SETTING_KEYS = [
  'EAMS_USERNAME', 'VISION_MODEL', 'CAPTCHA_PROVIDER', 'QQ_EMAIL', 'NOTIFY_EMAIL', 'COMMAND_EMAIL',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER',
  'IMAP_HOST', 'IMAP_PORT', 'IMAP_USER',
  'CHECK_INTERVAL_MINUTES', 'RELOGIN_TIMEOUT_MINUTES', 'BROWSER_CHANNEL', 'HEADLESS',
  'IMAP_ENABLED', 'IMAP_INTERVAL_SECONDS', 'IMAP_SOCKET_TIMEOUT_SECONDS',
  'OUTBOX_POLL_INTERVAL_SECONDS', 'OUTBOX_RETRY_BASE_SECONDS', 'OUTBOX_RETRY_MAX_SECONDS',
  'OUTBOX_RETENTION_DAYS',
];

const SETTING_DEFAULTS = Object.freeze({
  CAPTCHA_PROVIDER: 'tesseract',
  VISION_MODEL: 'qwen3.5-ocr',
  SMTP_HOST: 'smtp.qq.com',
  SMTP_PORT: '465',
  SMTP_SECURE: 'true',
  IMAP_HOST: 'imap.qq.com',
  IMAP_PORT: '993',
  CHECK_INTERVAL_MINUTES: '5',
  RELOGIN_TIMEOUT_MINUTES: '10',
  BROWSER_CHANNEL: 'msedge',
  HEADLESS: 'false',
  IMAP_ENABLED: 'true',
  IMAP_INTERVAL_SECONDS: '60',
  IMAP_SOCKET_TIMEOUT_SECONDS: '600',
  OUTBOX_POLL_INTERVAL_SECONDS: '30',
  OUTBOX_RETRY_BASE_SECONDS: '60',
  OUTBOX_RETRY_MAX_SECONDS: '3600',
  OUTBOX_RETENTION_DAYS: '30',
});

const NUMBER_RANGES = Object.freeze({
  SMTP_PORT: [1, 65535],
  IMAP_PORT: [1, 65535],
  CHECK_INTERVAL_MINUTES: [1, 1440],
  RELOGIN_TIMEOUT_MINUTES: [1, 120],
  IMAP_INTERVAL_SECONDS: [15, 3600],
  IMAP_SOCKET_TIMEOUT_SECONDS: [60, 1800],
  OUTBOX_POLL_INTERVAL_SECONDS: [10, 3600],
  OUTBOX_RETRY_BASE_SECONDS: [10, 3600],
  OUTBOX_RETRY_MAX_SECONDS: [60, 86400],
  OUTBOX_RETENTION_DAYS: [1, 365],
});

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function readEnvironment(rootDir, baseEnv = process.env) {
  const file = path.join(rootDir, 'eams.env');
  let fileValues = {};
  try { fileValues = parseEnv(fs.readFileSync(file, 'utf-8')); } catch {}
  const env = { ...fileValues, ...baseEnv };
  return { config: createConfig(rootDir, env), env, fileValues };
}

function validateSettings(updates) {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    throw new Error('设置内容格式不正确');
  }
  const normalized = {};
  for (const [key, rawValue] of Object.entries(updates)) {
    if (!EDITABLE_KEYS.has(key)) throw new Error(`不允许修改配置项 ${key}`);
    if (rawValue === null || rawValue === undefined) continue;
    const value = String(rawValue).trim();
    if (value.includes('\r') || value.includes('\n')) throw new Error(`${key} 不能包含换行`);
    if (value.length > 2048) throw new Error(`${key} 内容过长`);
    if (SECRET_KEYS.has(key) && value === '') continue;
    normalized[key] = value;
  }

  for (const key of ['QQ_EMAIL', 'NOTIFY_EMAIL', 'COMMAND_EMAIL']) {
    if (normalized[key] && !isValidEmail(normalized[key])) throw new Error(`${key} 邮箱格式不正确`);
  }
  for (const [key, [min, max]] of Object.entries(NUMBER_RANGES)) {
    if (normalized[key] === undefined) continue;
    if (!/^\d+(?:\.\d+)?$/.test(normalized[key])) throw new Error(`${key} 必须是数字`);
    const value = Number(normalized[key]);
    if (value < min || value > max) throw new Error(`${key} 必须在 ${min} 到 ${max} 之间`);
  }
  for (const key of ['HEADLESS', 'IMAP_ENABLED', 'SMTP_SECURE']) {
    if (normalized[key] !== undefined && !/^(true|false)$/i.test(normalized[key])) {
      throw new Error(`${key} 必须是 true 或 false`);
    }
  }
  if (normalized.BROWSER_CHANNEL && !['msedge', 'chromium', 'chrome'].includes(normalized.BROWSER_CHANNEL)) {
    throw new Error('BROWSER_CHANNEL 不受支持');
  }
  if (normalized.CAPTCHA_PROVIDER && !['tesseract', 'dashscope'].includes(normalized.CAPTCHA_PROVIDER)) {
    throw new Error('CAPTCHA_PROVIDER 只能是 tesseract 或 dashscope');
  }
  if (normalized.VISION_MODEL && !/^[a-zA-Z0-9._/-]+$/.test(normalized.VISION_MODEL)) {
    throw new Error('VISION_MODEL 格式不正确');
  }
  return normalized;
}

function updateEnvFile(file, updates) {
  const normalized = validateSettings(updates);
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/); } catch {}
  const remaining = new Map(Object.entries(normalized));
  const nextLines = lines.map(line => {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/);
    if (!match || !remaining.has(match[1])) return line;
    const value = remaining.get(match[1]);
    remaining.delete(match[1]);
    return `${match[1]}=${value}`;
  });
  if (remaining.size > 0) {
    if (nextLines.some(Boolean)) nextLines.push('', '# 由本机 Web 控制台更新');
    for (const [key, value] of remaining) nextLines.push(`${key}=${value}`);
  }
  while (nextLines.length > 0 && nextLines.at(-1) === '') nextLines.pop();
  atomicWriteFile(file, `${nextLines.join('\n')}\n`);
  return normalized;
}

function publicSettings(env) {
  const values = Object.fromEntries(PUBLIC_SETTING_KEYS.map(key => [
    key,
    env[key] === undefined || env[key] === '' ? SETTING_DEFAULTS[key] || '' : env[key],
  ]));
  return {
    values,
    configured: Object.fromEntries([...SECRET_KEYS].map(key => [key, Boolean(env[key])])),
    setup: setupStatus(env),
  };
}

function setupStatus(env) {
  const has = key => Boolean(String(env[key] || '').trim());
  const eamsAccount = has('EAMS_USERNAME');
  const eamsPassword = has('EAMS_PASSWORD');
  const mailUser = has('SMTP_USER') || has('QQ_EMAIL');
  const mailPassword = has('SMTP_PASS') || has('QQ_SMTP_CODE');
  const mailRecipient = has('NOTIFY_EMAIL') || mailUser;
  const electTarget = has('ELECT_TARGET_ID');
  const complete = eamsAccount && eamsPassword;
  return {
    complete,
    missing: [!eamsAccount ? 'EAMS_USERNAME' : '', !eamsPassword ? 'EAMS_PASSWORD' : ''].filter(Boolean),
    steps: {
      eams: { ready: complete, required: true },
      mail: { ready: mailUser && mailPassword && mailRecipient, required: false },
      elect: { ready: electTarget, required: false },
      aiLogin: {
        ready: (env.CAPTCHA_PROVIDER || 'tesseract') === 'tesseract' || has('DASHSCOPE_API_KEY'),
        required: false,
      },
    },
  };
}

function notificationView(item) {
  return {
    id: item.id,
    subject: item.subject,
    meta: item.meta || {},
    status: item.status,
    attempts: item.attempts || 0,
    createdAt: item.createdAt,
    nextAttemptAt: item.nextAttemptAt,
    sentAt: item.sentAt,
    lastError: item.lastError,
  };
}

class DashboardServer {
  constructor(config, controller, options = {}) {
    this.config = config;
    this.env = options.env || process.env;
    this.baseEnv = options.baseEnv || process.env;
    this.controller = controller;
    this.webDir = options.webDir || path.join(config.rootDir, 'web');
    this.token = options.token || crypto.randomBytes(32).toString('hex');
    this.host = '127.0.0.1';
    this.port = options.port ?? config.dashboardPort;
    this.server = http.createServer((request, response) => this.handle(request, response));
    // 选课监控（可选）
    this.electMonitor = null;
    if (config.electTargetId) {
      const { ElectMonitor } = require('./elect_monitor');
      this.electMonitor = new ElectMonitor(config, {
        log: (tag, msg) => {
          const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
          console.log(`[${ts}] ${tag}: ${msg}`);
        },
      });
    }
  }

  async start() {
    await new Promise((resolve, reject) => {
      const onError = error => reject(error);
      this.server.once('error', onError);
      this.server.listen(this.port, this.host, () => {
        this.server.removeListener('error', onError);
        this.port = this.server.address().port;
        resolve();
      });
    });
    return this.url;
  }

  get url() {
    return `http://${this.host}:${this.port}`;
  }

  async stop() {
    if (this.electMonitor) this.electMonitor.stop();
    if (!this.server.listening) return;
    await new Promise(resolve => this.server.close(resolve));
  }

  commonHeaders(response, contentType, nonce = '') {
    response.setHeader('Content-Type', contentType);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Cache-Control', 'no-store');
    const nonceSource = nonce ? ` 'nonce-${nonce}'` : '';
    response.setHeader('Content-Security-Policy', `default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self'${nonceSource}; style-src 'self'${nonceSource}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
  }

  sendJson(response, status, value) {
    this.commonHeaders(response, 'application/json; charset=utf-8');
    response.statusCode = status;
    response.end(JSON.stringify(value));
  }

  isLocalHost(request) {
    const hostname = String(request.headers.host || '').split(':')[0].toLowerCase();
    return hostname === '127.0.0.1' || hostname === 'localhost';
  }

  isAuthorizedMutation(request) {
    const origin = request.headers.origin;
    const allowedOrigins = new Set([
      `http://127.0.0.1:${this.port}`,
      `http://localhost:${this.port}`,
    ]);
    const supplied = String(request.headers['x-tju-dashboard-token'] || '');
    const expected = Buffer.from(this.token);
    const actual = Buffer.from(supplied);
    return allowedOrigins.has(origin) && expected.length === actual.length &&
      crypto.timingSafeEqual(expected, actual);
  }

  async readBody(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 64 * 1024) throw new Error('请求内容过大');
      chunks.push(chunk);
    }
    if (chunks.length === 0) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf-8')); }
    catch { throw new Error('JSON 格式不正确'); }
  }

  async handle(request, response) {
    try {
      if (!this.isLocalHost(request)) {
        this.sendJson(response, 403, { ok: false, error: '仅允许本机访问' });
        return;
      }
      const url = new URL(request.url, this.url);
      if (url.pathname === '/launcher-ready') {
        this.commonHeaders(response, 'application/json; charset=utf-8');
        response.setHeader('Access-Control-Allow-Origin', 'null');
        response.setHeader('Access-Control-Allow-Private-Network', 'true');
        response.statusCode = request.method === 'OPTIONS' ? 204 : 200;
        response.end(request.method === 'OPTIONS' ? undefined : '{"ok":true}');
        return;
      }
      if (request.method === 'GET' && url.pathname.startsWith('/api/')) {
        await this.handleGet(url, response);
        return;
      }
      if (request.method === 'POST' && url.pathname.startsWith('/api/')) {
        if (!this.isAuthorizedMutation(request)) {
          this.sendJson(response, 403, { ok: false, error: '写操作校验失败，请刷新页面后重试' });
          return;
        }
        const body = await this.readBody(request);
        await this.handlePost(url, body, response);
        return;
      }
      if (request.method !== 'GET') {
        this.sendJson(response, 405, { ok: false, error: '请求方法不支持' });
        return;
      }
      await this.serveStatic(url.pathname, response);
    } catch (error) {
      this.sendJson(response, 500, { ok: false, error: error.message });
    }
  }

  async handleGet(url, response) {
    if (url.pathname === '/api/status') {
      const snapshot = this.controller.snapshot();
      this.sendJson(response, 200, {
        ok: true,
        data: {
          ...snapshot,
          dashboard: { uptimeSeconds: Math.floor(process.uptime()), port: this.port },
          capabilities: {
            mail: Boolean(this.config.smtp.user && this.config.smtp.pass && this.config.smtp.to),
            imap: this.config.imapEnabled && Boolean(this.config.imap.user && this.config.imap.pass),
            aiLogin: (this.env.CAPTCHA_PROVIDER || 'tesseract') === 'tesseract' ||
              Boolean(this.env.DASHSCOPE_API_KEY),
            headless: this.config.headless,
            elect: Boolean(this.config.electTargetId),
          },
          setup: setupStatus(this.env),
          outbox: this.controller.monitor?.outbox?.stats() || null,
        },
      });
      return;
    }
    if (url.pathname === '/api/health') {
      const health = {
        ok: true,
        uptimeSeconds: Math.floor(process.uptime()),
        dependencies: {},
      };

      // tju-auth 健康
      if (this.config.authServiceUrl) {
        try {
          const { HttpEamsClient } = require('./http_eams_client');
          const hc = new HttpEamsClient(this.config, { log: () => {} });
          health.dependencies.auth = await hc.checkAuthService();
        } catch (e) {
          health.dependencies.auth = { available: false, reason: e.message };
        }
      } else {
        health.dependencies.auth = { available: false, reason: '未配置 AUTH_SERVICE_URL' };
      }

      // 通知通道健康
      health.dependencies.notifier = this.notifier?.health() || [];
      health.dependencies.primaryAvailable = this.notifier?.primaryAvailable() || false;

      // PID 健康
      try {
        const { inspectProcessHealth } = require('./storage');
        const monitorHealth = inspectProcessHealth({
          pidFile: this.config.monitorPidFile || this.config.pidFile,
          heartbeatFile: this.config.monitorHeartbeatFile || this.config.heartbeatFile,
          script: this.config.monitorScript,
          scripts: [this.config.monitorScript, this.config.dashboardScript],
          maxHeartbeatAgeMs: this.config.watchdogHeartbeatMaxAgeMs,
        });
        health.dependencies.monitor = monitorHealth;
      } catch {}

      this.sendJson(response, 200, { ok: true, data: health });
      return;
    }
    if (url.pathname === '/api/grades') {
      let grades = this.controller.monitor?.state.latestGrades || [];
      if (grades.length === 0) {
        try { grades = readGradesSnapshot(this.config.lastGradesFile); } catch {}
      }
      this.sendJson(response, 200, { ok: true, data: grades });
      return;
    }
    if (url.pathname === '/api/semesters') {
      try {
        const semesters = await this.controller.listSemesters();
        this.sendJson(response, 200, { ok: true, data: semesters });
      } catch (error) {
        this.sendJson(response, 409, { ok: false, error: error.message });
      }
      return;
    }
    if (url.pathname === '/api/notifications') {
      let items = this.controller.notifications(100);
      if (items.length === 0) {
        const state = readJson(this.config.notificationOutboxFile, { items: [] });
        items = Array.isArray(state?.items) ? state.items.slice(-100).reverse().map(notificationView) : [];
      }
      this.sendJson(response, 200, { ok: true, data: items });
      return;
    }
    if (url.pathname === '/api/logs') {
      const limit = Math.min(500, Math.max(20, Number(url.searchParams.get('limit')) || 200));
      let lines = [];
      try { lines = fs.readFileSync(this.config.logFile, 'utf-8').split(/\r?\n/).filter(Boolean).slice(-limit); } catch {}
      this.sendJson(response, 200, { ok: true, data: lines });
      return;
    }
    if (url.pathname === '/api/settings') {
      this.sendJson(response, 200, { ok: true, data: publicSettings(this.env) });
      return;
    }
    this.sendJson(response, 404, { ok: false, error: '接口不存在' });
  }

  async handlePost(url, body, response) {
    if (url.pathname === '/api/actions/semester-grades') {
      const semesterId = String(body.semesterId || '').trim();
      if (!/^\d+$/.test(semesterId)) {
        this.sendJson(response, 400, { ok: false, error: '学期编号不正确' });
        return;
      }
      try {
        const grades = await this.controller.querySemesterGrades(semesterId);
        this.sendJson(response, 200, { ok: true, data: { semesterId, grades } });
      } catch (error) {
        this.sendJson(response, 409, { ok: false, error: error.message });
      }
      return;
    }
    const actions = {
      '/api/actions/start': () => this.controller.start(),
      '/api/actions/stop': () => this.controller.stop(),
      '/api/actions/restart': () => this.controller.restart(),
      '/api/actions/check': () => this.controller.checkNow(),
      '/api/actions/retry-notifications': () => this.controller.retryNotifications(),
      '/api/actions/weighted': () => this.controller.queryWeightedGrades(),
      '/api/actions/test-email': () => this.controller.sendTestEmail(),
      '/api/actions/elect-start': () => this._startElect(),
      '/api/actions/elect-stop': () => this._stopElect(),
    };
    if (actions[url.pathname]) {
      try {
        const data = await actions[url.pathname]();
        this.sendJson(response, 200, { ok: true, data });
      } catch (error) {
        this.sendJson(response, 409, { ok: false, error: error.message });
      }
      return;
    }
    if (url.pathname === '/api/settings') {
      const file = path.join(this.config.rootDir, 'eams.env');
      updateEnvFile(file, body.settings);
      const loaded = readEnvironment(this.config.rootDir, this.baseEnv);
      this.config = loaded.config;
      this.env = loaded.env;
      const setup = setupStatus(loaded.env);
      if (setup.complete) await this.controller.restart(loaded.config, loaded.env);
      else {
        await this.controller.stop();
        this.controller.setConfig(loaded.config, loaded.env);
      }
      this.sendJson(response, 200, {
        ok: true,
        data: { settings: publicSettings(this.env), setup, monitor: this.controller.snapshot() },
      });
      return;
    }
    this.sendJson(response, 404, { ok: false, error: '接口不存在' });
  }

  // ---------- 选课监控 ----------
  _startElect() {
    if (!this.electMonitor) {
      return { ok: false, error: '未配置 ELECT_TARGET_ID' };
    }
    if (this.electMonitor.running) return { ok: false, error: '选课监控已在运行' };
    this.electMonitor.start().catch(e => {
      this.log('ELECT', '启动失败: ' + e.message);
    });
    return { ok: true, data: { running: true } };
  }

  _stopElect() {
    if (!this.electMonitor) return { ok: false, error: '未配置 ELECT_TARGET_ID' };
    this.electMonitor.stop();
    return { ok: true, data: { running: false } };
  }

  async serveStatic(pathname, response) {
    if (pathname === '/favicon.ico') {
      response.statusCode = 204;
      response.end();
      return;
    }
    const routes = {
      '/': 'dashboard.html',
      '/index.html': 'dashboard.html',
      '/dashboard.html': 'dashboard.html',
      '/app.js': 'app.js',
      '/styles.css': 'styles.css',
    };
    const filename = routes[pathname];
    if (!filename) {
      response.statusCode = 404;
      response.end('Not Found');
      return;
    }
    const extension = path.extname(filename);
    const nonce = filename === 'dashboard.html' ? crypto.randomBytes(18).toString('base64') : '';
    this.commonHeaders(response, CONTENT_TYPES[extension], nonce);
    let content = fs.readFileSync(path.join(this.webDir, filename));
    if (filename === 'dashboard.html') {
      content = Buffer.from(content.toString('utf-8')
        .replaceAll('__DASHBOARD_TOKEN__', this.token)
        .replaceAll('__DASHBOARD_NONCE__', nonce));
    }
    response.statusCode = 200;
    response.end(content);
  }
}

module.exports = {
  DashboardServer,
  EDITABLE_KEYS,
  publicSettings,
  readEnvironment,
  setupStatus,
  updateEnvFile,
  validateSettings,
};
