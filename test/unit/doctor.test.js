const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { check } = require('../../scripts/doctor');

describe('doctor check', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-test-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('reports errors when EAMS_USERNAME missing', () => {
    fs.writeFileSync(path.join(tmpDir, 'eams.env'), 'EAMS_PASSWORD=abc\n');
    const result = check(tmpDir);
    assert.strictEqual(result.errors.length > 0, true);
    assert.ok(result.errors.some(e => e.includes('EAMS_USERNAME')));
  });

  it('reports errors when EAMS_PASSWORD missing', () => {
    fs.writeFileSync(path.join(tmpDir, 'eams.env'), 'EAMS_USERNAME=abc\n');
    const result = check(tmpDir);
    assert.strictEqual(result.errors.length > 0, true);
    assert.ok(result.errors.some(e => e.includes('EAMS_PASSWORD')));
  });

  it('warns when QQ_EMAIL not configured', () => {
    fs.writeFileSync(path.join(tmpDir, 'eams.env'), 'EAMS_USERNAME=abc\nEAMS_PASSWORD=abc\n');
    const result = check(tmpDir);
    assert.ok(result.warnings.some(w => w.includes('邮件通知')));
  });

  it('warns when COMMAND_EMAIL differs from NOTIFY_EMAIL', () => {
    fs.writeFileSync(path.join(tmpDir, 'eams.env'),
      'EAMS_USERNAME=abc\nEAMS_PASSWORD=abc\nQQ_EMAIL=test@qq.com\nQQ_SMTP_CODE=secret\nNOTIFY_EMAIL=notify@qq.com\nCOMMAND_EMAIL=cmd@qq.com\n'
    );
    const result = check(tmpDir);
    assert.ok(result.warnings.some(w => w.includes('COMMAND_EMAIL')));
  });

  it('warns about bak files', () => {
    fs.writeFileSync(path.join(tmpDir, 'eams.env'), 'EAMS_USERNAME=abc\nEAMS_PASSWORD=abc\n');
    fs.writeFileSync(path.join(tmpDir, 'eams.env.bak-20260921'), 'fake');
    const result = check(tmpDir);
    assert.ok(result.warnings.some(w => w.includes('eams.env.bak')));
  });
});
