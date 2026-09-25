const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  ErrorCode,
  EamsError,
  TransportError,
  AuthError,
  ServerError,
  EmptyDataError,
  classifyError,
} = require('../../lib/errors');

describe('ErrorCode', () => {
  it('should have all four categories', () => {
    assert.deepStrictEqual(Object.keys(ErrorCode), ['TRANSPORT', 'AUTH', 'SERVER', 'EMPTY']);
  });
});

describe('classifyError', () => {
  it('classifies EAMS 500 error page as SERVER', () => {
    const err = classifyError(new Error('出错了 Error happened CannotCreateTransactionException'));
    assert.strictEqual(err.code, ErrorCode.SERVER);
    assert.strictEqual(err.alert, true);
    assert.strictEqual(err.retryable, true);
  });

  it('classifies fetch failed as TRANSPORT', () => {
    const err = classifyError(new Error('fetch failed'));
    assert.strictEqual(err.code, ErrorCode.TRANSPORT);
    assert.strictEqual(err.retryable, true);
  });

  it('classifies "未抓到成绩" as EMPTY', () => {
    const err = classifyError(new Error('未抓到成绩'));
    assert.strictEqual(err.code, ErrorCode.EMPTY);
    assert.strictEqual(err.retryable, false);
    assert.strictEqual(err.alert, false);
    assert.strictEqual(err.failCount, false);
  });

  it('classifies "登录失败" as AUTH', () => {
    const err = classifyError(new Error('登录失败'));
    assert.strictEqual(err.code, ErrorCode.AUTH);
    assert.strictEqual(err.retryable, true);
  });

  it('classifies unknown errors as TRANSPORT (conservative)', () => {
    const err = classifyError(new Error('some random error'));
    assert.strictEqual(err.code, ErrorCode.TRANSPORT);
  });

  it('handles ECONNREFUSED as TRANSPORT', () => {
    const err = classifyError(new Error('connect ECONNREFUSED'));
    assert.strictEqual(err.code, ErrorCode.TRANSPORT);
  });

  it('handles Spring exception as SERVER', () => {
    const err = classifyError(new Error('org.springframework.transaction.CannotCreateTransactionException'));
    assert.strictEqual(err.code, ErrorCode.SERVER);
  });

  it('handles JDBC begin transaction failed as SERVER', () => {
    const err = classifyError(new Error('JDBC begin transaction failed'));
    assert.strictEqual(err.code, ErrorCode.SERVER);
  });
});

describe('EamsError subclasses', () => {
  it('ServerError defaults alert=true', () => {
    const err = new ServerError('db down');
    assert.strictEqual(err.name, 'ServerError');
    assert.strictEqual(err.code, ErrorCode.SERVER);
    assert.strictEqual(err.alert, true);
  });

  it('EmptyDataError defaults failCount=false', () => {
    const err = new EmptyDataError('no grades');
    assert.strictEqual(err.name, 'EmptyDataError');
    assert.strictEqual(err.code, ErrorCode.EMPTY);
    assert.strictEqual(err.failCount, false);
    assert.strictEqual(err.retryable, false);
  });

  it('TransportError defaults retryable=true', () => {
    const err = new TransportError('timeout');
    assert.strictEqual(err.name, 'TransportError');
    assert.strictEqual(err.code, ErrorCode.TRANSPORT);
    assert.strictEqual(err.retryable, true);
  });

  it('AuthError defaults retryable=true', () => {
    const err = new AuthError('captcha wrong');
    assert.strictEqual(err.name, 'AuthError');
    assert.strictEqual(err.code, ErrorCode.AUTH);
    assert.strictEqual(err.retryable, true);
  });
});
