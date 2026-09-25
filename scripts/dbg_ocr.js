// 分步调试：只测 OCR 加载和识别
const path = require('path');
const fs = require('fs');
const { recognizeCode, shutdown } = require('../lib/captcha_ocr');

(async () => {
  console.error('start OCR test');
  const buf = fs.readFileSync(path.join(__dirname, '..', 'debug_captcha.jpeg'));
  console.error('read buffer', buf.length);
  const cfg = { tessdataDir: path.join(__dirname, '..', 'tessdata'), captchaScale: 2, captchaThreshold: 80, captchaPreprocess: 'gray' };
  console.error('calling recognizeCode...');
  const t = Date.now();
  const r = await recognizeCode(buf, cfg);
  console.error('result:', r, 'ms:', Date.now() - t);
  await shutdown();
})().catch(e => { console.error('ERR', e); process.exit(1); });
