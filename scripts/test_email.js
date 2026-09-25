const readline = require('readline');
const path = require('path');
const { loadConfig } = require('../lib/config');
const { buildUpdateEmail } = require('../lib/grades');
const { Mailer } = require('../lib/mailer');

const sampleGrades = [
  { '学年学期': '24-25-1', '课程代码': 'MATH001', '课程名称': '高等数学', '学分': '5', '总评成绩': 95, '绩点': 4, '课程性质': '必修', _change: 'new' },
  { '学年学期': '24-25-1', '课程代码': 'MATH002', '课程名称': '线性代数', '学分': '3', '总评成绩': 88, '绩点': 3.7, '课程性质': '必修', _change: 'new' },
  { '学年学期': '24-25-1', '课程代码': 'PHYS001', '课程名称': '大学物理', '学分': '4', '总评成绩': 82, '绩点': 3.3, '课程性质': '必修', _change: 'new' },
];

const templates = {
  '1': { subject: '监控邮件测试', grades: sampleGrades, label: '多门成绩通知' },
  '2': { subject: '出分啦！来自高等数学的好消息哦！', grades: sampleGrades.slice(0, 1), label: '4.0 绩点通知' },
  '3': { subject: '请查看大学物理的成绩', grades: sampleGrades.slice(2), label: '普通成绩通知' },
};

function chooseTemplate() {
  console.log('\n========== TJU-Auto-Grade 测试邮件 ==========');
  for (const [key, template] of Object.entries(templates)) {
    console.log(`  ${key}. ${template.label}`);
  }
  console.log('  0. 退出\n');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question('请选择要发送的邮件类型 (1-3): ', answer => {
    rl.close();
    resolve(templates[answer.trim()] || null);
  }));
}

async function main() {
  const config = loadConfig(path.resolve(__dirname, '..'));
  const mailer = new Mailer(config.smtp, {
    log: (tag, message) => console.log(`[${tag}] ${message}`),
  });
  const problems = mailer.validate();
  if (problems.length > 0) throw new Error(problems.join('；'));
  const template = await chooseTemplate();
  if (!template) return;
  console.log(`正在发送: ${template.label}...`);
  try {
    await mailer.send(template.subject, buildUpdateEmail(template.grades));
  } finally {
    mailer.close();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[FAIL] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  sampleGrades,
  templates,
};
