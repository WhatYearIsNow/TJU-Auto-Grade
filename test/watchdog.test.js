const test = require('node:test');
const assert = require('node:assert/strict');
const { Watchdog } = require('../watchdog');

function config(overrides = {}) {
  return {
    rootDir: 'D:\\demo',
    mainScript: 'D:\\demo\\eams_grade_checker_v2.js',
    pidFile: 'D:\\demo\\.eams_pid',
    heartbeatFile: 'D:\\demo\\.eams_heartbeat',
    watchdogHeartbeatMaxAgeMs: 60_000,
    watchdogIntervalMs: 300_000,
    watchdogAutoRestart: true,
    smtp: {},
    ...overrides,
  };
}

function fakeMailer(messages) {
  return {
    async send(subject, body) { messages.push({ subject, body }); return true; },
    close() {},
  };
}

test('watchdog restarts a stopped process and confirms its heartbeat', async () => {
  const health = [
    { status: 'stopped', pid: null, heartbeatAgeMs: null },
    { status: 'healthy', pid: 42, heartbeatAgeMs: 100 },
  ];
  const messages = [];
  let starts = 0;
  const watchdog = new Watchdog(config(), {
    inspect: () => health.shift(),
    startProcess: async () => { starts++; return 42; },
    sleep: async () => {},
    mailer: fakeMailer(messages),
  });

  const result = await watchdog.check();
  assert.equal(result.status, 'healthy');
  assert.equal(starts, 1);
  assert.equal(messages[0].subject, '监控已自动重启');
});

test('watchdog never kills or restarts a live process with stale heartbeat', async () => {
  const messages = [];
  let starts = 0;
  const watchdog = new Watchdog(config(), {
    inspect: () => ({ status: 'stale', pid: 42, heartbeatAgeMs: 180_000 }),
    startProcess: async () => { starts++; },
    mailer: fakeMailer(messages),
  });

  await watchdog.check();
  await watchdog.check();
  assert.equal(starts, 0);
  assert.equal(messages.length, 1, '同一故障状态只报警一次');
  assert.match(messages[0].body, /未强制终止/);
});
