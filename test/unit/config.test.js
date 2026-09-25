const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createConfig, parseEnv, envBoolean, envNumber } = require('../../lib/config');

describe('parseEnv', () => {
  it('parses key=value pairs', () => {
    const result = parseEnv('FOO=bar\nBAZ=qux');
    assert.strictEqual(result.FOO, 'bar');
    assert.strictEqual(result.BAZ, 'qux');
  });

  it('skips comments and blank lines', () => {
    const result = parseEnv('# comment\n\nFOO=bar');
    assert.strictEqual(result.FOO, 'bar');
    assert.strictEqual(result.BAZ, undefined);
  });

  it('strips surrounding quotes', () => {
    const result = parseEnv('FOO="bar"\nBAZ=\'qux\'');
    assert.strictEqual(result.FOO, 'bar');
    assert.strictEqual(result.BAZ, 'qux');
  });
});

describe('envBoolean', () => {
  it('returns true for truthy values', () => {
    assert.strictEqual(envBoolean({ X: '1' }, 'X'), true);
    assert.strictEqual(envBoolean({ X: 'true' }, 'X'), true);
    assert.strictEqual(envBoolean({ X: 'yes' }, 'X'), true);
    assert.strictEqual(envBoolean({ X: 'on' }, 'X'), true);
  });

  it('returns false for falsy values', () => {
    assert.strictEqual(envBoolean({ X: '0' }, 'X'), false);
    assert.strictEqual(envBoolean({ X: 'false' }, 'X'), false);
    assert.strictEqual(envBoolean({ X: '' }, 'X'), false);
    assert.strictEqual(envBoolean({}, 'X'), false);
  });
});

describe('envNumber', () => {
  it('returns fallback for non-numeric', () => {
    assert.strictEqual(envNumber({}, 'X', 42), 42);
    assert.strictEqual(envNumber({ X: 'abc' }, 'X', 42), 42);
  });

  it('clamps to min/max', () => {
    // value=0, min=1 -> max(1, 0) = 1
    assert.strictEqual(envNumber({ X: '0' }, 'X', 10, 1, 100), 1);
    // value=200, max=100 -> min(100, 200) = 100
    assert.strictEqual(envNumber({ X: '200' }, 'X', 10, 1, 100), 100);
    // value=50 -> stays 50
    assert.strictEqual(envNumber({ X: '50' }, 'X', 10, 1, 100), 50);
  });
});

describe('createConfig', () => {
  it('returns a frozen object', () => {
    const cfg = createConfig('/tmp/test-root', {});
    assert.strictEqual(Object.isFrozen(cfg), true);
    // 赋值属性会被静默忽略（非严格模式）或抛 TypeError（严格模式）
    assert.throws(() => {
      'use strict';
      cfg.foo = 'bar';
    }, TypeError);
  });

  it('has default transport=http', () => {
    const cfg = createConfig('/tmp/test-root', {});
    assert.strictEqual(cfg.transport, 'http');
  });

  it('uses browser transport when configured', () => {
    const cfg = createConfig('/tmp/test-root', { EAMS_TRANSPORT: 'browser' });
    assert.strictEqual(cfg.transport, 'browser');
  });

  it('has default smtp config', () => {
    const cfg = createConfig('/tmp/test-root', {});
    assert.strictEqual(cfg.smtp.host, 'smtp.qq.com');
    assert.strictEqual(cfg.smtp.port, 465);
    assert.strictEqual(cfg.smtp.secure, true);
    assert.strictEqual(cfg.smtp.user, '');
    assert.strictEqual(cfg.smtp.pass, '');
    assert.strictEqual(cfg.smtp.to, '');
  });

  it('reads smtp from QQ_EMAIL / QQ_SMTP_CODE', () => {
    const cfg = createConfig('/tmp/test-root', {
      QQ_EMAIL: 'test@qq.com',
      QQ_SMTP_CODE: 'secret',
      NOTIFY_EMAIL: 'recv@qq.com',
    });
    assert.strictEqual(cfg.smtp.user, 'test@qq.com');
    assert.strictEqual(cfg.smtp.pass, 'secret');
    assert.strictEqual(cfg.smtp.to, 'recv@qq.com');
  });

  it('has default check interval 5 minutes', () => {
    const cfg = createConfig('/tmp/test-root', {});
    assert.strictEqual(cfg.checkIntervalMs, 5 * 60 * 1000);
  });

  it('has default outbox retention 30 days', () => {
    const cfg = createConfig('/tmp/test-root', {});
    assert.strictEqual(cfg.outboxRetentionMs, 30 * 24 * 60 * 60 * 1000);
  });

  it('has napcat config defaults', () => {
    const cfg = createConfig('/tmp/test-root', {});
    assert.strictEqual(cfg.napcatUrl, 'http://127.0.0.1:3002/send_private_msg');
    assert.strictEqual(cfg.napcatToken, '');
    assert.strictEqual(cfg.qqTargetUser, '');
  });
});
