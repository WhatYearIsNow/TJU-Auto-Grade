// 分步调试真登录
const path = require('path');
const { loadConfig } = require('../lib/config');
const { HttpEamsClient } = require('../lib/http_eams_client');
const { shutdown: ocrShutdown } = require('../lib/captcha_ocr');

const log = (...a) => console.error(`[${Date.now() % 100000}]`, ...a);

(async () => {
  const cfg = loadConfig(path.resolve(__dirname, '..'), process.env);
  log('env user:', process.env.EAMS_USERNAME);
  const cli = new HttpEamsClient(cfg, { env: process.env, log: (t, m) => log(`[${t}]`, m) });

  log('1. GET eamsEntry');
  const entry = await cli.request(cfg.eamsEntry);
  log('   final:', entry.url, 'status:', entry.status);
  const html = await entry.text();
  log('   html len:', html.length);

  const lt = (html.match(/id="lt"\s+[^>]*value="([^"]*)"/) || [])[1] || '';
  const execution = (html.match(/name="execution"\s+[^>]*value="([^"]*)"/) || [])[1] || '';
  log('   lt:', lt.slice(0, 20), 'execution:', execution);

  log('2. GET captcha');
  const cap = await cli.request(cfg.casCodeUrl);
  const buf = await cap.buffer();
  log('   bytes:', buf.length);

  log('3. OCR');
  const { recognizeCode } = require('../lib/captcha_ocr');
  const code = await recognizeCode(buf, cfg);
  log('   code:', code);

  log('4. POST login');
  const { strEnc } = require('../lib/tju_cas_des');
  const rsa = strEnc(process.env.EAMS_USERNAME + process.env.EAMS_PASSWORD + lt, '1', '2', '3');
  const form = new URLSearchParams();
  form.set('code', code); form.set('rsa', rsa);
  form.set('ul', String(process.env.EAMS_USERNAME.length));
  form.set('pl', String(process.env.EAMS_PASSWORD.length));
  form.set('lt', lt); form.set('execution', execution);
  form.set('_eventId', 'submit');
  const casUrl = entry.url;
  const post = await cli.request(casUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: casUrl, Origin: 'https://sso.tju.edu.cn' },
    body: form.toString(),
  });
  const postHtml = await post.text();
  log('   post final:', post.url, 'status:', post.status);
  log('   post html len:', postHtml.length);
  log('   still on cas:', post.url.includes('sso.tju.edu.cn/cas/login'));
  log('   has loginForm:', postHtml.includes('id="loginForm"'));
  fs = require('fs');
  fs.writeFileSync('debug_login_response.html', postHtml);

  log('5. extractGrades');
  const grades = await cli.extractGrades();
  log('   grades:', grades.length);
  for (const g of grades.slice(0, 5)) log('   ', g.courseName || JSON.stringify(g).slice(0, 100));

  await ocrShutdown();
})().catch(e => { console.error('FAIL', e); process.exit(3); });
