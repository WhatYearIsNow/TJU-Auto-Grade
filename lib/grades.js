const fs = require('fs');
const { createNotificationId } = require('./notification_outbox');
const { sanitizeHeader } = require('./mailer');

const GRADE_CHANGE_FIELDS = [
  '总评成绩', '绩点', '平时成绩', '平时成绩占比',
  '期末成绩', '期末成绩占比', '实验成绩', '实验成绩占比',
  '学分',
];

const GRADE_IDENTITY_FIELDS = [
  '学年学期', '课程代码', '课程名称', '教学班', '教学班号', '教学班代码',
];

function now() {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function gradeKey(grade) {
  return GRADE_IDENTITY_FIELDS
    .map(field => String(grade?.[field] ?? '').trim())
    .join('\u0000');
}

function diffGrades(oldGrades, newGrades) {
  const oldBuckets = new Map();
  for (const grade of oldGrades) {
    const key = gradeKey(grade);
    const bucket = oldBuckets.get(key) || [];
    bucket.push(grade);
    oldBuckets.set(key, bucket);
  }

  const changes = [];
  for (const grade of newGrades) {
    const key = gradeKey(grade);
    const bucket = oldBuckets.get(key);
    const oldGrade = bucket?.shift();
    if (bucket?.length === 0) oldBuckets.delete(key);

    if (!oldGrade) {
      changes.push({ ...grade, _change: 'new' });
      continue;
    }

    const changedFields = GRADE_CHANGE_FIELDS.filter(field =>
      String(oldGrade[field] ?? '') !== String(grade[field] ?? '')
    );
    if (changedFields.length === 0) continue;
    changes.push({
      ...grade,
      _change: 'updated',
      _oldScore: oldGrade['总评成绩'],
      _oldValues: Object.fromEntries(
        changedFields.map(field => [field, oldGrade[field] ?? ''])
      ),
      _changedFields: changedFields,
    });
  }

  for (const bucket of oldBuckets.values()) {
    for (const oldGrade of bucket) changes.push({ ...oldGrade, _change: 'removed' });
  }
  return changes;
}

function buildSubject(change) {
  const name = sanitizeHeader(change['课程名称'] || '未知课程');
  const total = parseFloat(change['总评成绩']);
  if (!isNaN(total) && total === 100) return `恭喜你！${name}圆满通关！`;
  if (!isNaN(total) && total >= 90) return `出分啦！来自${name}的好消息哦！`;
  if (!isNaN(total) && total < 60) return `很遗憾，${name}来年再战！`;
  return `请查看${name}的成绩`;
}

function buildUpdateEmail(changes) {
  const fmtScore = value => value !== undefined && value !== '' ? escapeHtml(value) : '-';
  const ch = changes[0] || {};
  const ps = ch['平时成绩'], es = ch['实验成绩'], fs = ch['期末成绩'];
  const pp = ch['平时成绩占比'] || '', ep = ch['实验成绩占比'] || '', fp = ch['期末成绩占比'] || '';
  // 表头占比：合并平时+实验
  let usualHeader = '平时';
  if (pp || ep) {
    const parts = [];
    if (pp) parts.push(pp);
    if (ep) parts.push('实验' + ep);
    usualHeader = '平时（' + parts.join('+') + '）';
  }
  let finalHeader = '期末';
  if (fp) finalHeader = '期末（' + fp + '）';

  const rows = changes.map(grade => {
    const name = escapeHtml(grade['课程名称'] || '-');
    const score = fmtScore(grade['总评成绩']);
    const credit = fmtScore(grade['学分']);
    const gpa = fmtScore(grade['绩点']);
    const semester = escapeHtml(grade['学年学期'] || '');
    const category = escapeHtml(grade['课程性质'] || grade['课程类别'] || '');
    const usual = grade['平时成绩'] ?? '-';
    const final_ = grade['期末成绩'] ?? '-';
    let tag = '';
    if (grade._change === 'new') tag = ' <span style="color:red;font-size:12px">NEW</span>';
    if (grade._change === 'updated') {
      const totalChanged = (grade._changedFields || []).includes('总评成绩');
      const text = totalChanged ? `${fmtScore(grade._oldScore)}→${score}` : '成绩明细更新';
      tag = ` <span style="color:orange;font-size:12px">${text}</span>`;
    }
    if (grade._change === 'removed') tag = ' <span style="color:gray;font-size:12px">已移除</span>';
    return `<tr>
      <td style="padding:5px 8px;border-bottom:1px solid #eee">${name}${tag}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #eee;text-align:center">${semester}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #eee;text-align:center">${credit}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #eee;text-align:center">${usual}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #eee;text-align:center">${final_}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #eee;text-align:center;font-weight:bold">${score}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #eee;text-align:center">${gpa}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #eee;font-size:12px;color:#666">${category}</td>
    </tr>`;
  }).join('');

  return `
<p>【${now()}】成绩详情请打开邮件查看</p>
<table style="border-collapse:collapse;min-width:680px;font-size:14px">
  <thead><tr style="background:#f0f4ff">
    <th style="padding:8px;text-align:left;border-bottom:2px solid #ccd">课程</th>
    <th style="padding:8px;text-align:center;border-bottom:2px solid #ccd">学期</th>
    <th style="padding:8px;text-align:center;border-bottom:2px solid #ccd">学分</th>
    <th style="padding:8px;text-align:center;border-bottom:2px solid #ccd">${usualHeader}</th>
    <th style="padding:8px;text-align:center;border-bottom:2px solid #ccd">${finalHeader}</th>
    <th style="padding:8px;text-align:center;border-bottom:2px solid #ccd">成绩</th>
    <th style="padding:8px;text-align:center;border-bottom:2px solid #ccd">绩点</th>
    <th style="padding:8px;text-align:center;border-bottom:2px solid #ccd">性质</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>
<p style="font-size:12px;color:#999;margin-top:8px">由 tju-auto-grade 自动发送</p>`;
}


function createGradeNotification(change) {
  const fields = change._change === 'updated'
    ? (change._changedFields || GRADE_CHANGE_FIELDS)
    : GRADE_CHANGE_FIELDS;
  const gradeValues = Object.fromEntries(fields.map(field => [field, change[field] ?? '']));
  const oldValues = change._change === 'removed' ? gradeValues : (change._oldValues || {});
  const currentValues = change._change === 'removed' ? {} : gradeValues;
  const fingerprint = {
    version: 2,
    grade: gradeKey(change),
    change: change._change,
    oldValues,
    currentValues,
  };
  return {
    id: createNotificationId(fingerprint),
    subject: buildSubject(change),
    body: buildUpdateEmail([change]),
    meta: {
      grade: gradeKey(change),
      course: change['课程名称'] || '',
      semester: change['学年学期'] || '',
      change: change._change,
    },
  };
}

function parseNum(v) {
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

function parseNum(v) {
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}
function parsePct(v) {
  const n = parseFloat(String(v).replace('%', ''));
  return isNaN(n) ? 0 : n / 100;
}

function buildGradesEmail(grades, title = '最新成绩') {
  if (!grades?.length) return `<p>【${now()}】${escapeHtml(title)}：暂无成绩数据</p>`;
  let weightedSum = 0, creditSum = 0, gpaSum = 0, gpaCredit = 0;
  const rows = grades.map(grade => {
    const credit = parseNum(grade['学分']) || 0;
    const total = parseNum(grade['总评成绩']);
    const gp = parseNum(grade['绩点']);
    if (total !== null && credit > 0) { weightedSum += total * credit; creditSum += credit; }
    if (gp !== null && gp > 0 && credit > 0) { gpaSum += gp * credit; gpaCredit += credit; }
    const ps = parseNum(grade['平时成绩']);
    const es = parseNum(grade['实验成绩']);
    const pp = parsePct(grade['平时成绩占比']);
    const ep = parsePct(grade['实验成绩占比']);
    let usual;
    if (es !== null && ep > 0 && pp + ep > 0) {
      usual = Math.round((ps * pp + es * ep) / (pp + ep) * 10) / 10;
    } else {
      usual = ps;
    }
    const finalExam = parseNum(grade['期末成绩']);
    const name = grade['课程名称'] || '-';
    const hasExp = es !== null;
    const label = hasExp ? `${name}（实验）` : name;
    return `<tr>
      <td style="padding:4px 8px;border-bottom:1px solid #eee">${escapeHtml(label)}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:center">${escapeHtml(grade['学分'] || '-')}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:center">${usual ?? '-'}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:center">${finalExam ?? '-'}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:center;font-weight:bold">${escapeHtml(grade['总评成绩'] ?? '-')}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:center">${escapeHtml(grade['绩点'] ?? '-')}</td>
    </tr>`;
  }).join('');
  const weightedAvg = creditSum > 0 ? (weightedSum / creditSum).toFixed(2) : '-';
  const gpa = gpaCredit > 0 ? (gpaSum / gpaCredit).toFixed(2) : '-';
  return `
<p style="font-size:14px;margin-bottom:8px">${escapeHtml(title)}<br>课程数：<b>${grades.length}</b>　学分：<b>${creditSum}</b>　加权：<b>${weightedAvg}</b>　GPA：<b>${gpa}</b></p>
<table style="border-collapse:collapse;min-width:620px;font-size:13px">
  <thead><tr style="background:#f0f4ff">
    <th style="padding:6px;text-align:left;border-bottom:2px solid #ccd">课程</th>
    <th style="padding:6px;text-align:center;border-bottom:2px solid #ccd">学分</th>
    <th style="padding:6px;text-align:center;border-bottom:2px solid #ccd">平时</th>
    <th style="padding:6px;text-align:center;border-bottom:2px solid #ccd">期末</th>
    <th style="padding:6px;text-align:center;border-bottom:2px solid #ccd">总评</th>
    <th style="padding:6px;text-align:center;border-bottom:2px solid #ccd">绩点</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

function buildAllSemestersEmail(semesterDataList) {
  if (!semesterDataList?.length) return `<p>【${now()}】暂无学期数据</p>`;
  // 汇总所有学期
  let totalCourses = 0, totalCredits = 0, weightedSum = 0, gpaSum = 0, gpaCredit = 0;
  let bodyRows = '';
  for (const item of semesterDataList) {
    const { label, grades } = item;
    if (!grades?.length) continue;
    // 学期分组行（跨列居中）
    bodyRows += `<tr><td colspan="6" style="padding:8px;font-weight:bold;background:#e8eef9;text-align:center;border-bottom:2px solid #ccd">${escapeHtml(label)}</td></tr>`;
    for (const grade of grades) {
      const credit = parseNum(grade['学分']) || 0;
      const total = parseNum(grade['总评成绩']);
      const gp = parseNum(grade['绩点']);
      totalCourses++;
      if (credit > 0) totalCredits += credit;
      if (total !== null && credit > 0) weightedSum += total * credit;
      if (gp !== null && gp > 0 && credit > 0) { gpaSum += gp * credit; gpaCredit += credit; }
      const ps = parseNum(grade['平时成绩']);
      const es = parseNum(grade['实验成绩']);
      const pp = parsePct(grade['平时成绩占比']);
      const ep = parsePct(grade['实验成绩占比']);
      let usual;
      if (es !== null && ep > 0 && pp + ep > 0) {
        usual = Math.round((ps * pp + es * ep) / (pp + ep) * 10) / 10;
      } else { usual = ps; }
      const finalExam = parseNum(grade['期末成绩']);
      const name = grade['课程名称'] || '-';
      const hasExp = es !== null;
      const name2 = hasExp ? `${name}（实验）` : name;
      bodyRows += `<tr>
        <td style="padding:4px 8px;border-bottom:1px solid #eee">${escapeHtml(name2)}</td>
        <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:center">${escapeHtml(grade['学分'] || '-')}</td>
        <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:center">${usual ?? '-'}</td>
        <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:center">${finalExam ?? '-'}</td>
        <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:center;font-weight:bold">${escapeHtml(grade['总评成绩'] ?? '-')}</td>
        <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:center">${escapeHtml(grade['绩点'] ?? '-')}</td>
      </tr>`;
    }
  }
  const weightedAvg = totalCredits > 0 ? (weightedSum / totalCredits).toFixed(2) : '-';
  const gpa = gpaCredit > 0 ? (gpaSum / gpaCredit).toFixed(2) : '-';
  return `
<p style="font-size:14px;margin-bottom:8px">成绩单<br>课程数：<b>${totalCourses}</b>　学分：<b>${totalCredits}</b>　加权：<b>${weightedAvg}</b>　GPA：<b>${gpa}</b></p>
<table style="border-collapse:collapse;min-width:620px;font-size:13px">
  <thead><tr style="background:#f0f4ff">
    <th style="padding:6px;text-align:left;border-bottom:2px solid #ccd">课程</th>
    <th style="padding:6px;text-align:center;border-bottom:2px solid #ccd">学分</th>
    <th style="padding:6px;text-align:center;border-bottom:2px solid #ccd">平时</th>
    <th style="padding:6px;text-align:center;border-bottom:2px solid #ccd">期末</th>
    <th style="padding:6px;text-align:center;border-bottom:2px solid #ccd">总评</th>
    <th style="padding:6px;text-align:center;border-bottom:2px solid #ccd">绩点</th>
  </tr></thead>
  <tbody>${bodyRows}</tbody>
</table>`;
}


function buildWeightedEmail(data) {
  if (!data || !data.tableGrades || data.tableGrades.length < 2) {
    return `<p>【${now()}】未能获取总加权数据，请稍后再试。</p>`;
  }
  const t = data.tableGrades[1] || [];
  const rows = [
    ['课程数', t[1] || '-'],
    ['总学分', t[2] || '-'],
    ['加权平均成绩', t[4] || '-'],
    ['平均绩点', t[3] || '-'],
  ].map(([label, value]) => `<tr><td style="padding:6px 14px;border-bottom:1px solid #eee">${label}</td><td style="padding:6px 14px;border-bottom:1px solid #eee;font-weight:bold">${escapeHtml(String(value))}</td></tr>`).join('');
  return `<p>【${now()}】总加权成绩</p>
<table style="border-collapse:collapse;font-size:14px;min-width:320px">${rows}</table>`;
}

function buildHelpEmail() {
  return `
<p>【${now()}】可用指令（主题或正文写以下任意一项）</p>
<table style="border-collapse:collapse;font-size:14px">
  <tr><td style="padding:6px 14px;font-weight:bold;width:120px">启动</td><td>开始每 5 分钟自动查分，有变化邮件通知</td></tr>
  <tr><td style="padding:6px 14px;font-weight:bold">停止</td><td>停止自动查分（查询功能仍可用）</td></tr>
  <tr><td style="padding:6px 14px;font-weight:bold">状态</td><td>查看运行状态、在线时长、最近检查结果</td></tr>
  <tr><td style="padding:6px 14px;font-weight:bold">日志</td><td>查看自运行起每次抓取的时间、课程数与成绩变化</td></tr>
  <tr><td style="padding:6px 14px;font-weight:bold">总加权</td><td>查看总学分、加权成绩、GPA</td></tr>
  <tr><td style="padding:6px 14px;font-weight:bold">成绩单</td><td>查看当前学期全部课程（学期、名称、成绩、绩点）</td></tr>
  <tr><td style="padding:6px 14px;font-weight:bold">25261 等 5 位数字</td><td>查看指定学期成绩单（前4位=学年，末位=学期号）</td></tr>
</table>
<p style="color:#999;font-size:12px;margin-top:12px">学期号示例：26271 = 2026-2027 学年第 1 学期（秋），26272 = 第 2 学期（春）</p>`;
}

function readEscapedLog(file, filter, limit) {
  try {
    return fs.readFileSync(file, 'utf-8').split(/\r?\n/).filter(Boolean)
      .filter(line => !filter || filter.test(line))
      .slice(-limit).map(escapeHtml).join('<br>') || '暂无记录';
  } catch {
    return '无法读取日志';
  }
}

function buildLogEmail(logFile) {
  const lines = readEscapedLog(logFile, /发现.*变化|出分|NEW|updated|移除|有新成绩/i, 20);
  return `<p>【${now()}】成绩变化记录</p><pre style="background:#f5f5f5;padding:10px;font-size:11px;border-radius:4px;overflow-x:auto">${lines}</pre>`;
}

function buildHistoryEmail(historyFile) {
  const fs = require('fs');
  let lines = [];
  try {
    const raw = fs.readFileSync(historyFile, 'utf-8').trim().split('\n');
    lines = raw.slice(-30).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return `<p>【${now()}】暂无历史记录。</p>`; }
  if (lines.length === 0) return `<p>【${now()}】暂无历史记录。</p>`;
  const rows = lines.map(rec => {
    const ch = rec.changes && rec.changes.length
      ? rec.changes.map(c => `${escapeHtml(c.name)}: ${escapeHtml(String(c.old))} -> ${escapeHtml(String(c.new))}`).join('<br>')
      : '<span style="color:#aaa">无变化</span>';
    return `<tr><td style="padding:6px 12px;border-bottom:1px solid #eee;color:#666;white-space:nowrap">${escapeHtml(rec.time)}</td><td style="padding:6px 12px;border-bottom:1px solid #eee">${rec.count} 门</td><td style="padding:6px 12px;border-bottom:1px solid #eee">${ch}</td></tr>`;
  }).join('');
  return `<p>【${now()}】抓取历史（最近 ${lines.length} 次，共自服务器运行起记录）</p>
<table style="border-collapse:collapse;font-size:13px;width:100%">
<thead><tr style="background:#f5f5f5"><th style="padding:6px 12px;text-align:left">时间</th><th style="padding:6px 12px;text-align:left">课程数</th><th style="padding:6px 12px;text-align:left">变化</th></tr></thead>
<tbody>${rows}</tbody></table>`;
}

function buildStatusEmail(state, options) {
  const uptime = Math.floor((Date.now() - state.startTime.getTime()) / 60000);
  const resultMap = { ok: '成功', fail: '失败', cas: '会话过期', nochange: '无变化', change: '有更新' };
  const rows = [
    ['运行时长', `${uptime} 分钟`],
    ['已抓课程', `${state.gradeCount} 门`],
    ['最近检查', state.lastCheck?.toLocaleString('zh-CN', { hour12: false }) || '暂无'],
    ['最近结果', resultMap[state.lastResult] || state.lastResult || '-'],
    ['连续失败', `${state.failCount} 次`],
    ['待发通知', `${state.outboxPending} 条（重试中 ${state.outboxRetrying} 条）`],
    ['最近发送', state.lastDelivery || '暂无'],
    ['最近变动', state.lastChange || '暂无'],
    ['检查间隔', `${options.checkIntervalMs / 60000} 分钟`],
  ].map(([label, value]) => `<tr><td style="padding:6px 12px;border-bottom:1px solid #eee;color:#888">${label}</td><td style="padding:6px 12px;border-bottom:1px solid #eee">${escapeHtml(value)}</td></tr>`).join('');
  return `<p>【${now()}】脚本运行状态</p><table style="border-collapse:collapse;font-size:14px">${rows}</table><p style="color:#999;font-size:12px;margin-top:16px">最近日志：</p><pre style="background:#f5f5f5;padding:10px;font-size:11px;border-radius:4px;overflow-x:auto">${readEscapedLog(options.logFile, null, 10)}</pre>`;
}

module.exports = {
  GRADE_CHANGE_FIELDS,
  GRADE_IDENTITY_FIELDS,
  buildGradesEmail,
  buildHelpEmail,
  buildLogEmail,
  buildHistoryEmail,
  buildStatusEmail,
  buildSubject,
  buildUpdateEmail,
  buildWeightedEmail,
  buildAllSemestersEmail,
  createGradeNotification,
  diffGrades,
  escapeHtml,
  gradeKey,
};
