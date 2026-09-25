const fs = require('fs');
const path = require('path');

function parseEnv(content) {
  const values = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function loadEnv(file, target = process.env) {
  if (!fs.existsSync(file)) return {};
  const values = parseEnv(fs.readFileSync(file, 'utf-8'));
  for (const [key, value] of Object.entries(values)) {
    if (target[key] === undefined || target[key] === '') target[key] = value;
  }
  return values;
}

function envNumber(env, name, fallback, min, max) {
  const value = Number(env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function envBoolean(env, name, fallback = false) {
  const value = env[name];
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function createConfig(rootDir, env = process.env) {
  const resolvedRoot = path.resolve(rootDir);
  const seconds = (name, fallback, min, max) =>
    envNumber(env, name, fallback, min, max) * 1000;
  const minutes = (name, fallback, min, max) =>
    envNumber(env, name, fallback, min, max) * 60 * 1000;

  return Object.freeze({
    rootDir: resolvedRoot,
    eamsEntry: env.EAMS_ENTRY_URL || 'https://classes.tju.edu.cn/eams/homeExt.action',
    gradeUrl: env.EAMS_GRADE_URL || '/eams/teach/grade/course/person!search.action?projectType=',
    weightedGradeUrl: env.EAMS_WEIGHTED_GRADE_URL ||
      'https://classes.tju.edu.cn/eams/teach/grade/course/person!historyCourseGrade.action?projectType=MAJOR',
    profileDir: path.join(resolvedRoot, 'data', '.eams_profile'),
    lastGradesFile: path.join(resolvedRoot, 'data', 'grades_latest.json'),
    logFile: path.join(resolvedRoot, 'data', 'eams_monitor.log'),
    historyFile: path.join(resolvedRoot, 'data', 'history.log'),
    pidFile: path.join(resolvedRoot, 'data', '.eams_pid'),
    heartbeatFile: path.join(resolvedRoot, 'data', '.eams_heartbeat'),
    monitorPidFile: path.join(resolvedRoot, 'data', '.eams_monitor_pid'),
    monitorHeartbeatFile: path.join(resolvedRoot, 'data', '.eams_monitor_heartbeat'),
    lastUidFile: path.join(resolvedRoot, 'data', '.imap_last_uid'),
    notificationOutboxFile: path.join(resolvedRoot, 'data', 'notification_outbox.json'),
    dashboardScript: path.join(resolvedRoot, 'bin', 'dashboard.js'),
    monitorScript: path.join(resolvedRoot, 'bin', 'monitor.js'),
    mainScript: path.join(resolvedRoot, 'bin', 'dashboard.js'),
    dashboardPort: envNumber(env, 'DASHBOARD_PORT', 3765, 1024, 65535),
    dashboardAutoOpen: envBoolean(env, 'DASHBOARD_AUTO_OPEN', true),
    browserChannel: env.BROWSER_CHANNEL || 'msedge',
    headless: envBoolean(env, 'HEADLESS', false),
    // 传输层：http = 纯 Node fetch 直连（不启动浏览器，~60MB 常驻）；browser = Playwright 启动 Chromium
    transport: (env.EAMS_TRANSPORT || 'http').toLowerCase() === 'browser' ? 'browser' : 'http',
    // 验证码识别：tesseract=本地 WASM OCR（默认，无需 Key）；dashscope=千问视觉（需 DASHSCOPE_API_KEY）
    captchaProvider: env.CAPTCHA_PROVIDER === 'dashscope' ? 'dashscope' : 'tesseract',
    casCodeUrl: env.CAS_CODE_URL || 'https://sso.tju.edu.cn/cas/code',
    // tju-auth 共享登录服务（可选）：设置后登录/续期统一由该服务提供
    authServiceUrl: (env.AUTH_SERVICE_URL || '').replace(/\/$/, ''),
    authToken: env.AUTH_SERVICE_TOKEN || '',
    tessdataDir: path.join(resolvedRoot, env.TESSDATA_DIR || 'tessdata'),
    captchaScale: envNumber(env, 'CAPTCHA_SCALE', 2, 1, 6),
    captchaThreshold: envNumber(env, 'CAPTCHA_BINARIZE_THRESHOLD', 80, 0, 765),
    captchaPreprocess: env.CAPTCHA_PREPROCESS === 'bin' ? 'bin' : 'gray',
    captchaWhitelist: env.CAPTCHA_CHAR_WHITELIST ||
      '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
    checkIntervalMs: minutes('CHECK_INTERVAL_MINUTES', 5, 1, 1440),
    imapIntervalMs: seconds('IMAP_INTERVAL_SECONDS', 60, 15, 3600),
    imapSocketTimeoutMs: seconds('IMAP_SOCKET_TIMEOUT_SECONDS', 600, 60, 1800),
    reloginTimeoutMs: minutes('RELOGIN_TIMEOUT_MINUTES', 10, 1, 120),
    imapVerbose: envBoolean(env, 'IMAP_VERBOSE', false),
    imapEnabled: envBoolean(env, 'IMAP_ENABLED', true),
    outboxPollIntervalMs: seconds('OUTBOX_POLL_INTERVAL_SECONDS', 30, 10, 3600),
    outboxRetryBaseMs: seconds('OUTBOX_RETRY_BASE_SECONDS', 60, 10, 3600),
    outboxRetryMaxMs: seconds('OUTBOX_RETRY_MAX_SECONDS', 3600, 60, 86400),
    outboxRetentionMs: envNumber(env, 'OUTBOX_RETENTION_DAYS', 30, 1, 365) * 24 * 60 * 60 * 1000,
    watchdogIntervalMs: minutes('WATCHDOG_INTERVAL_MINUTES', 5, 1, 1440),
    watchdogHeartbeatMaxAgeMs: minutes('WATCHDOG_HEARTBEAT_MAX_AGE_MINUTES', 3, 1, 1440),
    watchdogAutoRestart: envBoolean(env, 'WATCHDOG_AUTO_RESTART', true),
    heartbeatIntervalMs: seconds('HEARTBEAT_INTERVAL_SECONDS', 30, 10, 300),
    smtp: Object.freeze({
      host: env.SMTP_HOST || 'smtp.qq.com',
      port: envNumber(env, 'SMTP_PORT', 465, 1, 65535),
      secure: envBoolean(env, 'SMTP_SECURE', true),
      user: env.SMTP_USER || env.QQ_EMAIL || '',
      pass: env.SMTP_PASS || env.QQ_SMTP_CODE || '',
      to: env.NOTIFY_EMAIL || env.SMTP_USER || env.QQ_EMAIL || '',
    }),
    // NapCat QQ 通知通道（可选辅助）
    napcatUrl: env.NAPCAT_URL || 'http://127.0.0.1:3002/send_private_msg',
    napcatToken: env.NAPCAT_TOKEN || '',
    qqTargetUser: env.QQ_TARGET_USER || '',
    // 选课监控（通用化 elect_loop）
    electTargetId: env.ELECT_TARGET_ID || '',
    electTargetName: env.ELECT_TARGET_NAME || '',
    electTargetTeacher: env.ELECT_TARGET_TEACHER || '',
    electTargetTime: env.ELECT_TARGET_TIME || '',
    electIntervalMs: envNumber(env, 'ELECT_INTERVAL_MINUTES', 1, 1, 60) * 60 * 1000,
    loginTimeoutMs: envNumber(env, 'LOGIN_TIMEOUT_MINUTES', 2, 1, 10) * 60 * 1000,
    imap: Object.freeze({
      host: env.IMAP_HOST || 'imap.qq.com',
      port: envNumber(env, 'IMAP_PORT', 993, 1, 65535),
      user: env.IMAP_USER || env.QQ_EMAIL || '',
      pass: env.IMAP_PASS || env.QQ_SMTP_CODE || '',
      commandEmail: (env.COMMAND_EMAIL || env.NOTIFY_EMAIL || env.IMAP_USER || env.QQ_EMAIL || '').trim().toLowerCase(),
      commandToken: env.COMMAND_TOKEN || '',
    }),
  });
}

function loadConfig(rootDir, env = process.env) {
  loadEnv(path.join(rootDir, 'eams.env'), env);
  return createConfig(rootDir, env);
}

module.exports = {
  createConfig,
  envBoolean,
  envNumber,
  loadConfig,
  loadEnv,
  parseEnv,
};
