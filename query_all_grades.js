#!/usr/bin/env node
/**
 * 查所有成绩 — 查询所有学期成绩
 *
 * 用法：node query_all_grades.js [rootDir]
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
  if (!semesters || !semesters.length) { console.log('获取学期列表失败'); process.exit(1); }

  console.log('【所有学期】');
  semesters.sort((a, b) => Number(b.id) - Number(a.id)).forEach(s => {
    console.log(`${s.id}: ${s.label}`);
  });
  console.log('---');

  const recent = semesters.sort((a, b) => Number(b.id) - Number(a.id)).slice(0, 3);
  for (const sem of recent) {
    console.log(`\n【${sem.label}】`);
    const grades = await client.extractGrades({ semesterId: Number(sem.id) });
    if (grades && grades.length) {
      grades.forEach(g => {
        console.log(`${g['课程名称'] || '?'} | ${g['总评成绩'] || '?'} | 学分:${g['学分'] || '?'}`);
      });
    } else {
      console.log('无成绩');
    }
  }
}

main().catch(e => { console.log('错误: ' + e.message); process.exit(1); });
