#!/usr/bin/env node
/**
 * TJU EAMS 查成绩助手 — 常驻监控版
 * 浏览器一直开着，定时刷新成绩，仅发送有变化的科目
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { sendMail: deliverMail } = require('./mailer');

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

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// ── 配置 ──────────────────────────────────────────────
const CONFIG = {
  eamsEntry: process.env.EAMS_ENTRY_URL || 'https://classes.tju.edu.cn/eams/homeExt.action',
  gradeUrl: process.env.EAMS_GRADE_URL || '/eams/teach/grade/course/person!search.action',
  profileDir: path.join(__dirname, '.eams_profile'),
  lastGradesFile: path.join(__dirname, 'grades_latest.json'),
  logFile: path.join(__dirname, 'eams_monitor.log'),
  pidFile: path.join(__dirname, '.eams_pid'),
  heartbeatFile: path.join(__dirname, '.eams_heartbeat'),
};
const CHECK_INTERVAL = positiveNumber(process.env.CHECK_INTERVAL_MINUTES, 15) * 60 * 1000;
const HEARTBEAT_INTERVAL = 60 * 1000;
const EAMS_HOST = new URL(CONFIG.eamsEntry).hostname;
const CAS_HOST = process.env.EAMS_CAS_HOST || 'sso.tju.edu.cn';

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

function readPid(filepath = CONFIG.pidFile) {
  try {
    const content = fs.readFileSync(filepath, 'utf-8').trim();
    if (!content) return null;
    if (/^\d+$/.test(content)) return Number.parseInt(content, 10);
    const record = JSON.parse(content);
    return Number.isInteger(record.pid) ? record.pid : null;
  } catch {
    return null;
  }
}

function isPidRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquirePidFile() {
  const existingPid = readPid();
  if (existingPid && existingPid !== process.pid && isPidRunning(existingPid)) {
    throw new Error(`监控已经在运行 (PID ${existingPid})`);
  }
  fs.writeFileSync(CONFIG.pidFile, JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
  }), 'utf-8');
}

function writeHeartbeat() {
  fs.writeFileSync(CONFIG.heartbeatFile, new Date().toISOString(), 'utf-8');
}

function cleanupRuntimeFiles() {
  if (readPid() === process.pid) {
    try { fs.unlinkSync(CONFIG.pidFile); } catch {}
    try { fs.unlinkSync(CONFIG.heartbeatFile); } catch {}
  }
}

function loadGradeSnapshot(filepath = CONFIG.lastGradesFile) {
  try {
    const value = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function saveGradeSnapshot(grades, filepath = CONFIG.lastGradesFile) {
  const tempFile = `${filepath}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(grades, null, 2), 'utf-8');
  fs.renameSync(tempFile, filepath);
}

// ── EAMS 页面判断 ─────────────────────────────────────
function pageHostname(page) {
  try { return new URL(page.url()).hostname; } catch { return ''; }
}
async function isOnCasPage(page) { return pageHostname(page) === CAS_HOST; }
async function isOnEamsPage(page) { return pageHostname(page) === EAMS_HOST; }

class SessionExpiredError extends Error {
  constructor() {
    super('EAMS 会话已过期');
    this.name = 'SessionExpiredError';
  }
}

// ── 登录 ──────────────────────────────────────────────
async function autoLogin(page) {
  const username = process.env.EAMS_USERNAME;
  const password = process.env.EAMS_PASSWORD;
  if (!username || !password) return false;
  if (!process.env.DASHSCOPE_API_KEY) {
    log('LOGIN', '未配置 DASHSCOPE_API_KEY，跳过 AI 登录');
    return false;
  }

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

  const username = process.env.EAMS_USERNAME;
  const password = process.env.EAMS_PASSWORD;

  if (username && password) {
    await page.waitForSelector('#un', { timeout: 60000 }).catch(() => {});
    if (await page.$('#un')) {
      await page.fill('#un', username);
      await page.fill('#pd', password);
      log('LOGIN', '已填写账号密码');
      if (process.stdin.isTTY) {
        await ask('请在浏览器中输完验证码后，回终端按回车继续...');
        try {
          await page.locator('button[type="submit"], input[type="submit"]').first().click({ timeout: 5000 });
          log('LOGIN', '已点击登录按钮');
        } catch {
          log('LOGIN', '未找到登录按钮，请手动点击');
        }
      } else {
        log('LOGIN', '当前无交互终端，请在浏览器中填写验证码并点击登录');
      }
    }
  } else {
    log('LOGIN', '未配置账号密码，请在浏览器中自行登录（终端不会读取密码）');
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

async function ensureLoggedIn(page) {
  if (await isOnEamsPage(page)) return true;
  if (!(await isOnCasPage(page))) return false;

  let ok = await autoLogin(page);
  if (!ok) {
    log('LOGIN', '自动登录不可用或失败，切换到手动登录');
    ok = await manualLogin(page);
  }
  return ok;
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

async function selectAllSemesters(page) {
  const candidates = [
    page.getByLabel(/(?:all|全部|所有).*学期/i).first(),
    page.locator('input[type="checkbox"][id*="all" i], input[type="checkbox"][name*="all" i]').first(),
  ];

  for (const checkbox of candidates) {
    try {
      if (await checkbox.count() === 0 || !(await checkbox.isVisible())) continue;
      if (!(await checkbox.isChecked())) {
        await checkbox.check();
        await page.waitForTimeout(2000);
      }
      return true;
    } catch {}
  }

  log('EXTRACT', '未找到“All 学期”复选框，将使用页面当前查询范围');
  return false;
}

function parseGradeRows(rawHeaders, rawRows) {
  const headers = rawHeaders.map(header => String(header ?? '').trim().replace(/\s+/g, ''));
  const scoreIndex = headers.findIndex(
    header => header === '总评成绩' || header.includes('总评'),
  );
  const nameIndex = headers.findIndex(header => header === '课程名称');
  if (scoreIndex < 0 || nameIndex < 0) return [];

  const grades = [];
  for (const rawCells of rawRows) {
    if (rawCells.length < headers.length) continue;

    const entry = {};
    for (let index = 0; index < headers.length; index++) {
      const text = String(rawCells[index] ?? '')
        .trim()
        .replace(/\u00a0/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (index === scoreIndex && text && !Number.isNaN(Number.parseFloat(text))) {
        entry[headers[index]] = Number.parseFloat(text);
      } else {
        entry[headers[index]] = text;
      }
    }

    if (entry[headers[nameIndex]] && entry[headers[scoreIndex]] !== '') {
      grades.push(entry);
    }
  }
  return grades;
}

async function extractGrades(page) {
  const gradeUrl = new URL(CONFIG.gradeUrl, CONFIG.eamsEntry).href;
  await retry(() => page.goto(gradeUrl, {
    waitUntil: 'domcontentloaded', timeout: 30000,
  }), 3, '页面加载');
  await page.waitForTimeout(2000);

  if (await isOnCasPage(page)) throw new SessionExpiredError();

  await selectAllSemesters(page);

  try {
    await page.waitForSelector('table', { timeout: 15000 });
  } catch {
    if (await isOnCasPage(page)) throw new SessionExpiredError();
    return [];
  }

  const tables = await page.$$('table');
  let grades = [];

  for (const table of tables) {
    const ths = await table.$$('th');
    if (ths.length < 2) continue;

    const rawHeaders = [];
    for (const th of ths) {
      rawHeaders.push(await th.textContent());
    }

    const rawRows = [];
    const rows = await table.$$('tr');
    for (const row of rows) {
      const cls = (await row.getAttribute('class')) || '';
      if (/title|head|info/i.test(cls)) continue;
      const cells = await row.$$('td');
      if (cells.length === 0) continue;
      const rawCells = [];
      for (const cell of cells) {
        rawCells.push(await cell.textContent());
      }
      rawRows.push(rawCells);
    }

    grades.push(...parseGradeRows(rawHeaders, rawRows));
  }

  log('EXTRACT', `共 ${grades.length} 门课程`);
  return grades;
}

async function extractWithSessionRecovery(page) {
  try {
    return await extractGrades(page);
  } catch (err) {
    if (!(err instanceof SessionExpiredError) && !(await isOnCasPage(page))) throw err;

    log('CHECK', '会话已过期，立即尝试重新登录');
    if (!(await ensureLoggedIn(page))) {
      throw new Error('会话过期且重新登录失败');
    }
    log('CHECK', '重新登录成功，继续本次查询');
    return extractGrades(page);
  }
}

// ── 成绩对比 ──────────────────────────────────────────
function gradeKey(grade) {
  const text = (value) => String(value ?? '').trim();
  const courseCode = text(grade['课程代码']);
  const courseName = text(grade['课程名称']);
  const semester = text(grade['学年学期'] || grade['学期']);
  const classCode = text(
    grade['教学班号']
      || grade['课程序号']
      || grade['教学班']
      || grade['课程号'],
  );

  return [courseCode || courseName, semester, classCode, courseName].join('\u001f');
}

function diffGrades(oldGrades, newGrades) {
  const oldMap = new Map();
  for (const g of oldGrades) {
    const key = gradeKey(g);
    const entries = oldMap.get(key) || [];
    entries.push(g);
    oldMap.set(key, entries);
  }

  const changes = [];
  for (const g of newGrades) {
    const key = gradeKey(g);
    const oldEntries = oldMap.get(key);
    const oldGrade = oldEntries?.shift();
    if (oldEntries?.length === 0) oldMap.delete(key);

    if (!oldGrade) {
      changes.push({ ...g, _change: 'new' });
    } else if (String(oldGrade['总评成绩']) !== String(g['总评成绩'])) {
      changes.push({ ...g, _change: 'updated', _oldScore: oldGrade['总评成绩'] });
    }
  }

  for (const oldEntries of oldMap.values()) {
    for (const oldGrade of oldEntries) {
      changes.push({ ...oldGrade, _change: 'removed' });
    }
  }

  return changes;
}

// ── 邮件发送 ──────────────────────────────────────────
async function sendMail(subject, body) {
  const delivered = await deliverMail(subject, body);
  if (delivered) log('MAIL', `发送成功: ${subject}`);
  else log('MAIL', '未配置邮箱，跳过发送');
  return delivered;
}

function buildSubject(change) {
  const name = String(change['课程名称'] || '未知课程').replace(/[\r\n]+/g, ' ').trim();
  const gpa = change['绩点'];
  if (gpa === 4 || gpa === '4') return `出分啦！来自${name}的好消息哦！`;
  return `请查看${name}的成绩`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function buildUpdateEmail(changes) {
  const fmtScore = (value) => escapeHtml(
    value !== undefined && value !== '' ? value : '-',
  );

  const rows = changes.map(g => {
    const name = escapeHtml(g['课程名称'] || '-');
    const score = fmtScore(g['总评成绩']);
    const credit = fmtScore(g['学分']);
    const gpa = fmtScore(g['绩点']);
    const semester = escapeHtml(g['学年学期'] || '');
    const category = escapeHtml(g['课程性质'] || g['课程类别'] || '');

    let tag = '';
    if (g._change === 'new') tag = ' <span style="color:red;font-size:12px">NEW</span>';
    else if (g._change === 'updated') tag = ` <span style="color:orange;font-size:12px">${escapeHtml(g._oldScore)}→${score}</span>`;
    else if (g._change === 'removed') tag = ' <span style="color:gray;font-size:12px">已移除</span>';

    // 平时/期末/实验成绩明细
    const daily = fmtScore(g['平时成绩']);
    const dailyPct = escapeHtml(g['平时成绩占比'] || '');
    const final = fmtScore(g['期末成绩']);
    const finalPct = escapeHtml(g['期末成绩占比'] || '');
    const lab = fmtScore(g['实验成绩']);
    const labPct = escapeHtml(g['实验成绩占比'] || '');

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
  acquirePidFile();
  writeHeartbeat();
  const heartbeatTimer = setInterval(() => {
    try { writeHeartbeat(); } catch (err) {
      log('HEARTBEAT', `写入失败: ${err.message}`);
    }
  }, HEARTBEAT_INTERVAL);
  let context = null;
  let timer = null;
  let shuttingDown = false;

  try {
    log('INIT', '启动浏览器 (Edge)...');
    context = await chromium.launchPersistentContext(CONFIG.profileDir, {
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
      log('INIT', '需要登录 EAMS...');
      if (!(await ensureLoggedIn(page))) throw new Error('登录失败');
    } else if (await isOnEamsPage(page)) {
      log('INIT', '会话有效，跳过登录');
    } else {
      throw new Error(`访问了非预期页面: ${page.url()}`);
    }

    // ── 首次抓取与快照恢复 ──
    log('INIT', '抓取当前成绩...');
    const currentGrades = await extractWithSessionRecovery(page);
    if (currentGrades.length === 0) throw new Error('未抓到成绩');

    const savedGrades = loadGradeSnapshot();
    let lastGrades = currentGrades;

    if (savedGrades) {
      const offlineChanges = diffGrades(savedGrades, currentGrades);
      log('INIT', `已恢复快照: ${savedGrades.length} 门课程`);
      if (offlineChanges.length > 0) {
        log('INIT', `发现停机期间 ${offlineChanges.length} 门课程有变化`);
        try {
          for (const grade of offlineChanges) {
            await sendMail(buildSubject(grade), buildUpdateEmail([grade]));
          }
          saveGradeSnapshot(currentGrades);
        } catch (err) {
          lastGrades = savedGrades;
          log('INIT', `离线变化通知失败，将在下次检查重试: ${err.message}`);
        }
      } else {
        saveGradeSnapshot(currentGrades);
      }
    } else {
      saveGradeSnapshot(currentGrades);
      log('INIT', `已创建初始快照: ${currentGrades.length} 门课程`);
      try {
        const firstBody = buildUpdateEmail(
          currentGrades.map(grade => ({ ...grade, _change: 'new' })),
        );
        await sendMail('监控已启动', firstBody);
      } catch (err) {
        log('INIT', `启动通知失败: ${err.message}`);
      }
    }

    // ── 常驻监控 ──
    const intervalMinutes = CHECK_INTERVAL / 60000;
    console.log(`\n${'='.repeat(50)}`);
    console.log(`  监控已启动，每 ${intervalMinutes} 分钟检查一次`);
    console.log(`  浏览器不要关 | 日志: ${CONFIG.logFile}`);
    console.log(`${'='.repeat(50)}\n`);

    let failCount = 0;
    let failureAlertActive = false;

    async function recordFailure(error) {
      failCount++;
      log('CHECK', `失败: ${error.message} (连续 ${failCount} 次)`);
      if (failCount >= 3 && !failureAlertActive) {
        try {
          await sendMail(
            'EAMS 监控异常',
            `<p>【${now()}】连续 ${failCount} 次检查失败：${error.message}</p>`,
          );
          failureAlertActive = true;
        } catch (mailError) {
          log('MAIL', `异常报警发送失败: ${mailError.message}`);
        }
      }
    }

    async function markHealthy() {
      const shouldNotifyRecovery = failureAlertActive;
      failCount = 0;
      failureAlertActive = false;
      if (shouldNotifyRecovery) {
        try {
          await sendMail('EAMS 监控已恢复', `<p>【${now()}】成绩监控已恢复正常。</p>`);
        } catch (err) {
          log('MAIL', `恢复通知发送失败: ${err.message}`);
        }
      }
    }

    async function check() {
      const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      log('CHECK', `--- ${ts} 开始检查 ---`);

      try {
        const freshGrades = await extractWithSessionRecovery(page);
        if (freshGrades.length === 0) throw new Error('成绩表为空或页面结构已变化');

        const changes = diffGrades(lastGrades, freshGrades);
        if (changes.length > 0) {
          log('CHECK', `发现 ${changes.length} 门课程有变化`);
          for (const grade of changes) {
            await sendMail(buildSubject(grade), buildUpdateEmail([grade]));
          }
          lastGrades = freshGrades;
          saveGradeSnapshot(lastGrades);
        } else {
          log('CHECK', '无变化');
        }

        await markHealthy();
      } catch (err) {
        await recordFailure(err);
      } finally {
        scheduleNext();
      }
    }

    function scheduleNext() {
      timer = setTimeout(check, CHECK_INTERVAL);
    }

    async function shutdown(exitCode = 0) {
      if (shuttingDown) return;
      shuttingDown = true;
      log('EXIT', '正在关闭...');
      clearTimeout(timer);
      clearInterval(heartbeatTimer);
      cleanupRuntimeFiles();
      try { await context.close(); } catch {}
      process.exit(exitCode);
    }

    process.once('SIGINT', () => shutdown(0));
    process.once('SIGTERM', () => shutdown(0));
    process.once('unhandledRejection', (reason) => {
      log('FATAL', `未处理的 Promise 拒绝: ${reason}`);
      shutdown(1);
    });
    process.once('uncaughtException', (err) => {
      log('FATAL', `未捕获的异常: ${err.message}`);
      shutdown(1);
    });

    scheduleNext();
  } catch (err) {
    clearTimeout(timer);
    clearInterval(heartbeatTimer);
    cleanupRuntimeFiles();
    try { await context?.close(); } catch {}
    throw err;
  }
}

if (require.main === module) {
  main().catch(err => {
    cleanupRuntimeFiles();
    console.error('[FATAL]', err);
    process.exit(1);
  });
}

module.exports = {
  SessionExpiredError,
  buildUpdateEmail,
  diffGrades,
  gradeKey,
  loadGradeSnapshot,
  parseGradeRows,
  saveGradeSnapshot,
};
