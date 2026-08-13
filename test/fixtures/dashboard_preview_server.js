const fs = require('fs');
const os = require('os');
const path = require('path');
const { createConfig } = require('../../lib/config');
const { DashboardServer } = require('../../lib/dashboard_server');

const projectRoot = path.resolve(__dirname, '..', '..');
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tju-dashboard-preview-'));
const port = Number(process.env.DASHBOARD_PREVIEW_PORT || 38765);
const emptyConfig = process.env.DASHBOARD_EMPTY_CONFIG === 'true';
const configuredEnv = {
  EAMS_USERNAME: '3025000000',
  EAMS_PASSWORD: 'configured',
  QQ_EMAIL: 'student@qq.com',
  QQ_SMTP_CODE: 'configured',
  NOTIFY_EMAIL: 'student@qq.com',
  COMMAND_EMAIL: 'student@qq.com',
  COMMAND_TOKEN: 'configured',
  DASHSCOPE_API_KEY: 'configured',
  VISION_MODEL: 'qwen3.5-ocr',
  CHECK_INTERVAL_MINUTES: '5',
  RELOGIN_TIMEOUT_MINUTES: '10',
  BROWSER_CHANNEL: 'msedge',
  HEADLESS: 'false',
  IMAP_ENABLED: 'true',
  IMAP_INTERVAL_SECONDS: '60',
};
const env = emptyConfig ? {} : configuredEnv;
if (!emptyConfig) fs.writeFileSync(
  path.join(rootDir, 'eams.env'),
  `${Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n')}\n`,
  'utf-8',
);
const config = createConfig(rootDir, env);
fs.writeFileSync(config.logFile, '[2026/8/9 08:00:00] [INFO] 隔离环境日志读取正常\n', 'utf-8');
const grades = [
  { '学年学期': '2025-2026-2', '课程代码': 'CS101', '课程名称': '数据结构', '教学班': '01', '学分': 4, '总评成绩': 94, '绩点': 4, '平时成绩': 92, '期末成绩': 95 },
  { '学年学期': '2025-2026-2', '课程代码': 'MATH201', '课程名称': '概率论与数理统计', '教学班': '02', '学分': 3, '总评成绩': 88, '绩点': 3.7 },
  { '学年学期': '2025-2026-1', '课程代码': 'EE110', '课程名称': '电路基础', '教学班': '03', '学分': 3, '总评成绩': 91, '绩点': 4 },
  { '学年学期': '2025-2026-1', '课程代码': 'ENG102', '课程名称': '大学英语', '教学班': '06', '学分': 2, '总评成绩': 85, '绩点': 3.7 },
];
const historicalGrades = [
  { '学年学期': '2024-2025-1', '课程代码': 'HIST101', '课程名称': '历史学期课程一', '学分': 3, '总评成绩': 90, '绩点': 4 },
  { '学年学期': '2024-2025-1', '课程代码': 'HIST102', '课程名称': '历史学期课程二', '学分': 2, '总评成绩': 82, '绩点': 3.3 },
];
const notifications = [
  { id: '1', subject: '出分啦！来自数据结构的好消息哦！', meta: { course: '数据结构', semester: '2025-2026-2', change: 'new' }, status: 'sent', attempts: 0, createdAt: new Date(Date.now() - 60000).toISOString(), sentAt: new Date().toISOString() },
  { id: '2', subject: '请查看概率论与数理统计的成绩', meta: { course: '概率论与数理统计', semester: '2025-2026-2', change: 'updated' }, status: 'pending', attempts: 1, createdAt: new Date(Date.now() - 120000).toISOString(), lastError: 'SMTP 临时不可用' },
];

let phase = emptyConfig ? 'stopped' : 'running';
const controller = {
  monitor: { state: { latestGrades: grades } },
  snapshot: () => ({
    phase,
    error: null,
    monitor: {
      running: true,
      sessionRecovering: false,
      checkInProgress: false,
      state: {
        startTime: new Date(Date.now() - 2 * 60 * 60 * 1000),
        lastCheck: new Date(Date.now() - 45000),
        lastResult: 'nochange',
        lastChange: new Date(Date.now() - 10 * 60 * 1000).toLocaleString('zh-CN', { hour12: false }),
        failCount: 0,
        gradeCount: grades.length,
        latestGrades: grades,
        outboxPending: 1,
        outboxRetrying: 1,
        lastDelivery: new Date().toLocaleString('zh-CN', { hour12: false }),
      },
    },
  }),
  notifications: () => notifications,
  setConfig: () => {},
  start: () => { phase = 'running'; return { phase }; },
  stop: async () => ({ phase: 'stopped' }),
  restart: async () => { phase = 'running'; return { phase }; },
  checkNow: async () => ({ checked: true }),
  retryNotifications: async () => ({ delivered: 1 }),
  queryWeightedGrades: async () => ({
    summary: ['平均成绩：89.5', '平均绩点：3.82', '已修学分：68'],
    tableGrades: [['学期', '课程数', '平均成绩'], ['2025-2026-2', '2', '91.0']],
  }),
  listSemesters: async () => [
    { id: '117', label: '2025-2026 2', current: true },
    { id: '116', label: '2025-2026 1', current: false },
    { id: '115', label: '2024-2025 2', current: false },
    { id: '114', label: '2024-2025 1', current: false },
    { id: '95', label: '2023-2024 2', current: false },
    { id: '94', label: '2023-2024 1', current: false },
    { id: '77', label: '2022-2023 2', current: false },
    { id: '76', label: '2022-2023 1', current: false },
    { id: '75', label: '2021-2022 2', current: false },
    { id: '74', label: '2021-2022 1', current: false },
  ],
  querySemesterGrades: async semesterId => semesterId === '114' ? historicalGrades : grades,
  sendTestEmail: async () => true,
};

const server = new DashboardServer(config, controller, {
  port,
  token: 'preview-token',
  env,
  baseEnv: {},
  webDir: path.join(projectRoot, 'web'),
});

server.start().then(url => console.log(`Preview server: ${url}`));

async function shutdown() {
  await server.stop();
  fs.rmSync(rootDir, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
