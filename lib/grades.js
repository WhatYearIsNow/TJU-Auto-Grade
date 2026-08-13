const fs = require('fs');
const { createNotificationId } = require('./notification_outbox');
const { sanitizeHeader } = require('./mailer');

const GRADE_CHANGE_FIELDS = [
  '总评成绩', '绩点', '平时成绩', '平时成绩占比',
  '期末成绩', '期末成绩占比', '实验成绩', '实验成绩占比',
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
  const gpa = change['绩点'];
  if (gpa === 4 || gpa === '4' || gpa === '4.0') return `出分啦！来自${name}的好消息哦！`;
  return `请查看${name}的成绩`;
}

function buildUpdateEmail(changes) {
  const fmtScore = value => value !== undefined && value !== '' ? escapeHtml(value) : '-';
  const rows = changes.map(grade => {
    const name = escapeHtml(grade['课程名称'] || '-');
    const score = fmtScore(grade['总评成绩']);
    const credit = fmtScore(grade['学分']);
    const gpa = fmtScore(grade['绩点']);
    const semester = escapeHtml(grade['学年学期'] || '');
    const category = escapeHtml(grade['课程性质'] || grade['课程类别'] || '');

    let tag = '';
    if (grade._change === 'new') tag = ' <span style="color:red;font-size:12px">NEW</span>';
    if (grade._change === 'updated') {
      const totalChanged = (grade._changedFields || []).includes('总评成绩');
      const text = totalChanged ? `${fmtScore(grade._oldScore)}→${score}` : '成绩明细更新';
      tag = ` <span style="color:orange;font-size:12px">${text}</span>`;
    }
    if (grade._change === 'removed') tag = ' <span style="color:gray;font-size:12px">已移除</span>';

    const details = [
      ['平时', grade['平时成绩'], grade['平时成绩占比']],
      ['实验', grade['实验成绩'], grade['实验成绩占比']],
      ['期末', grade['期末成绩'], grade['期末成绩占比']],
    ].filter(([, value]) => value !== undefined && value !== '')
      .map(([label, value, ratio]) => `${label}: ${fmtScore(value)}(${escapeHtml(ratio || '')})`);
    const detail = details.length > 0
      ? `<br><span style="font-size:11px;color:#888">${details.join(' | ')}</span>`
      : '';

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
<p style="color:#999;font-size:12px;margin-top:20px">由 TJU-Auto-Grade 自动发送</p>`;
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

function buildGradesEmail(grades, title = '最新成绩') {
  if (!grades?.length) return `<p>【${now()}】暂无成绩数据</p>`;
  const rows = grades.map(grade => `<tr>
    <td style="padding:4px 8px;border-bottom:1px solid #eee">${escapeHtml(grade['课程名称'] || '-')}</td>
    <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:center">${escapeHtml(grade['学年学期'] || '-')}</td>
    <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:center">${escapeHtml(grade['学分'] || '-')}</td>
    <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:center;font-weight:bold">${escapeHtml(grade['总评成绩'] ?? '-')}</td>
    <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:center">${escapeHtml(grade['绩点'] ?? '-')}</td>
  </tr>`).join('');
  return `
<p>【${now()}】${escapeHtml(title)} (${grades.length} 门)</p>
<table style="border-collapse:collapse;min-width:500px;font-size:13px">
  <thead><tr style="background:#f0f4ff">
    <th style="padding:6px;text-align:left;border-bottom:2px solid #ccd">课程</th>
    <th style="padding:6px;text-align:center;border-bottom:2px solid #ccd">学期</th>
    <th style="padding:6px;text-align:center;border-bottom:2px solid #ccd">学分</th>
    <th style="padding:6px;text-align:center;border-bottom:2px solid #ccd">成绩</th>
    <th style="padding:6px;text-align:center;border-bottom:2px solid #ccd">绩点</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

function buildWeightedEmail(data) {
  if (!data || (!data.summary.length && !data.tableGrades.length)) {
    return `<p>【${now()}】未能获取总加权数据，请确认页面可访问。</p>`;
  }
  const summaryHtml = data.summary.length
    ? `<p style="font-weight:bold;margin-bottom:8px">汇总信息：</p><ul style="list-style:none;padding:0">${data.summary.map(item => `<li style="padding:4px 0;border-bottom:1px solid #f0f0f0">${escapeHtml(item)}</li>`).join('')}</ul>`
    : '';
  const tableHtml = data.tableGrades.length
    ? `<table style="border-collapse:collapse;min-width:500px;font-size:13px;margin-top:12px">${data.tableGrades.map((row, index) => `<tr>${row.map(cell => index === 0
      ? `<th style="padding:5px 8px;border-bottom:2px solid #ccd;text-align:center;background:#f0f4ff">${escapeHtml(cell)}</th>`
      : `<td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:center">${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</table>`
    : '';
  return `<p>【${now()}】总加权成绩</p>${summaryHtml}${tableHtml}<p style="color:#999;font-size:11px;margin-top:12px">数据来自 EAMS 总加权页面</p>`;
}

function buildHelpEmail() {
  return `
<p>【${now()}】可用指令</p>
<table style="border-collapse:collapse;font-size:14px">
  <tr><td style="padding:6px 12px;font-weight:bold">状态 / status</td><td>查看脚本运行状态和最近日志</td></tr>
  <tr><td style="padding:6px 12px;font-weight:bold">总加权 / 加权</td><td>即时抓取总加权/累计成绩页面</td></tr>
  <tr><td style="padding:6px 12px;font-weight:bold">成绩单 / 成绩</td><td>即时抓取成绩单</td></tr>
  <tr><td style="padding:6px 12px;font-weight:bold">日志 / log</td><td>查看成绩变化记录</td></tr>
  <tr><td style="padding:6px 12px;font-weight:bold">帮助 / help</td><td>显示此帮助信息</td></tr>
</table>`;
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
  buildStatusEmail,
  buildSubject,
  buildUpdateEmail,
  buildWeightedEmail,
  createGradeNotification,
  diffGrades,
  escapeHtml,
  gradeKey,
};
