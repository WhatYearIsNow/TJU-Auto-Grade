const test = require('node:test');
const assert = require('node:assert/strict');
const { MonitorController } = require('../lib/monitor_controller');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('MonitorController exposes a non-blocking startup phase', async () => {
  const gate = deferred();
  const monitor = {
    start: () => gate.promise,
    stop: async () => {},
    getSnapshot: () => ({ running: false, state: {} }),
  };
  const controller = new MonitorController({}, { createMonitor: () => monitor });

  const snapshot = controller.start();
  assert.equal(snapshot.phase, 'starting');
  gate.resolve();
  await controller.startPromise;
  assert.equal(controller.snapshot().phase, 'running');
});

test('MonitorController keeps the dashboard alive when monitor startup fails', async () => {
  const monitor = {
    start: async () => { throw new Error('登录失败'); },
    stop: async () => {},
    getSnapshot: () => ({ running: false, state: {} }),
  };
  const controller = new MonitorController({}, { createMonitor: () => monitor });

  controller.start();
  await controller.startPromise;
  assert.equal(controller.snapshot().phase, 'error');
  assert.equal(controller.snapshot().error, '登录失败');
});
