// 无凭据冒烟：只验证 CAS 登录页可达、lt/execution 能提、验证码图片能拿到
process.env.EAMS_TRANSPORT = 'http';
const { HttpEamsClient } = require('../lib/http_eams_client');
const cfg = require('../lib/config').createConfig(process.cwd(), process.env);

(async () => {
  const cli = new HttpEamsClient(cfg, { log: (tag, msg) => console.log(`[${tag}]`, msg) });
  console.log('1) 访问 EAMS 入口...');
  const entry = await cli.request(cfg.eamsEntry);
  const html = await entry.text();
  console.log('  final URL:', entry.url);
  console.log('  html length:', html.length);
  console.log('  contains lt field:', /id="lt"|name="lt"/.test(html));
  console.log('  contains execution field:', /name="execution"/.test(html));

  const lt = (html.match(/id="lt"\s+[^>]*value="([^"]*)"/) || [])[1] || '';
  const execution = (html.match(/name="execution"\s+[^>]*value="([^"]*)"/) || [])[1] || '';
  console.log('  lt =', JSON.stringify(lt));
  console.log('  execution =', JSON.stringify(execution.slice(0, 40)) + (execution.length > 40 ? '...' : ''));

  console.log('2) 取验证码...');
  const cap = await cli.request(cfg.casCodeUrl);
  const buf = await cap.buffer();
  console.log('  captcha bytes:', buf.length, 'magic:', buf.slice(0, 3).toString('hex'));
  require('fs').writeFileSync('debug_captcha.jpeg', buf);
  console.log('  saved to debug_captcha.jpeg');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
