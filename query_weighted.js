#!/usr/bin/env node
/**
 * 查加权成绩 — 查询总加权成绩
 *
 * 用法：node query_weighted.js [rootDir]
 */

const path = require('path');
const { loadConfig } = require('./lib/config');
const { HttpEamsClient } = require('./lib/http_eams_client');

async function main() {
  const rootDir = process.argv[2] || process.cwd();
  const cfg = loadConfig(rootDir);
  const client = new HttpEamsClient(cfg, { log: () => {} });
  await client.autoLogin();

  const data = await client.extractWeightedGrades();
  if (!data) { console.log('查询失败：会话可能已过期'); process.exit(1); }

  console.log('【总加权成绩】');
  if (data.summary && data.summary.length) {
    data.summary.forEach(s => console.log(s));
  }
  if (data.tableGrades && data.tableGrades.length) {
    console.log('---');
    data.tableGrades.forEach(row => console.log(row.join(' | ')));
  }
}

main().catch(e => { console.log('错误: ' + e.message); process.exit(1); });
