const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createConfig } = require('../lib/config');
const { DashboardApplication } = require('../lib/dashboard');
const {
  DashboardServer,
  publicSettings,
  setupStatus,
  updateEnvFile,
} = require('../lib/dashboard_server');

function createFixture(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tju-dashboard-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  return rootDir;
}

function fakeController() {
  const calls = [];
  return {
    calls,
    monitor: null,
    snapshot: () => ({ phase: 'running', error: null, monitor: { state: { gradeCount: 2 } } }),
    notifications: () => [],
    setConfig: () => { calls.push('set-config'); },
    start: () => { calls.push('start'); return { phase: 'starting' }; },
    stop: async () => { calls.push('stop'); return { phase: 'stopped' }; },
    restart: async () => { calls.push('restart'); return { phase: 'starting' }; },
    checkNow: async () => { calls.push('check'); return { checked: true }; },
    retryNotifications: async () => { calls.push('retry-notifications'); return { delivered: 0 }; },
    queryWeightedGrades: async () => { calls.push('weighted'); return { summary: ['平均绩点 3.8'], tableGrades: [] }; },
    listSemesters: async () => {
      calls.push('semesters');
      return [{ id: '117', label: '2025-2026 2', current: true }];
    },
    querySemesterGrades: async semesterId => {
      calls.push(`semester:${semesterId}`);
      return [{ '课程名称': '历史课程', '总评成绩': 90 }];
    },
    sendTestEmail: async () => { calls.push('test-email'); return true; },
  };
}

test('dashboard serves the UI and protects mutation endpoints', async t => {
  const rootDir = createFixture(t);
  const config = createConfig(rootDir, {});
  const controller = fakeController();
  const server = new DashboardServer(config, controller, {
    port: 0,
    token: 'test-token',
    webDir: path.join(__dirname, '..', 'web'),
    env: {},
    baseEnv: {},
  });
  await server.start();
  t.after(() => server.stop());

  const page = await fetch(server.url);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(page.headers.get('content-security-policy'), /'nonce-[^']+'/);
  assert.match(html, /content="test-token"/);
  assert.doesNotMatch(html, /__DASHBOARD_TOKEN__/);
  assert.doesNotMatch(html, /__DASHBOARD_NONCE__/);
  assert.doesNotMatch(html, /href="\/styles\.css"/);
  assert.doesNotMatch(html, /src="\/app\.js"/);
  assert.match(html, /<style nonce="[^"]+">/);
  assert.match(html, /<script nonce="[^"]+">/);
  assert.match(html, /tju-auto-grade:\/\/start/);

  const ready = await fetch(`${server.url}/launcher-ready`, {
    headers: { Origin: 'null' },
  });
  assert.equal(ready.status, 200);
  assert.equal(ready.headers.get('access-control-allow-origin'), 'null');

  const semesters = await fetch(`${server.url}/api/semesters`).then(response => response.json());
  assert.equal(semesters.data[0].id, '117');

  const denied = await fetch(`${server.url}/api/actions/check`, { method: 'POST' });
  assert.equal(denied.status, 403);

  const allowed = await fetch(`${server.url}/api/actions/check`, {
    method: 'POST',
    headers: {
      Origin: server.url,
      'Content-Type': 'application/json',
      'X-TJU-Dashboard-Token': 'test-token',
    },
    body: '{}',
  });
  assert.equal(allowed.status, 200);
  assert.deepEqual(controller.calls, ['semesters', 'check']);

  for (const action of ['start', 'stop', 'restart', 'retry-notifications', 'weighted', 'test-email']) {
    const response = await fetch(`${server.url}/api/actions/${action}`, {
      method: 'POST',
      headers: {
        Origin: server.url,
        'Content-Type': 'application/json',
        'X-TJU-Dashboard-Token': 'test-token',
      },
      body: '{}',
    });
    assert.equal(response.status, 200, action);
  }
  assert.deepEqual(controller.calls, [
    'semesters', 'check', 'start', 'stop', 'restart', 'retry-notifications', 'weighted', 'test-email',
  ]);

  const semesterGrades = await fetch(`${server.url}/api/actions/semester-grades`, {
    method: 'POST',
    headers: {
      Origin: server.url,
      'Content-Type': 'application/json',
      'X-TJU-Dashboard-Token': 'test-token',
    },
    body: JSON.stringify({ semesterId: '96' }),
  }).then(response => response.json());
  assert.equal(semesterGrades.data.semesterId, '96');
  assert.equal(semesterGrades.data.grades[0]['课程名称'], '历史课程');
  assert.equal(controller.calls.at(-1), 'semester:96');
});

