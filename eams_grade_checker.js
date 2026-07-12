#!/usr/bin/env node
/**
 * TJU EAMS 查成绩助手 — 常驻监控版
 *
 * 浏览器一直开着，每小时刷新成绩，仅发送有变化的科目
 *
 * 用法:
 *   node eams_grade_checker.js           # 手动登录，然后常驻监控
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const tls = require('tls');

// ── 配置 ──────────────────────────────────────────────
const CONFIG = {
  eamsEntry: 'https://classes.tju.edu.cn/eams/homeExt.action',
  gradeUrl: '/eams/teach/grade/course/person!historyCourseGrade.action?projectType=MAJOR',
  profileDir: path.join(__dirname, '.eams_profile'),
  lastGradesFile: path.join(__dirname, 'grades_latest.json'),
};
const CHECK_INTERVAL = 60 * 60 * 1000; // 1 小时

// ── 环境变量 ──────────────────────────────────────────
function loadEnv(filepath) {
  if (!fs.existsSync(filepath)) return;
  const lines = fs.readFileSync(filepath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnv(path.join(__dirname, 'eams.env'));

// ── 工具 ──────────────────────────────────────────────
function log(tag, msg) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[${ts} ${tag}] ${msg}`);
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

function now() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── EAMS 页面判断 ─────────────────────────────────────
async function isOnCasPage(page) { return page.url().includes('sso.tju.edu.cn'); }
async function isOnEamsPage(page) { return page.url().includes('classes.tju.edu.cn') && !page.url().includes('sso.tju.edu.cn'); }

// ── 登录 ──────────────────────────────────────────────
async function manualLogin(page) {
  console.log('\n========================================');
  console.log('  请在浏览器窗口中手动完成登录');
  console.log('  登录后脚本会自动接管');
  console.log('========================================\n');

  const username = process.env.EAMS_USERNAME || await ask('学号 (直接回车跳过) > ');
  const password = process.env.EAMS_PASSWORD || await ask('密码 (直接回车跳过) > ');

  if (username && password) {
    await page.waitForSelector('#un', { timeout: 60000 }).catch(() => {});
    if (await page.$('#un')) {
      await page.fill('#un', username);
      await page.fill('#pd', password);
      log('LOGIN', '已填写账号密码，请在浏览器输入验证码');
    }
  }

  for (let i = 0; i < 300; i++) {
    await page.waitForTimeout(1000);
    if (await isOnEamsPage(page)) {
      log('LOGIN', '登录成功!');
      return true;
    }
  }
  log('LOGIN', '等待超时');
  return false;
}

// ── 成绩提取 ──────────────────────────────────────────
async function extractGrades(page) {
  // 导航到成绩页
  await page.goto(`https://classes.tju.edu.cn${CONFIG.gradeUrl}`, {
    waitUntil: 'domcontentloaded', timeout: 30000,
  });
  await page.waitForTimeout(3000);

  // 等表格加载
  try { await page.waitForSelector('table', { timeout: 15000 }); } catch { return []; }

  // 找包含成绩数据的表格
  const tables = await page.$$('table');
  let grades = [];

  for (const table of tables) {
    const ths = await table.$$('th');
    if (ths.length < 2) continue;

    const headers = [];
    for (const th of ths) {
      headers.push((await th.textContent()).trim().replace(/\s+/g, ''));
    }

    const scoreIdx = headers.findIndex(h => h === '总评成绩' || h.includes('总评'));
    const nameIdx = headers.findIndex(h => h === '课程名称');
    if (scoreIdx < 0 || nameIdx < 0) continue;

    const rows = await table.$$('tr');
    for (const row of rows) {
      const cls = (await row.getAttribute('class')) || '';
      if (/title|head|info/i.test(cls)) continue;
      const cells = await row.$$('td');
      if (cells.length < headers.length) continue;

      const entry = {};
      for (let i = 0; i < headers.length; i++) {
        let text = (await cells[i].textContent()).trim().replace(/ /g, '').replace(/\s+/g, ' ').trim();
        if (i === scoreIdx && text && !isNaN(parseFloat(text))) {
          entry[headers[i]] = parseFloat(text);
        } else {
          entry[headers[i]] = text || '';
        }
      }
      if (entry[headers[nameIdx]] && entry[headers[scoreIdx]] !== '') {
        grades.push(entry);
      }
    }
  }

  log('EXTRACT', `共 ${grades.length} 门课程`);
  return grades;
}

// ── 成绩对比 ──────────────────────────────────────────
function diffGrades(oldGrades, newGrades) {
  const oldMap = new Map();
  for (const g of oldGrades) {
    const key = g['课程名称'] || g['课程代码'];
    oldMap.set(key, g['总评成绩']);
  }

  const changes = [];
  for (const g of newGrades) {
    const key = g['课程名称'] || g['课程代码'];
    const oldScore = oldMap.get(key);
    if (oldScore === undefined) {
      changes.push({ ...g, _change: 'new' });
    } else if (String(oldScore) !== String(g['总评成绩'])) {
      changes.push({ ...g, _change: 'updated', _oldScore: oldScore });
    }
    oldMap.delete(key);
  }
  // 被删除的课程（不太可能，但保留）
  for (const [key, score] of oldMap) {
    changes.push({ '课程名称': key, '总评成绩': score, _change: 'removed' });
  }

  return changes;
}

// ── 邮件发送 ──────────────────────────────────────────
function sendMail(subject, body) {
  return new Promise((resolve, reject) => {
    const smtpUser = process.env.QQ_EMAIL;
    const smtpPass = process.env.QQ_SMTP_CODE;
    const toEmail = process.env.NOTIFY_EMAIL || smtpUser;
    if (!smtpUser || !smtpPass) { log('MAIL', '未配置邮箱'); return resolve(false); }

    const raw = [
      `From: "EAMS查成绩" <${smtpUser}>`,
      `To: <${toEmail}>`,
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=UTF-8',
      '',
      body,
    ].join('\r\n');

    const socket = tls.connect({ host: 'smtp.qq.com', port: 465 }, () => {
      let step = 0;
      function send(cmd) { socket.write(cmd + '\r\n'); }
      socket.on('data', (d) => {
        const code = parseInt(d.toString().slice(0, 3));
        if (code >= 500) return reject(new Error(`SMTP ${code}`));
        switch (step) {
          case 0: step = 1; send('EHLO eams-checker'); break;
          case 1: step = 2; send('AUTH LOGIN'); break;
          case 2: step = 3; send(Buffer.from(smtpUser).toString('base64')); break;
          case 3: step = 4; send(Buffer.from(smtpPass).toString('base64')); break;
          case 4: step = 5; send(`MAIL FROM:<${smtpUser}>`); break;
          case 5: step = 6; send(`RCPT TO:<${toEmail}>`); break;
          case 6: step = 7; send('DATA'); break;
          case 7: step = 8; send(raw + '\r\n.'); break;
          case 8: send('QUIT'); log('MAIL', '发送成功'); resolve(true); break;
        }
      });
    });
    socket.on('error', reject);
    socket.setTimeout(30000, () => reject(new Error('SMTP 超时')));
  });
}

function buildUpdateEmail(changes, allGrades) {
  const rows = changes.map(g => {
    const name = g['课程名称'] || '-';
    const score = g['总评成绩'] !== undefined ? g['总评成绩'] : '-';
    let tag = '';
    if (g._change === 'new') tag = ' <span style="color:red">[新出]</span>';
    else if (g._change === 'updated') tag = ` <span style="color:orange">[${g._oldScore} → ${score}]</span>`;
    else if (g._change === 'removed') tag = ' <span style="color:gray">[移除]</span>';
    return `<tr><td style="padding:6px 12px;border-bottom:1px solid #eee">${name}${tag}</td><td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:center;font-weight:bold">${score}</td></tr>`;
  }).join('');

  return `
<h2>EAMS 成绩更新 — ${now()}</h2>
<p>本次更新 <strong>${changes.length}</strong> 门课程 | 共 ${allGrades.length} 门</p>
<table style="border-collapse:collapse;min-width:320px">
  <thead><tr style="background:#f5f5f5">
    <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #ddd">课程</th>
    <th style="padding:8px 12px;text-align:center;border-bottom:2px solid #ddd">成绩</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>
<p style="color:#999;font-size:12px;margin-top:20px">由 EAMS 查成绩助手自动发送</p>`;
}

function buildNoUpdateEmail(allGrades) {
  return `
<h2>EAMS 成绩 — ${now()}</h2>
<p>本次无更新，共 <strong>${allGrades.length}</strong> 门课程</p>
<p style="color:#999;font-size:12px;margin-top:20px">由 EAMS 查成绩助手自动发送</p>`;
}

// ── 主流程 ────────────────────────────────────────────
async function main() {
  log('INIT', '启动浏览器 (Edge)...');
  const context = await chromium.launchPersistentContext(CONFIG.profileDir, {
    headless: false,
    channel: 'msedge',
    args: ['--start-maximized'],
  });

  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();

  // ── 登录 ──
  log('INIT', '访问 EAMS...');
  await page.goto(CONFIG.eamsEntry, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);

  if (await isOnCasPage(page)) {
    const ok = await manualLogin(page);
    if (!ok) { log('FAIL', '登录失败'); await context.close(); process.exit(1); }
  } else if (await isOnEamsPage(page)) {
    log('INIT', '会话有效，跳过登录');
  }

  // ── 首次抓取 ──
  log('INIT', '首次抓取成绩...');
  let lastGrades = await extractGrades(page);
  if (lastGrades.length === 0) {
    log('FAIL', '未抓到成绩，退出');
    await context.close();
    process.exit(1);
  }

  // 保存初始快照
  fs.writeFileSync(CONFIG.lastGradesFile, JSON.stringify(lastGrades, null, 2), 'utf-8');
  log('INIT', `初始快照: ${lastGrades.length} 门课程`);

  // 首次总是发送完整成绩
  const firstBody = buildUpdateEmail(
    lastGrades.map(g => ({ ...g, _change: 'new' })),
    lastGrades,
  );
  try {
    await sendMail('出分啦！', firstBody);
    log('INIT', '首次成绩报告已发送');
  } catch (err) {
    log('INIT', `首次邮件发送失败: ${err.message}`);
  }

  // ── 常驻监控 ──
  console.log(`\n${'='.repeat(50)}`);
  console.log(`  监控已启动，每 ${CHECK_INTERVAL / 3600000} 小时检查一次`);
  console.log(`  浏览器不要关！`);
  console.log(`${'='.repeat(50)}\n`);

  async function check() {
    const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    log('CHECK', `--- ${ts} 开始检查 ---`);

    try {
      // 刷新成绩页
      const freshGrades = await extractGrades(page);

      if (freshGrades.length === 0) {
        log('CHECK', '提取失败，跳过本轮');
        return;
      }

      // 对比
      const changes = diffGrades(lastGrades, freshGrades);

      if (changes.length > 0) {
        log('CHECK', `发现 ${changes.length} 门课程有变化`);
        const body = buildUpdateEmail(changes, freshGrades);
        await sendMail('出分啦！', body);
        lastGrades = freshGrades;
        fs.writeFileSync(CONFIG.lastGradesFile, JSON.stringify(lastGrades, null, 2), 'utf-8');
      } else {
        log('CHECK', '无变化');
        const body = buildNoUpdateEmail(freshGrades);
        await sendMail('请无视此邮件', body);
      }
    } catch (err) {
      log('CHECK', `检查出错: ${err.message}`);
      // 可能会话过期
      if (await isOnCasPage(page)) {
        log('CHECK', '会话过期！需要重新登录。浏览器保持打开，请手动登录');
        log('CHECK', '登录后脚本会自动恢复');
        // 等待用户重新登录
        for (let i = 0; i < 600; i++) {
          await page.waitForTimeout(1000);
          if (await isOnEamsPage(page)) {
            log('CHECK', '检测到登录成功，恢复监控');
            return check(); // 重试
          }
        }
      }
    }
  }

  // 立即设好定时器
  setInterval(check, CHECK_INTERVAL);

  // 保持运行
  process.on('SIGINT', async () => {
    log('EXIT', '正在关闭...');
    await context.close();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
