#!/usr/bin/env node
/**
 * TJU EAMS 查成绩助手 — 常驻监控版
 * 浏览器一直开着，定时刷新成绩，仅发送有变化的科目
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const tls = require('tls');

// ── 配置 ──────────────────────────────────────────────
const CONFIG = {
  eamsEntry: 'https://classes.tju.edu.cn/eams/homeExt.action',
  gradeUrl: '/eams/teach/grade/course/person!search.action?semesterId=117&projectType=',
  profileDir: path.join(__dirname, '.eams_profile'),
  lastGradesFile: path.join(__dirname, 'grades_latest.json'),
  logFile: path.join(__dirname, 'eams_monitor.log'),
  pidFile: path.join(__dirname, '.eams_pid'),
};
const CHECK_INTERVAL = 15 * 60 * 1000; // 15 分钟

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
  const line = `[${ts} ${tag}] ${msg}`;
  console.log(line);
  // 写入日志并保持最多 500 行
  try {
    fs.appendFileSync(CONFIG.logFile, line + '\n', 'utf-8');
    const all = fs.readFileSync(CONFIG.logFile, 'utf-8').split('\n').filter(Boolean);
    if (all.length > 500) {
      fs.writeFileSync(CONFIG.logFile, all.slice(-500).join('\n') + '\n', 'utf-8');
    }
  } catch {}
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

function now() {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}

// ── EAMS 页面判断 ─────────────────────────────────────
async function isOnCasPage(page) { return page.url().includes('sso.tju.edu.cn'); }
async function isOnEamsPage(page) { return page.url().includes('classes.tju.edu.cn') && !page.url().includes('sso.tju.edu.cn'); }

// ── 登录 ──────────────────────────────────────────────
async function autoLogin(page) {
  const username = process.env.EAMS_USERNAME;
  const password = process.env.EAMS_PASSWORD;
  if (!username || !password) return false;

  const { execFile } = require('child_process');
  const captchaPath = path.join(__dirname, '.captcha_tmp.png');

  for (let attempt = 1; attempt <= 3; attempt++) {
    log('LOGIN', `AI 自动登录 第 ${attempt}/3 次...`);

    try { await page.waitForSelector('#codeImage', { timeout: 10000 }); } catch { continue; }
    await page.waitForTimeout(500);

    const captchaEl = await page.$('#codeImage');
    if (!captchaEl) continue;
    await captchaEl.screenshot({ path: captchaPath });

    let code = null;
    try {
      code = await new Promise((resolve, reject) => {
        execFile('node', [path.join(__dirname, 'vision.js'), captchaPath,
          '只返回验证码字符，不要任何解释'], { timeout: 15000 },
          (err, stdout) => {
            if (err) return reject(err);
            const m = (stdout || '').trim().match(/[a-zA-Z0-9]{4,6}/);
            resolve(m ? m[0] : null);
          });
      });
    } catch (err) {
      log('LOGIN', `AI 识别失败: ${err.message}`);
      try { fs.unlinkSync(captchaPath); } catch {}
      continue;
    }
    try { fs.unlinkSync(captchaPath); } catch {}

    if (!code) { log('LOGIN', '识别结果为空，重试'); continue; }
    log('LOGIN', `验证码: ${code}`);

    await page.fill('#un', username);
    await page.fill('#pd', password);
    await page.fill('#code', code);
    await page.waitForTimeout(300);
    await page.press('#code', 'Enter');

    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(1000);
      if (await isOnEamsPage(page)) { log('LOGIN', 'AI 登录成功!'); return true; }
    }

    const errText = await page.evaluate(() => {
      const el = document.querySelector('#loginErrorMessage, .error, .msg, .alert-error, [class*="error"]');
      return el ? el.textContent.trim() : null;
    });
    log('LOGIN', `失败: ${errText || '验证码错误'}`);

    try { await page.click('#a_changeCode'); await page.waitForTimeout(800); } catch {}
  }

  return false;
}

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
      log('LOGIN', '已填写账号密码');
      await ask('请在浏览器中输完验证码后，回终端按回车继续...');
      try {
        await page.locator('button[type="submit"], input[type="submit"]').first().click({ timeout: 5000 });
        log('LOGIN', '已点击登录按钮');
      } catch {
        log('LOGIN', '未找到登录按钮，请手动点击');
      }
    }
  } else {
    log('LOGIN', '请在浏览器中自行登录');
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
async function retry(fn, times, label) {
  for (let i = 0; i < times; i++) {
    try { return await fn(); } catch (e) {
      if (i < times - 1) {
        const delay = (i + 1) * 2000;
        log('RETRY', `${label} 第${i + 1}次失败，${delay / 1000}s后重试...`);
        await new Promise(r => setTimeout(r, delay));
      } else throw e;
    }
  }
}

async function extractGrades(page) {
  await retry(() => page.goto(`https://classes.tju.edu.cn${CONFIG.gradeUrl}`, {
    waitUntil: 'domcontentloaded', timeout: 30000,
  }), 3, '页面加载');
  await page.waitForTimeout(2000);

  // 勾选 "All学期成绩" 确保抓全所有学期
  try {
    const allCheckbox = page.locator('input[type="checkbox"]').first();
    if (await allCheckbox.count() > 0) {
      const checked = await allCheckbox.isChecked();
      if (!checked) { await allCheckbox.check(); await page.waitForTimeout(2000); }
    }
  } catch {}

  try { await page.waitForSelector('table', { timeout: 15000 }); } catch { return []; }

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
      `From: "tju-auto-grade" <${smtpUser}>`,
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

function buildSubject(change) {
  const name = change['课程名称'] || '未知课程';
  const gpa = change['绩点'];
  if (gpa === 4 || gpa === '4') return `出分啦！来自${name}的好消息哦！`;
  return `请查看${name}的成绩`;
}

function buildUpdateEmail(changes, allGrades) {
  const fmtScore = (v) => v !== undefined && v !== '' ? v : '-';

  const rows = changes.map(g => {
    const name = g['课程名称'] || '-';
    const score = fmtScore(g['总评成绩']);
    const credit = fmtScore(g['学分']);
    const gpa = fmtScore(g['绩点']);
    const semester = g['学年学期'] || '';
    const category = g['课程性质'] || g['课程类别'] || '';

    let tag = '';
    if (g._change === 'new') tag = ' <span style="color:red;font-size:12px">NEW</span>';
    else if (g._change === 'updated') tag = ` <span style="color:orange;font-size:12px">${g._oldScore}→${score}</span>`;
    else if (g._change === 'removed') tag = ' <span style="color:gray;font-size:12px">已移除</span>';

    // 平时/期末/实验成绩明细
    const daily = fmtScore(g['平时成绩']);
    const dailyPct = g['平时成绩占比'] || '';
    const final = fmtScore(g['期末成绩']);
    const finalPct = g['期末成绩占比'] || '';
    const lab = fmtScore(g['实验成绩']);
    const labPct = g['实验成绩占比'] || '';

    let detail = '';
    if (daily !== '-' || final !== '-' || lab !== '-') {
      const parts = [];
      if (daily !== '-') parts.push(`平时: ${daily}(${dailyPct})`);
      if (lab !== '-') parts.push(`实验: ${lab}(${labPct})`);
      if (final !== '-') parts.push(`期末: ${final}(${finalPct})`);
      detail = `<br><span style="font-size:11px;color:#888">${parts.join(' | ')}</span>`;
    }

    return `<tr>
      <td style="padding:5px 8px;border-bottom:1px solid #eee">${name}${tag}${detail}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #eee;text-align:center">${semester}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #eee;text-align:center">${credit}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #eee;text-align:center;font-weight:bold">${score}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #eee;text-align:center">${gpa}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #eee;font-size:12px;color:#666">${category}</td>
    </tr>`;
  }).join('');

  return `
<span style="display:none;font-size:1px;max-height:0;overflow:hidden;color:#fff">成绩已更新，请打开邮件或登录EAMS查看详情。</span>
<p>【${now()}】成绩详情请打开邮件查看</p>
<br><br><br><br><br>
<hr style="border:1px dashed #ddd;margin:20px 0">
<table style="border-collapse:collapse;min-width:600px;font-size:14px">
  <thead><tr style="background:#f0f4ff">
    <th style="padding:8px;text-align:left;border-bottom:2px solid #ccd">课程</th>
    <th style="padding:8px;text-align:center;border-bottom:2px solid #ccd">学期</th>
    <th style="padding:8px;text-align:center;border-bottom:2px solid #ccd">学分</th>
    <th style="padding:8px;text-align:center;border-bottom:2px solid #ccd">成绩</th>
    <th style="padding:8px;text-align:center;border-bottom:2px solid #ccd">绩点</th>
    <th style="padding:8px;text-align:center;border-bottom:2px solid #ccd">性质</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>
<p style="color:#999;font-size:12px;margin-top:20px">由 tju-auto-grade 自动发送</p>`;
}

// ── 主流程 ────────────────────────────────────────────
async function main() {
  log('INIT', '=== 查成绩助手启动 ===');
  fs.writeFileSync(CONFIG.pidFile, String(process.pid), 'utf-8');
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
    log('INIT', '尝试 AI 自动登录...');
    let ok = await autoLogin(page);
    if (!ok) {
      log('INIT', 'AI 登录失败，切换到手动登录');
      ok = await manualLogin(page);
    }
    if (!ok) { log('FAIL', '登录失败'); await context.close(); process.exit(1); }
  } else if (await isOnEamsPage(page)) {
    log('INIT', '会话有效，跳过登录');
  }

  // ── 首次抓取 ──
  log('INIT', '首次抓取成绩...');
  let lastGrades = await extractGrades(page);
  if (lastGrades.length === 0) {
    log('FAIL', '未抓到成绩，退出');
    try { fs.unlinkSync(CONFIG.pidFile); } catch {}
    await context.close();
    process.exit(1);
  }

  fs.writeFileSync(CONFIG.lastGradesFile, JSON.stringify(lastGrades, null, 2), 'utf-8');
  log('INIT', `初始快照: ${lastGrades.length} 门课程`);

  const firstBody = buildUpdateEmail(
    lastGrades.map(g => ({ ...g, _change: 'new' })),
    lastGrades,
  );
  try {
    await sendMail('监控已启动', firstBody);
    log('INIT', '测试邮件已发送');
  } catch (err) {
    log('INIT', `测试邮件失败: ${err.message}`);
  }

  // ── 常驻监控 ──
  const intervalH = CHECK_INTERVAL / 3600000;
  console.log(`\n${'='.repeat(50)}`);
  console.log(`  监控已启动，每 ${intervalH} 小时检查一次`);
  console.log(`  浏览器不要关 | 日志: ${CONFIG.logFile}`);
  console.log(`${'='.repeat(50)}\n`);

  let failCount = 0;
  let timer = null;

  async function check() {
    const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    log('CHECK', `--- ${ts} 开始检查 ---`);

    try {
      const freshGrades = await extractGrades(page);

      if (freshGrades.length === 0) {
        failCount++;
        log('CHECK', `提取失败 (连续 ${failCount} 次)`);
        if (failCount >= 3) {
          try {
            await sendMail('EAMS 监控异常',
              `<p>【${now()}】连续 ${failCount} 次提取失败，请检查浏览器窗口。</p>`);
          } catch {}
        }
        scheduleNext();
        return;
      }

      failCount = 0;

      const changes = diffGrades(lastGrades, freshGrades);

      if (changes.length > 0) {
        log('CHECK', `发现 ${changes.length} 门课程有变化`);
        for (const g of changes) {
          const body = buildUpdateEmail([g], freshGrades);
          await sendMail(buildSubject(g), body);
        }
        lastGrades = freshGrades;
        fs.writeFileSync(CONFIG.lastGradesFile, JSON.stringify(lastGrades, null, 2), 'utf-8');
      } else {
        log('CHECK', '无变化');
      }
    } catch (err) {
      failCount++;
      log('CHECK', `异常: ${err.message} (连续 ${failCount} 次)`);
      if (failCount >= 3) {
        try {
          await sendMail('EAMS 监控异常',
            `<p>【${now()}】连续 ${failCount} 次异常: ${err.message}</p>`);
        } catch {}
      }
      if (await isOnCasPage(page)) {
        log('CHECK', '会话过期，等待重新登录 (最多 10 分钟)...');
        for (let i = 0; i < 600; i++) {
          await page.waitForTimeout(1000);
          if (await isOnEamsPage(page)) {
            log('CHECK', '登录成功，恢复监控');
            failCount = 0;
            scheduleNext();
            return check();
          }
        }
        log('CHECK', '等待超时，下次继续尝试');
      }
    }

    scheduleNext();
  }

  function scheduleNext() {
    timer = setTimeout(check, CHECK_INTERVAL);
  }

  scheduleNext();

  async function shutdown() {
    log('EXIT', '正在关闭...');
    clearTimeout(timer);
    try { fs.unlinkSync(CONFIG.pidFile); } catch {}
    try { await context.close(); } catch {}
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('unhandledRejection', (reason) => {
    log('FATAL', `未处理的 Promise 拒绝: ${reason}`);
    try { fs.unlinkSync(CONFIG.pidFile); } catch {}
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    log('FATAL', `未捕获的异常: ${err.message}`);
    try { fs.unlinkSync(CONFIG.pidFile); } catch {}
    process.exit(1);
  });
  // readline 监听终端关闭
  process.stdin.on('close', shutdown);
}

main().catch(err => {
  try { fs.unlinkSync(CONFIG.pidFile); } catch {}
  console.error('[FATAL]', err);
  process.exit(1);
});
