// 真登录端到端测试：读 eams.env，登录 CAS，拉当前学期成绩
process.env.EAMS_TRANSPORT = 'http';
const path = require('path');
const { loadConfig } = require('../lib/config');
const { HttpEamsClient } = require('../lib/http_eams_client');

(async () => {
  const cfg = loadConfig(path.resolve(__dirname, '..'), process.env);
  if (!process.env.EAMS_USERNAME || !process.env.EAMS_PASSWORD) {
    console.error('eams.env 里没读到 EAMS_USERNAME / EAMS_PASSWORD');
    process.exit(1);
  }
  console.error('登录账号:', process.env.EAMS_USERNAME);
  const cli = new HttpEamsClient(cfg, {
    env: process.env,
    log: (tag, msg) => console.error(`[${tag}]`, msg),
  });

  console.error('\n--- 开始登录 ---');
  const ok = await cli.autoLogin();
  if (!ok) { console.error('登录失败'); process.exit(2); }

  console.error('\n--- 拉取当前学期成绩 ---');
  const grades = await cli.extractGrades();
  console.error(`抓到 ${grades.length} 门课:`);
  for (const g of grades.slice(0, 15)) {
    console.error('  ', g.courseName || g.name || '(?)', '|', g.credit || g.score || JSON.stringify(g).slice(0, 120));
  }

  console.error('\n--- 拉加权 GPA ---');
  const weighted = await cli.extractWeightedGrades();
  if (weighted) {
    console.error('汇总文本:', weighted.summary.slice(0, 10));
  } else {
    console.error('加权页拉取失败');
  }
})().catch(e => { console.error('FAIL', e); process.exit(3); });
