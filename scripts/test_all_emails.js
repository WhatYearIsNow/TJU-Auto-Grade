/**
 * 最终测试：一次性发送全部邮件模板
 *  - 5 封指令响应邮件（帮助/状态/日志/成绩单/总加权）
 *  - 4 封主动通知邮件（新成绩出分 / 会话过期 / 监控异常 / 控制台测试）
 *
 * 运行：node test_all_emails.js
 * 说明：成绩类模板使用内置样例数据，不访问教务系统；仅走 SMTP 发信。
 * 发信间隔默认 5 秒，避免发送过快被 QQ 邮箱限流。
 */
const path = require('path');
const { loadConfig } = require('../lib/config');
const { Mailer } = require('../lib/mailer');
const {
  buildGradesEmail,
  buildHelpEmail,
  buildLogEmail,
  buildStatusEmail,
  buildWeightedEmail,
  buildUpdateEmail,
  createGradeNotification,
} = require('../lib/grades');

function now() {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- 样例数据 ----------
const sampleGrades = [
  { '学年学期': '24-25-1', '课程代码': 'MATH001', '课程名称': '高等数学', '学分': '5', '总评成绩': 95, '绩点': 4, '课程性质': '必修' },
  { '学年学期': '24-25-1', '课程代码': 'CS001', '课程名称': '数据结构', '学分': '4', '总评成绩': 88, '绩点': 3.7, '课程性质': '必修' },
  { '学年学期': '24-25-1', '课程代码': 'PHYS001', '课程名称': '大学物理', '学分': '3', '总评成绩': 82, '绩点': 3.3, '课程性质': '必修' },
];

const sampleWeighted = {
  summary: ['加权平均分：87.5', '累计平均绩点：3.62', '已修总学分：45'],
  tableGrades: [
    ['学年学期', '加权平均分', '学分绩点', '学分'],
    ['24-25-1', '88.2', '3.72', '20'],
    ['23-24-2', '86.9', '3.55', '25'],
  ],
};

const sampleState = {
  startTime: new Date(Date.now() - 45 * 60 * 1000), // 已运行 45 分钟
  lastCheck: new Date(),
  lastResult: 'nochange',
  lastChange: null,
  failCount: 0,
  gradeCount: 42,
  outboxPending: 0,
  outboxRetrying: 0,
  lastDelivery: '2026/9/19 20:30:15',
};

// 新成绩出分通知（4.0 绩点 -> 主题“出分啦！…”）
const newGradeChange = {
  '学年学期': '24-25-1', '课程代码': 'MATH001', '课程名称': '高等数学',
  '学分': '5', '总评成绩': 95, '绩点': 4, '课程性质': '必修', _change: 'new',
};

// ---------- 待发送清单 ----------
function buildTasks(config) {
  const gradeNotif = createGradeNotification(newGradeChange);
  return [
    // —— 指令响应邮件（Re: 开头，与真实指令回复一致）——
    { tag: '指令-帮助', subject: 'Re: 帮助', body: buildHelpEmail() },
    { tag: '指令-状态', subject: 'Re: 状态', body: buildStatusEmail(sampleState, config) },
    { tag: '指令-日志', subject: 'Re: 日志', body: buildLogEmail(config.logFile) },
    { tag: '指令-成绩单', subject: 'Re: 成绩单', body: buildGradesEmail(sampleGrades, '最新成绩单') },
    { tag: '指令-总加权', subject: 'Re: 总加权', body: buildWeightedEmail(sampleWeighted) },

    // —— 主动通知邮件 ——
    { tag: '主动-新成绩出分', subject: gradeNotif.subject, body: gradeNotif.body },
    { tag: '主动-会话过期', subject: 'EAMS 会话已过期', body: `<p>【${now()}】自动重新登录失败，请在浏览器中重新登录 EAMS。</p>` },
    { tag: '主动-监控异常', subject: 'EAMS 监控异常', body: `<p>【${now()}】连续 3 次提取失败，请检查浏览器窗口。</p>` },
    { tag: '主动-控制台测试', subject: 'TJU-Auto-Grade 控制台测试', body: `<p>【${now()}】本机控制台邮件配置正常。</p>` },
  ];
}

async function main() {
  const config = loadConfig(path.resolve(__dirname, '..'));
  const mailer = new Mailer(config.smtp, {
    log: (tag, msg) => console.log(`  [${tag}] ${msg}`),
  });

  const problems = mailer.validate();
  if (problems.length > 0) {
    console.error('[配置错误] ' + problems.join('；'));
    process.exitCode = 1;
    return;
  }

  const tasks = buildTasks(config);
  console.log(`共 ${tasks.length} 封邮件，收件人：${config.smtp.to}`);
  console.log(`发送间隔：5 秒/封\n`);

  let ok = 0, fail = 0;
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    process.stdout.write(`[${i + 1}/${tasks.length}] ${t.tag}  主题《${t.subject}》 ... `);
    try {
      await mailer.send(t.subject, t.body);
      console.log('成功');
      ok++;
    } catch (err) {
      console.log('失败 -> ' + err.message);
      fail++;
    }
    if (i < tasks.length - 1) await sleep(5000); // 不要发送过快
  }

  mailer.close();
  console.log(`\n完成：成功 ${ok} 封，失败 ${fail} 封。`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(`[FAIL] ${err.message}`);
    process.exitCode = 1;
  });
}
