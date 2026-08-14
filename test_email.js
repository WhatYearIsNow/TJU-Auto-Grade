const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { sendMail } = require('./mailer');

function loadEnv(filepath) {
  if (!fs.existsSync(filepath)) return;
  const lines = fs.readFileSync(filepath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnv(path.join(__dirname, 'eams.env'));

function now() {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}

function spacer() {
  return '<br><br><br><br><br>';
}

function gradeTable(rows) {
  return `
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

function row(name, sem, credit, score, gpa, category) {
  return `<tr>
    <td style="padding:5px 8px;border-bottom:1px solid #eee">${name} <span style="color:red;font-size:12px">NEW</span></td>
    <td style="padding:5px 8px;border-bottom:1px solid #eee;text-align:center">${sem}</td>
    <td style="padding:5px 8px;border-bottom:1px solid #eee;text-align:center">${credit}</td>
    <td style="padding:5px 8px;border-bottom:1px solid #eee;text-align:center;font-weight:bold">${score}</td>
    <td style="padding:5px 8px;border-bottom:1px solid #eee;text-align:center">${gpa}</td>
    <td style="padding:5px 8px;border-bottom:1px solid #eee;font-size:12px;color:#666">${category}</td>
  </tr>`;
}

// 1. 首次发送
function buildFirstEmail() {
  return `
<span style="display:none;font-size:1px;max-height:0;overflow:hidden;color:#fff">成绩已更新，请打开邮件或登录EAMS查看详情。</span>
<p>【${now()}】成绩详情请打开邮件查看</p>
${spacer()}
${gradeTable(row('高等数学', '24-25-1', '5', '95', '4.0', '必修') + row('线性代数', '24-25-1', '3', '88', '3.7', '必修') + row('大学物理', '24-25-1', '4', '82', '3.3', '必修'))}`;
}

// 2. 绩点 4.0
function buildGpa4Email() {
  return `
<span style="display:none;font-size:1px;max-height:0;overflow:hidden;color:#fff">成绩已更新，请打开邮件或登录EAMS查看详情。</span>
<p>【${now()}】成绩详情请打开邮件查看</p>
${spacer()}
${gradeTable(row('高等数学', '24-25-1', '5', '95', '4.0', '必修'))}`;
}

// 3. 绩点 < 4.0
function buildGpaLessEmail() {
  return `
<span style="display:none;font-size:1px;max-height:0;overflow:hidden;color:#fff">成绩已更新，请打开邮件或登录EAMS查看详情。</span>
<p>【${now()}】成绩详情请打开邮件查看</p>
${spacer()}
${gradeTable(row('大学物理', '24-25-1', '4', '82', '3.3', '必修'))}`;
}

// ── 菜单 ──
const templates = {
  '1': { subject: '监控已启动', body: buildFirstEmail, label: '首次发送 — 初始快照' },
  '2': { subject: '出分啦！来自高等数学的好消息哦！', body: buildGpa4Email, label: '绩点 4.0 — 出分啦！来自xx的好消息哦！' },
  '3': { subject: '请查看大学物理的成绩', body: buildGpaLessEmail, label: '绩点 < 4.0 — 请查看xx的成绩' },
};

function showMenu() {
  console.log('\n========== tju-auto-grade 测试邮件 ==========');
  for (const [k, v] of Object.entries(templates)) {
    console.log(`  ${k}. ${v.label}`);
  }
  console.log('  0. 退出');
  console.log('=============================================\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('请选择要发送的邮件类型 (1-3): ', async (answer) => {
    rl.close();
    const tpl = templates[answer.trim()];
    if (!tpl) {
      console.log('已退出');
      return;
    }
    console.log(`\n正在发送: ${tpl.label}...`);
    try {
      const delivered = await sendMail(tpl.subject, tpl.body());
      console.log(delivered ? '[OK] 发送成功' : '[FAIL] 未配置邮箱');
    } catch (err) {
      console.error(`[FAIL] ${err.message}`);
    }
    console.log('\n按任意键退出...');
  });
}

showMenu();
