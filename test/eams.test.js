const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { EamsClient, normalizeSemesterOptions } = require('../lib/eams');

test('semester options keep valid unique EAMS identifiers', () => {
  assert.deepEqual(normalizeSemesterOptions([
    { id: '117', label: '2025-2026 2', current: true },
    { id: '96', label: '2024-2025 1' },
    { id: '117', label: '重复项' },
    { id: 'all', label: '全部' },
  ]), [
    { id: '117', label: '2025-2026 2', current: true },
    { id: '96', label: '2024-2025 1', current: false },
  ]);
});

test('AI captcha child process receives the loaded dashboard environment', async () => {
  const calls = [];
  const env = {
    PATH: process.env.PATH,
    EAMS_USERNAME: 'student',
    EAMS_PASSWORD: 'password',
    DASHSCOPE_API_KEY: 'configured-key',
    VISION_MODEL: 'qwen3.5-ocr',
  };
  const page = {
    waitForSelector: async () => true,
    waitForTimeout: async () => {},
    $: async () => ({ screenshot: async () => {} }),
  };
  const client = new EamsClient(page, { rootDir: path.resolve(__dirname, '..') }, {
    env,
    execFile: (file, args, options, callback) => {
      calls.push({ file, args, options });
      callback(new Error('mock vision failure'));
    },
  });

  assert.equal(await client.autoLogin(), false);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.env.DASHSCOPE_API_KEY, 'configured-key');
  assert.equal(calls[0].options.env.VISION_MODEL, 'qwen3.5-ocr');
  assert.equal(calls[0].options.timeout, 15_000);
});
