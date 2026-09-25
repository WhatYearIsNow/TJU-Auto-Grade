#!/usr/bin/env node
/**
 * 配置自检 — 启动前检查常见配置陷阱
 *
 * 用法：node scripts/doctor.js [rootDir]
 * 退出码：0 = 全部通过，1 = 有警告或错误
 */

const fs = require('fs');
const path = require('path');
const { createConfig, loadEnv } = require('../lib/config');

function check(rootDir) {
  const resolvedRoot = path.resolve(rootDir);
  const env = {};
  loadEnv(path.join(resolvedRoot, 'eams.env'), env);
  const config = createConfig(resolvedRoot, env);

  const errors = [];
  const warnings = [];

  // 1. 教务账号
  if (!env.EAMS_USERNAME) errors.push('EAMS_USERNAME 未配置');
  if (!env.EAMS_PASSWORD) errors.push('EAMS_PASSWORD 未配置');

  // 2. 通知通道
  const hasSmtp = env.QQ_EMAIL && env.QQ_SMTP_CODE;
  if (!hasSmtp) warnings.push('QQ_EMAIL / QQ_SMTP_CODE 未配置，邮件通知不可用');

  // 3. COMMAND_EMAIL 陷阱（P1-18）
  if (env.COMMAND_EMAIL && env.NOTIFY_EMAIL && env.COMMAND_EMAIL !== env.NOTIFY_EMAIL) {
    warnings.push('COMMAND_EMAIL 与 NOTIFY_EMAIL 不同，IMAP 登录的是 QQ_EMAIL 而非 COMMAND_EMAIL');
  }

  // 4. 传输层
  if (env.EAMS_TRANSPORT === 'browser') {
    if (!fs.existsSync(path.join(resolvedRoot, 'node_modules', 'playwright'))) {
      errors.push('EAMS_TRANSPORT=browser 但 playwright 未安装');
    }
  }

  // 5. 验证码
  if (env.CAPTTCHA_PROVIDER === 'dashscope' && !env.DASHSCOPE_API_KEY) {
    errors.push('CAPTCHA_PROVIDER=dashscope 但 DASHSCOPE_API_KEY 未配置');
  }

  // 6. 选课监控
  if (env.ELECT_TARGET_ID && !env.ELECT_TARGET_NAME) {
    warnings.push('ELECT_TARGET_ID 已配置但 ELECT_TARGET_NAME 未设置');
  }

  // 7. 凭据文件
  const bakFiles = [
    'eams.env.bak-20260921',
    'eams.env.bak-tju-auth',
  ];
  for (const bak of bakFiles) {
    const bakPath = path.join(resolvedRoot, bak);
    if (fs.existsSync(bakPath)) {
      warnings.push(`存在凭据备份文件 ${bak}，建议清理`);
    }
  }

  // 8. eams.env 是否存在
  const envPath = path.join(resolvedRoot, 'eams.env');
  if (!fs.existsSync(envPath)) {
    warnings.push('eams.env 不存在，将使用默认配置');
  }

  return { errors, warnings };
}

function main() {
  const rootDir = process.argv[2] || process.cwd();
  console.log(`\n=== TJU-Auto-Grade 配置自检 ===`);
  console.log(`根目录: ${path.resolve(rootDir)}\n`);

  const result = check(rootDir);

  if (result.errors.length > 0) {
    console.log('❌ 错误:');
    for (const e of result.errors) console.log(`   - ${e}`);
    console.log();
  }

  if (result.warnings.length > 0) {
    console.log('⚠️  警告:');
    for (const w of result.warnings) console.log(`   - ${w}`);
    console.log();
  }

  if (result.errors.length === 0 && result.warnings.length === 0) {
    console.log('✅ 所有检查通过');
  } else if (result.errors.length === 0) {
    console.log(`结果: ${result.warnings.length} 个警告`);
  } else {
    console.log(`结果: ${result.errors.length} 个错误, ${result.warnings.length} 个警告`);
  }

  process.exit(result.errors.length > 0 ? 1 : 0);
}

if (require.main === module) {
  main();
}

module.exports = { check };
