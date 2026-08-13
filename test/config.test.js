const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createConfig, loadEnv, parseEnv } = require('../lib/config');

test('parseEnv supports comments, equals signs, and quoted values', () => {
  assert.deepEqual(parseEnv([
    '# comment',
    'USER=alice',
    'TOKEN="a=b=c"',
    "LABEL='中文值'",
  ].join('\n')), {
    USER: 'alice',
    TOKEN: 'a=b=c',
    LABEL: '中文值',
  });
});

test('loadEnv does not overwrite explicit environment values', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tju-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'eams.env');
  fs.writeFileSync(file, 'KEEP=file\nADD=new\n', 'utf-8');
  const target = { KEEP: 'runtime' };

  loadEnv(file, target);
  assert.deepEqual(target, { KEEP: 'runtime', ADD: 'new' });
});

test('createConfig clamps intervals and resolves runtime files', () => {
  const config = createConfig('D:\\demo', {
    CHECK_INTERVAL_MINUTES: '0',
    SMTP_PORT: '587',
    SMTP_SECURE: 'false',
  });
  assert.equal(config.checkIntervalMs, 60_000);
  assert.equal(config.smtp.port, 587);
  assert.equal(config.smtp.secure, false);
  assert.equal(config.pidFile, path.resolve('D:\\demo', '.eams_pid'));
});
