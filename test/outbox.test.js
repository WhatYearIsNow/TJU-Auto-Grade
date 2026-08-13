const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  NotificationOutbox,
  createNotificationId,
} = require('../lib/notification_outbox');

function createFixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tju-outbox-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'outbox.json');
  return { file, outbox: new NotificationOutbox(file, options) };
}

function event(id = 'event-1') {
  return {
    id,
    subject: '成绩更新',
    body: '<p>高等数学 80→90</p>',
    meta: { course: '高等数学' },
  };
}

test('outbox persists events and rejects duplicate IDs', (t) => {
  const { file, outbox } = createFixture(t);
  assert.equal(outbox.enqueue(event()), true);
  assert.equal(outbox.enqueue(event()), false);
  assert.deepEqual(outbox.stats(), {
    pending: 1,
    retrying: 0,
    sent: 0,
    nextDueAt: outbox.state.items[0].nextAttemptAt,
    lastSentAt: null,
  });

  const reloaded = new NotificationOutbox(file);
  assert.equal(reloaded.stats().pending, 1);
});

test('outbox marks successful delivery and does not resend it', async (t) => {
  const { file, outbox } = createFixture(t);
  outbox.enqueue(event());
  let deliveries = 0;

  const first = await outbox.process(async () => { deliveries++; return true; });
  const second = await outbox.process(async () => { deliveries++; return true; });

  assert.equal(first.delivered, 1);
  assert.equal(second.delivered, 0);
  assert.equal(deliveries, 1);
  assert.equal(new NotificationOutbox(file).stats().sent, 1);
});

test('outbox retries failures with exponential backoff', async (t) => {
  let clock = 1_700_000_000_000;
  const { outbox } = createFixture(t, {
    now: () => clock,
    baseRetryMs: 1000,
    maxRetryMs: 8000,
  });
  outbox.enqueue(event());
  let deliveries = 0;

  const failed = await outbox.process(async () => {
    deliveries++;
    throw new Error('SMTP unavailable');
  });
  assert.equal(failed.failed, 1);
  assert.equal(failed.retrying, 1);

  await outbox.process(async () => { deliveries++; return true; });
  assert.equal(deliveries, 1, 'must not retry before nextAttemptAt');

  clock += 1000;
  const retried = await outbox.process(async () => { deliveries++; return true; });
  assert.equal(retried.delivered, 1);
  assert.equal(deliveries, 2);
});

test('notification IDs are stable across object key order', () => {
  assert.equal(
    createNotificationId({ course: 'A', score: 90, details: { final: 92, daily: 88 } }),
    createNotificationId({ details: { daily: 88, final: 92 }, score: 90, course: 'A' }),
  );
});

test('expired sent IDs can be enqueued again after retention', async (t) => {
  let clock = 1_700_000_000_000;
  const { outbox } = createFixture(t, {
    now: () => clock,
    retentionMs: 1000,
  });
  outbox.enqueue(event());
  await outbox.process(async () => true);
  clock += 1001;

  assert.equal(outbox.enqueue(event()), true);
  assert.equal(outbox.stats().pending, 1);
  assert.equal(outbox.stats().sent, 0);
});
