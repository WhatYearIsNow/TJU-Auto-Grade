// 选课监控 — 通用化入口
// 配置项：ELECT_TARGET_ID, ELECT_TARGET_NAME, ELECT_TARGET_TEACHER,
//         ELECT_TARGET_TIME, ELECT_INTERVAL_MINUTES
// 用法：node bin/elect_loop.js
const path = require('path');
const { loadConfig } = require(path.join(__dirname, '..', 'lib', 'config'));
const { ElectMonitor } = require(path.join(__dirname, '..', 'lib', 'elect_monitor'));

(async () => {
  const cfg = loadConfig(__dirname);
  const monitor = new ElectMonitor(cfg, {
    log: (tag, msg) => {
      const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
      const line = `[${ts}] ${tag}: ${msg}`;
      console.log(line);
      try {
        const fs = require('fs');
        const logFile = path.join(cfg.rootDir, 'data', 'elect_loop.log');
        fs.appendFileSync(logFile, line + '\n');
      } catch {}
    },
  });
  try {
    await monitor.start();
  } catch (e) {
    console.error('致命错误: ' + e.stack);
    process.exit(1);
  }
})();
