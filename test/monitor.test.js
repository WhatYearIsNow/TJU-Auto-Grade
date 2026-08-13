const test = require('node:test');
const assert = require('node:assert/strict');
const { AsyncLock } = require('../lib/monitor');

test('AsyncLock serializes browser operations in arrival order', async () => {
  const lock = new AsyncLock();
  const events = [];
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });

  const first = lock.run(async () => {
    events.push('first:start');
    await firstGate;
    events.push('first:end');
  });
  const second = lock.run(async () => {
    events.push('second:start');
    events.push('second:end');
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['first:start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start', 'second:end']);
});
