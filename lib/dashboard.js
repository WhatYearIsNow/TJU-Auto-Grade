const { spawn } = require('child_process');
const { DashboardServer, readEnvironment, setupStatus } = require('./dashboard_server');
const { MonitorController } = require('./monitor_controller');
const { ProcessGuard } = require('./storage');

function openBrowser(url) {
  let command;
  let args;
  if (process.platform === 'win32') {
    command = 'cmd.exe';
    args = ['/c', 'start', '', url];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

class DashboardApplication {
  constructor(rootDir, options = {}) {
    const loaded = readEnvironment(rootDir, options.baseEnv || process.env);
    this.config = loaded.config;
    this.env = loaded.env;
    this.baseEnv = options.baseEnv || process.env;
    this.controller = options.controller || new MonitorController(this.config, { env: this.env });
    this.server = options.server || new DashboardServer(this.config, this.controller, {
      env: this.env,
      baseEnv: this.baseEnv,
      port: options.port,
    });
    this.guard = options.guard || new ProcessGuard({
      pidFile: this.config.pidFile,
      heartbeatFile: this.config.heartbeatFile,
      script: this.config.dashboardScript,
    });
    this.open = options.open || openBrowser;
    this.autoOpen = options.autoOpen ?? this.config.dashboardAutoOpen;
    this.startMonitor = options.startMonitor !== false;
    this.heartbeatTimer = null;
    this.stopping = false;
    this.signalHandlers = [];
  }

  async start() {
    this.guard.acquire();
    try {
      const url = await this.server.start();
      this.installSignalHandlers();
      this.scheduleHeartbeat();
      console.log(`\nTJU-Auto-Grade 控制台已启动：${url}\n`);
      if (this.autoOpen) {
        try { this.open(url); }
        catch (error) { console.log(`无法自动打开浏览器，请手动访问 ${url}：${error.message}`); }
      }
      if (this.startMonitor && setupStatus(this.env).complete) this.controller.start();
      else if (this.startMonitor) console.log('首次使用：请在控制台完成教务账号配置，保存后会自动启动监控。');
      return url;
    } catch (error) {
      this.guard.release();
      throw error;
    }
  }

  scheduleHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      try { this.guard.beat(); }
      catch (error) { console.error(`[HEARTBEAT] ${error.message}`); }
    }, this.config.heartbeatIntervalMs);
  }

  installSignalHandlers() {
    const shutdown = () => this.stop().finally(() => { process.exitCode = 0; });
    for (const event of ['SIGINT', 'SIGTERM']) {
      process.on(event, shutdown);
      this.signalHandlers.push([event, shutdown]);
    }
  }

  removeSignalHandlers() {
    for (const [event, handler] of this.signalHandlers) process.removeListener(event, handler);
    this.signalHandlers = [];
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    clearInterval(this.heartbeatTimer);
    this.removeSignalHandlers();
    await this.controller.stop();
    await this.server.stop();
    this.guard.release();
  }
}

module.exports = {
  DashboardApplication,
  openBrowser,
};
