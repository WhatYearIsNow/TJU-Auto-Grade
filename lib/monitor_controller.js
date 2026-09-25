const { Notifier } = require('./notifier');
const { GradeMonitor } = require('./monitor');

class MonitorController {
  constructor(config, options = {}) {
    this.config = config;
    this.env = options.env || process.env;
    this.createMonitor = options.createMonitor || ((currentConfig, currentEnv) => new GradeMonitor(currentConfig, {
      manageProcess: false,
      processScript: currentConfig.dashboardScript,
      env: currentEnv,
    }));
    this.monitor = null;
    this.phase = 'stopped';
    this.error = null;
    this.generation = 0;
    this.startPromise = null;
  }

  setConfig(config, env = this.env) {
    this.config = config;
    this.env = env;
  }

  snapshot() {
    const monitorSnapshot = this.monitor?.getSnapshot() || null;
    return {
      phase: this.phase,
      error: this.error,
      monitor: monitorSnapshot,
    };
  }

  start() {
    if (this.phase === 'starting' || this.phase === 'running') return this.snapshot();
    const generation = ++this.generation;
    this.phase = 'starting';
    this.error = null;
    const monitor = this.createMonitor(this.config, this.env);
    this.monitor = monitor;
    this.startPromise = monitor.start().then(() => {
      if (generation !== this.generation) return;
      this.phase = 'running';
    }).catch(error => {
      if (generation !== this.generation) return;
      this.phase = 'error';
      this.error = error.message;
    });
    // 返回同步快照，同时暴露 startPromise 供 await
    return this.snapshot();
  }

  /** 等待监控启动完成（返回 snapshot 或抛错） */
  async waitForStart() {
    if (!this.startPromise) throw new Error('监控尚未启动');
    await this.startPromise;
    return this.snapshot();
  }

  async stop() {
    this.generation++;
    const monitor = this.monitor;
    this.monitor = null;
    this.phase = 'stopping';
    if (monitor) await monitor.stop({ exit: false });
    this.phase = 'stopped';
    this.error = null;
    return this.snapshot();
  }

  async restart(config = this.config, env = this.env) {
    await this.stop();
    this.setConfig(config, env);
    return this.start();
  }

  requireRunning() {
    if (this.phase !== 'running' || !this.monitor) throw new Error('监控尚未就绪');
    return this.monitor;
  }

  async checkNow() {
    return this.requireRunning().checkNow();
  }

  async retryNotifications() {
    return this.requireRunning().retryNotifications();
  }

  async queryWeightedGrades() {
    return this.requireRunning().queryWeightedGrades();
  }

  async listSemesters() {
    return this.requireRunning().listSemesters();
  }

  async querySemesterGrades(semesterId) {
    return this.requireRunning().querySemesterGrades(semesterId);
  }

  notifications(limit) {
    return this.monitor?.getNotifications(limit) || [];
  }

  async sendTestEmail() {
    if (this.monitor) return this.monitor.sendTestEmail();
    const notifier = new Notifier(this.config);
    try {
      return await notifier.send(
        'TJU-Auto-Grade 控制台测试',
        `<p>【${new Date().toLocaleString('zh-CN', { hour12: false })}】本机控制台邮件配置正常。</p>`,
      );
    } finally {
      notifier.close();
    }
  }
}

module.exports = {
  MonitorController,
};
