const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  stableStringify,
  createNotificationId,
  NotificationOutbox,
} = require('../../lib/notification_outbox');

describe('stableStringify', () => {
  it('produces deterministic output for objects', () => {
    const a = { b: 1, c: 2 };
    const b = { c: 2, b: 1 };
    assert.strictEqual(stableStringify(a), stableStringify(b));
  });

  it('handles arrays', () => {
    assert.strictEqual(stableStringify([1, 2, 3]), '[1,2,3]');
  });

  it('handles primitives', () => {
    assert.strictEqual(stableStringify(null), 'null');
    assert.strictEqual(stableStringify('hello'), '"hello"');
    assert.strictEqual(stableStringify(42), '42');
  });
});

describe('createNotificationId', () => {
  it('produces consistent SHA-256 hash', () => {
    const event = { id: 'test-1', subject: 'test', body: 'body' };
    const id1 = createNotificationId(event);
    const id2 = createNotificationId(event);
    assert.strictEqual(id1, id2);
    assert.strictEqual(id1.length, 64); // SHA-256 hex length
  });
});

describe('NotificationOutbox', () => {
  // Each test gets a unique tmp file to avoid parallel test interference
  function makeFile(name) {
    return '/tmp/test_ob_' + process.pid + '_' + name + '_' + Date.now() + '.json';
  }

  it('enqueues a single event', () => {
    const ob = new NotificationOutbox(makeFile('enq'), { now: () => 1000 });
    const added = ob.enqueue({ id: 'evt-1', subject: 'test', body: 'body' });
    assert.strictEqual(added, true);
    assert.strictEqual(ob.state.items.length, 1);
    assert.strictEqual(ob.state.items[0].status, 'pending');
  });

  it('deduplicates by id', () => {
    const ob = new NotificationOutbox(makeFile('dup'), { now: () => 1000 });
    ob.enqueue({ id: 'evt-1', subject: 'test', body: 'body' });
    const added = ob.enqueue({ id: 'evt-1', subject: 'test2', body: 'body2' });
    assert.strictEqual(added, false);
    assert.strictEqual(ob.state.items.length, 1);
  });

  it('process sends successful items', async () => {
    const ob = new NotificationOutbox(makeFile('ok'), { now: () => 1000 });
    ob.enqueue({ id: 'evt-1', subject: 'test', body: 'body' });
    let sent = 0;
    const result = await ob.process(async (item) => {
      sent++;
      return true;
    });
    assert.strictEqual(sent, 1);
    assert.strictEqual(ob.state.items[0].status, 'sent');
  });

  it('process retries failed items', async () => {
    const ob = new NotificationOutbox(makeFile('fail'), { now: () => 1000 });
    ob.enqueue({ id: 'evt-1', subject: 'test', body: 'body' });
    let attempts = 0;
    await ob.process(async (item) => {
      attempts++;
      throw new Error('fail');
    });
    assert.strictEqual(attempts, 1);
    assert.strictEqual(ob.state.items[0].status, 'pending');
    assert.strictEqual(ob.state.items[0].attempts, 1);
  });

  it('treats false return as failure', async () => {
    const ob = new NotificationOutbox(makeFile('false'), { now: () => 1000 });
    ob.enqueue({ id: 'evt-1', subject: 'test', body: 'body' });
    let called = 0;
    await ob.process(async (item) => {
      called++;
      return false;
    });
    assert.strictEqual(called, 1);
    assert.strictEqual(ob.state.items[0].status, 'pending');
    assert.strictEqual(ob.state.items[0].attempts, 1);
  });

  it('stats returns correct counts', () => {
    const ob = new NotificationOutbox(makeFile('stats'), { now: () => 1000 });
    ob.enqueue({ id: 'evt-1', subject: 'test', body: 'body' });
    ob.enqueue({ id: 'evt-2', subject: 'test2', body: 'body2' });
    const stats = ob.stats();
    assert.strictEqual(stats.pending, 2);
    assert.strictEqual(stats.sent, 0);
  });

  it('enqueueMany adds multiple events', () => {
    const ob = new NotificationOutbox(makeFile('many'), { now: () => 1000 });
    const added = ob.enqueueMany([
      { id: 'evt-1', subject: 'test', body: 'body' },
      { id: 'evt-2', subject: 'test2', body: 'body2' },
    ]);
    assert.strictEqual(added, 2);
    assert.strictEqual(ob.state.items.length, 2);
  });
});
