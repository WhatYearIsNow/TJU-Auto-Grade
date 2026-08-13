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
    gradeUrl: env.EAMS_GRADE_URL || '/eams/teach/grade/course/person!search.action?semesterId=117&projectType=',
    weightedGradeUrl: env.EAMS_WEIGHTED_GRADE_URL ||
      'https://classes.tju.edu.cn/eams/teach/grade/course/person!historyCourseGrade.action?projectType=MAJOR',
    profileDir: path.join(resolvedRoot, '.eams_profile'),
    lastGradesFile: path.join(resolvedRoot, 'grades_latest.json'),
    logFile: path.join(resolvedRoot, 'eams_monitor.log'),
    pidFile: path.join(resolvedRoot, '.eams_pid'),
    heartbeatFile: path.join(resolvedRoot, '.eams_heartbeat'),
    lastUidFile: path.join(resolvedRoot, '.imap_last_uid'),
    notificationOutboxFile: path.join(resolvedRoot, 'notification_outbox.json'),
    dashboardScript: path.join(resolvedRoot, 'dashboard.js'),
    monitorScript: path.join(resolvedRoot, 'eams_grade_checker_v2.js'),
    mainScript: path.join(resolvedRoot, 'dashboard.js'),
    dashboardPort: envNumber(env, 'DASHBOARD_PORT', 3765, 1024, 65535),
    dashboardAutoOpen: envBoolean(env, 'DASHBOARD_AUTO_OPEN', true),
    browserChannel: env.BROWSER_CHANNEL || 'msedge',
    headless: envBoolean(env, 'HEADLESS', false),
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