test('updateEnvFile preserves comments and ignores blank secret fields', t => {
  const rootDir = createFixture(t);
  const file = path.join(rootDir, 'eams.env');
  fs.writeFileSync(file, '# existing comment\nEAMS_USERNAME=old\nEAMS_PASSWORD=secret\n', 'utf-8');

  updateEnvFile(file, {
    EAMS_USERNAME: 'new-user',
    EAMS_PASSWORD: '',
    CHECK_INTERVAL_MINUTES: '10',
  });
  const content = fs.readFileSync(file, 'utf-8');
  assert.match(content, /^# existing comment/m);
  assert.match(content, /^EAMS_USERNAME=new-user$/m);
  assert.match(content, /^EAMS_PASSWORD=secret$/m);
  assert.match(content, /^CHECK_INTERVAL_MINUTES=10$/m);
});

test('updateEnvFile rejects unsafe and unknown values', t => {
  const file = path.join(createFixture(t), 'eams.env');
  assert.throws(() => updateEnvFile(file, { UNKNOWN_KEY: 'value' }), /不允许修改/);
  assert.throws(() => updateEnvFile(file, { EAMS_USERNAME: 'name\ninjected=true' }), /不能包含换行/);
  assert.throws(() => updateEnvFile(file, { QQ_EMAIL: 'not-an-email' }), /邮箱格式/);
  assert.throws(() => updateEnvFile(file, { SMTP_PORT: '70000' }), /1 到 65535/);
  assert.throws(() => updateEnvFile(file, { BROWSER_CHANNEL: 'unknown' }), /不受支持/);
  assert.throws(() => updateEnvFile(file, { VISION_MODEL: 'bad model name' }), /格式不正确/);
});

test('fresh settings expose reproducible defaults and setup readiness', () => {
  const settings = publicSettings({});
  assert.equal(settings.values.CHECK_INTERVAL_MINUTES, '5');
  assert.equal(settings.values.VISION_MODEL, 'qwen3.5-ocr');
  assert.equal(settings.values.SMTP_HOST, 'smtp.qq.com');
  assert.equal(settings.values.IMAP_SOCKET_TIMEOUT_SECONDS, '600');
  assert.equal(settings.setup.complete, false);
  assert.deepEqual(settings.setup.missing, ['EAMS_USERNAME', 'EAMS_PASSWORD']);

  const ready = setupStatus({ EAMS_USERNAME: '3025000000', EAMS_PASSWORD: 'secret' });
  assert.equal(ready.complete, true);
  assert.equal(ready.steps.mail.ready, false);
});

test('settings save starts only after required credentials are complete', async t => {
  const rootDir = createFixture(t);
  const controller = fakeController();
  const server = new DashboardServer(createConfig(rootDir, {}), controller, {
    port: 0,
    token: 'test-token',
    webDir: path.join(__dirname, '..', 'web'),
    env: {},
    baseEnv: {},
  });
  await server.start();
  t.after(() => server.stop());
  const save = settings => fetch(`${server.url}/api/settings`, {
    method: 'POST',
    headers: {
      Origin: server.url,
      'Content-Type': 'application/json',
      'X-TJU-Dashboard-Token': 'test-token',
    },
    body: JSON.stringify({ settings }),
  }).then(response => response.json());

  const incomplete = await save({ EAMS_USERNAME: '3025000000' });
  assert.equal(incomplete.data.setup.complete, false);
  assert.deepEqual(controller.calls, ['stop', 'set-config']);

  const complete = await save({ EAMS_USERNAME: '3025000000', EAMS_PASSWORD: 'secret' });
  assert.equal(complete.data.setup.complete, true);
  assert.equal(controller.calls.at(-1), 'restart');
  const saved = fs.readFileSync(path.join(rootDir, 'eams.env'), 'utf-8');
  assert.match(saved, /^EAMS_PASSWORD=secret$/m);
});

test('dashboard application waits for first-time setup before starting monitor', async t => {
  const rootDir = createFixture(t);
  let starts = 0;
  const createApplication = () => new DashboardApplication(rootDir, {
    autoOpen: false,
    baseEnv: {},
    controller: {
      start: () => { starts++; },
      stop: async () => {},
    },
    server: {
      start: async () => 'http://127.0.0.1:3765',
      stop: async () => {},
    },
    guard: {
      acquire: () => {},
      beat: () => {},
      release: () => {},
    },
  });

  const emptyApplication = createApplication();
  await emptyApplication.start();
  assert.equal(starts, 0);
  await emptyApplication.stop();

  fs.writeFileSync(path.join(rootDir, 'eams.env'), 'EAMS_USERNAME=3025000000\nEAMS_PASSWORD=secret\n', 'utf-8');
  const configuredApplication = createApplication();
  await configuredApplication.start();
  assert.equal(starts, 1);
  await configuredApplication.stop();
});
