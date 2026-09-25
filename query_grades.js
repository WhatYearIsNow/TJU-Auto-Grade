#!/usr/bin/env node
/**
 * 查成绩 — 查询当前学期成绩
 *
 * 用法：node query_grades.js [rootDir]
 *
 * 字段映射（EAMS 中文 → 脚本输出）：
 *   课程名称 → name
 *   总评成绩 → score
 *   学分 → credit
 *   绩点 → gpa
 */

const path = require('path');
const { loadConfig } = require('./lib/config');
const { HttpEamsClient } = require('./lib/http_eams_client');

async function main() {
  const rootDir = process.argv[2] || process.cwd();
  const cfg = loadConfig(rootDir);
  const client = new HttpEamsClient(cfg, { log: () => {} });
  await client.autoLogin();

  const semesters = await client.listSemesters();
  if (!semesters || !semesters.length) { console.log('未能获取学期列表'); process.exit(1); }

  const current = semesters.sort((a, b) => Number(b.id) - Number(a.id))[0];
  console.log(`【${current.label}】`);

  const grades = await client.extractGrades({ semesterId: Number(current.id) });
  if (!grades || !grades.length) { console.log('无成绩'); process.exit(0); }

  grades.forEach(g => {
    console.log(`${g['课程名称'] || '?'} | ${g['总评成绩'] || '?'} | 学分:${g['学分'] || '?'} | 绩点:${g['绩点'] || '?'}`);
  });
}

main().catch(e => { console.log('错误: ' + e.message); process.exit(1); });
