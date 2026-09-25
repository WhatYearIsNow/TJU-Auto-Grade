const { spawn } = require('child_process');
const path = require('path');
const { loadConfig } = require('../lib/config');
const { Mailer } = require('../lib/mailer');
const { inspectProcessHealth } = require('../lib/storage');

function now() {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}

function startMain(config, spawnProcess = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(process.execPath, [config.mainScript], {
      cwd: config.rootDir,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve(child.pid);
    });
  });
}

class Watchdog {
  constructor(config, options = {}) {
    this.config = config;
    this.mailer = options.mailer || new Mailer(config.smtp, {
      log: (tag, message) => console.log(`[${now()} ${tag}] ${message}`),
    });
    this.inspect = options.inspect || (() => inspectProcessHealth({
      pidFile: config.pidFile,
      heartbeatFile: config.heartbeatFile,
      scripts: [config.dashboardScript, config.monitorScript],
      maxHeartbeatAgeMs: config.watchdogHeartbeatMaxAgeMs,
      now: Date.now,
    }));
    this.startProcess = options.startProcess || (() => startMain(config));
    this.sleep = options.sleep || (delay => new Promise(resolve => setTimeout(resolve, delay)));
    this.alertState = null;
    this.running = false;
    this.timer = null;
  }

  async notify(subject, body) {
    try { return await this.mailer.send(subject, body); }
    catch (error) {
      console.error(`[${now()}] 邮件发送失败: ${error.message}`);
      return false;
    }
  }

  async check() {
    const health = this.inspect();
    const timestamp = now();
    if (health.status === 'healthy') {
      if (this.alertState) {
        console.log(`[${timestamp}] 主进程已恢复`);
        await this.notify('监控已恢复', `<p>【${timestamp}】TJU-Auto-Grade 已恢复正常运行。</p>`);
        this.alertState = null;
      }
      return health;
    }

    if (health.status === 'stopped' && this.config.watchdogAutoRestart) {
      console.log(`[${timestamp}] 主进程未运行，尝试自动重启`);
      try {
        const pid = await this.startProcess();
        console.log(`[${timestamp}] 已启动新进程 (PID ${pid})`);
        await this.sleep(3000);
        const restarted = this.inspect();
        if (restarted.status === 'healthy') {
          await this.notify('监控已自动重启', `<p>【${timestamp}】TJU-Auto-Grade 已由看门狗自动重启。</p>`);
          this.alertState = null;
          return restarted;
        }
      } catch (error) {
        console.error(`[${timestamp}] 自动重启失败: ${error.message}`);
      }
    }

    if (this.alertState !== health.status) {
      const details = health.status === 'stale'
        ? `主进程仍存在，但心跳已中断 ${Math.ceil(health.heartbeatAgeMs / 60000)} 分钟。为避免误杀进程，看门狗未强制终止它。`
        : health.status === 'unknown'
          ? 'PID 对应进程存在，但无法确认其为健康的 TJU-Auto-Grade 实例。'
          : `主进程未运行${this.config.watchdogAutoRestart ? '，且自动重启失败' : ''}。`;
      console.log(`[${timestamp}] ${details}`);
      await this.notify('监控进程异常', `<p>【${timestamp}】${details}</p>`);
      this.alertState = health.status;
    }
    return health;
  }

  start() {
    this.running = true;
    console.log(`[${now()}] 看门狗已启动，每 ${this.config.watchdogIntervalMs / 60000} 分钟检查一次`);
    const loop = () => {
      if (!this.running) return;
      this.check().catch(error => {
        console.error(`[${now()}] 看门狗异常: ${error.message}`);
      }).finally(() => {
        if (this.running) this.timer = setTimeout(loop, this.config.watchdogIntervalMs);
      });
    };
    loop();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.mailer.close();
  }
}

if (require.main === module) {
  const watchdog = new Watchdog(loadConfig(path.resolve(__dirname, '..')));
  process.on('SIGINT', () => watchdog.stop());
  process.on('SIGTERM', () => watchdog.stop());
  watchdog.start();
}

module.exports = {
  Watchdog,
  startMain,
};
