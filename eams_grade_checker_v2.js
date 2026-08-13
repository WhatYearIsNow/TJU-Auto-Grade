#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { loadConfig } = require('./lib/config');
const { EamsClient, isFatalBrowserError, parseGradeTables } = require('./lib/eams');
const {
  decodeQP,
  decodeRFC2047,
  extractReplyText,
  extractTextBody,
  parseCommand,
} = require('./lib/email_commands');
const {
  createGradeNotification,
  diffGrades,
  gradeKey,
} = require('./lib/grades');
const { Mailer } = require('./lib/mailer');
const { GradeMonitor } = require('./lib/monitor');

async function verifyRuntime(rootDir = __dirname, env = process.env) {
  const config = loadConfig(rootDir, env);
  const checks = [];
  const majorNodeVersion = Number(process.versions.node.split('.')[0]);
  checks.push({ name: `Node.js ${process.versions.node}`, ok: majorNodeVersion >= 22 });
  checks.push({ name: 'Playwright 模块', ok: Boolean(chromium) });
  checks.push({ name: '主程序模块', ok: typeof GradeMonitor === 'function' });
  checks.push({ name: 'eams.env', ok: fs.existsSync(path.join(rootDir, 'eams.env')), optional: true });

  const mailer = new Mailer(config.smtp);
  const mailProblems = mailer.validate();
  checks.push({
    name: mailProblems.length === 0 ? '邮件配置' : `邮件配置（${mailProblems.join('；')}）`,
    ok: mailProblems.length === 0,
    optional: true,
  });

  let browser;
  try {
    const launchOptions = { headless: true };
    if (config.browserChannel !== 'chromium') launchOptions.channel = config.browserChannel;
    browser = await chromium.launch(launchOptions);
    checks.push({ name: `浏览器 ${config.browserChannel}`, ok: true });
  } catch (error) {
    checks.push({ name: `浏览器 ${config.browserChannel}（${error.message.split(/\r?\n/)[0]}）`, ok: false });
  } finally {
    try { await browser?.close(); } catch {}
  }

  return {
    ok: checks.every(check => check.ok || check.optional),
    checks,
    config,
  };
}

async function printVerification() {
  const result = await verifyRuntime();
  for (const check of result.checks) {
    const prefix = check.ok ? '[OK]' : check.optional ? '[WARN]' : '[FAIL]';
    console.log(`${prefix} ${check.name}`);
  }
  if (!result.ok) process.exitCode = 1;
  return result;
}

async function main() {
  const config = loadConfig(__dirname);
  const monitor = new GradeMonitor(config, { processScript: config.monitorScript });
  await monitor.start();
  return monitor;
}

if (require.main === module) {
  const action = process.argv[2];
  const task = action === '--verify' ? printVerification() : main();
  task.catch(error => {
    console.error('[FATAL]', error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  EamsClient,
  GradeMonitor,
  createGradeNotification,
  decodeQP,
  decodeRFC2047,
  diffGrades,
  extractReplyText,
  extractTextBody,
  gradeKey,
  isFatalBrowserError,
  main,
  parseCommand,
  parseGradeTables,
  verifyRuntime,
};
