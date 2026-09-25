const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Notifier, SmtpChannel, QqChannel } = require('../../lib/notifier');

describe('SmtpChannel', () => {
  it('isConfigured when smtp config is complete', () => {
    const ch = new SmtpChannel({
      user: 'a@qq.com', pass: 'b', to: 'c@qq.com',
      host: 'smtp.qq.com', port: 465, secure: true,
    });
    assert.strictEqual(ch.isConfigured(), true);
  });

  it('is not configured when missing fields', () => {
    const ch = new SmtpChannel({ user: '', pass: '', to: '' });
    assert.strictEqual(ch.isConfigured(), false);
  });
});

describe('QqChannel', () => {
  it('isConfigured when targetUser and napcatUrl are set', () => {
    const ch = new QqChannel({
      napcatUrl: 'http://127.0.0.1:3002/send_private_msg',
      napcatToken: 'test',
      qqTargetUser: '123456',
    });
    assert.strictEqual(ch.isConfigured(), true);
  });

  it('is not configured when missing fields', () => {
    const ch = new QqChannel({ qqTargetUser: '' });
    assert.strictEqual(ch.isConfigured(), false);
  });

  it('send returns false when NapCat is unreachable', async () => {
    const ch = new QqChannel({
      napcatUrl: 'http://127.0.0.1:1/send_private_msg',
      napcatToken: 'test',
      qqTargetUser: '123456',
    });
    const result = await ch.send('test', 'body');
    assert.strictEqual(result, false);
  });
});

describe('Notifier', () => {
  it('isConfigured when SMTP is available', () => {
    const n = new Notifier({
      smtp: { user: 'a@qq.com', pass: 'b', to: 'c@qq.com', host: 'smtp.qq.com', port: 465, secure: true },
    });
    assert.strictEqual(n.isConfigured(), true);
    assert.strictEqual(n.primaryAvailable(), true);
  });

  it('is not configured with empty config', () => {
    const n = new Notifier({});
    assert.strictEqual(n.isConfigured(), false);
    assert.strictEqual(n.primaryAvailable(), undefined);
  });

  it('has two channels when SMTP + QQ configured', () => {
    const n = new Notifier({
      smtp: { user: 'a@qq.com', pass: 'b', to: 'c@qq.com', host: 'smtp.qq.com', port: 465, secure: true },
      napcatUrl: 'http://127.0.0.1:3002/send_private_msg',
      napcatToken: 'test',
      qqTargetUser: '123456',
    });
    assert.strictEqual(n.channels.length, 2);
  });

  it('health returns channel status', () => {
    const n = new Notifier({
      smtp: { user: 'a@qq.com', pass: 'b', to: 'c@qq.com', host: 'smtp.qq.com', port: 465, secure: true },
    });
    const health = n.health();
    assert.strictEqual(health.length, 1);
    assert.strictEqual(health[0].name, 'smtp');
    assert.strictEqual(health[0].configured, true);
  });

  it('send returns false when no channel available', async () => {
    const n = new Notifier({});
    const result = await n.send('test', 'body');
    assert.strictEqual(result, false);
  });

  it('close does not throw', () => {
    const n = new Notifier({});
    n.close(); // should not throw
  });
});
