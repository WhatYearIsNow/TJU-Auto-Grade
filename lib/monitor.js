const fs = require('fs');
const { chromium } = require('playwright');
const { EamsClient, isFatalBrowserError } = require('./eams');
const { ImapCommandClient } = require('./email_commands');
const {
  buildGradesEmail,
  buildHelpEmail,
  buildLogEmail,
  buildHistoryEmail,
  buildStatusEmail,
  buildWeightedEmail,
  buildAllSemestersEmail,
  createGradeNotification,
  diffGrades,
  escapeHtml,
} = require('./grades');
const { Notifier } = require('./notifier');
const { NotificationOutbox } = require('./notification_outbox');
const {
  ProcessGuard,
  readGradesSnapshot,
  writeGradesSnapshot,
} = require('./storage');
const { createLogger: createStructuredLogger } = require('./logger');

function createLogger(logFile, options = {}) {
  return createStructuredLogger(logFile, options);
}

class AsyncLock {
  constructor() {
    this.tail = Promise.resolve();
  }

  async run(task) {
    const previous = this.tail;
    let release;
    this.tail = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }
}

function now() {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}

function createState() {
  return {
    startTime: new Date(),
    lastCheck: null,
    lastResult: null,
    lastChange: null,
    failCount: 0,
    gradeCount: 0,
    latestGrades: [],
    outboxPending: 0,
    outboxRetrying: 0,
    lastDelivery: null,
  };
}

class GradeMonitor {
  constructor(config, options = {}) {
    this.config = config;
    this.env = options.env || process.env;
    this.chromium = options.chromium || chromium;
    this.log = options.log || createLogger(config.logFile);
    this.state = createState();
    this.pageLock = new AsyncLock();
    this.context = null;
    this.eams = null;
    this.lastGrades = [];
    this.failCount = 0;
    this.sessionRecovering = false;
    this.checkInProgress = false;
    this.running = false;
    this.autoMonitoring = true;
    this.shuttingDown = false;
    this.manageProcess = options.manageProcess !== false;
    this.timers = new Set();
    this.gradeTimer = null;
    this.processHandlers = [];
    this.guard = this.manageProcess ? new ProcessGuard({
      pidFile: config.monitorPidFile || config.pidFile,
      heartbeatFile: config.monitorHeartbeatFile || config.heartbeatFile,
      script: options.processScript || config.monitorScript || config.mainScript,
    }) : null;
    this.notifier = options.notifier || new Notifier(config, { log: this.log });
    this.outbox = options.outbox || new NotificationOutbox(config.notificationOutboxFile, {
      baseRetryMs: config.outboxRetryBaseMs,
      maxRetryMs: config.outboxRetryMaxMs,
      retentionMs: config.outboxRetentionMs,
    });
    this.imap = options.imap || new ImapCommandClient(config.imap, {
      lastUidFile: config.lastUidFile,
      socketTimeoutMs: config.imapSocketTimeoutMs,
      verbose: config.imapVerbose,
      log: this.log,
    });
    // 当前监控学期（初始化时确定）
    this.currentSemester = null;
  }

  setTimer(callback, delay) {
    const timer = setTimeout(async () => {
      this.timers.delete(timer);
      await callback();
    }, delay);
    this.timers.add(timer);
    return timer;
  }

  clearTimers() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  syncOutboxState() {
    const stats = this.outbox.stats();
    this.state.outboxPending = stats.pending;
    this.state.outboxRetrying = stats.retrying;
    this.state.lastDelivery = stats.lastSentAt
      ? new Date(stats.lastSentAt).toLocaleString('zh-CN', { hour12: false })
      : null;
    return stats;
  }

  enqueueGradeChanges(changes) {
    const events = changes.map(createGradeNotification);
    const added = this.outbox.enqueueMany(events);
    this.syncOutboxState();
    this.log('OUTBOX', `新增 ${added} 条通知，去重 ${events.length - added} 条，待发送 ${this.state.outboxPending} 条`);
    return added;
  }

  async flushOutbox() {
    const before = this.syncOutboxState();
    if (!this.notifier.primaryAvailable()) return before;
    const result = await this.outbox.process(item => this.notifier.send(item.subject, item.body));
    this.syncOutboxState();
    if (result.delivered > 0) this.log('OUTBOX', `已发送 ${result.delivered} 条，剩余 ${result.pending} 条`);
    if (result.failed > 0) this.log('OUTBOX', `${result.failed} 条发送失败，已安排自动重试`);
    return result;
  }

  async start() {
    this.log('INIT', '=== 查成绩助手启动 ===');
    this.guard?.acquire();
    this.running = true;
    if (this.manageProcess) {
      this.installProcessHandlers();
      this.scheduleHeartbeat();
    }

    // 健康提示：auth 服务、通知通道
    await this.printHealthHints();

    try {
      await this.flushOutbox();
      this.assertActive();
      await this.launchBrowser();
      this.assertActive();
      await this.ensureLogin();
      this.assertActive();
      await this.initializeGrades();
      this.assertActive();
      this.printReadyMessage();
      this.scheduleGradeCheck(this.config.checkIntervalMs);
      this.scheduleImapPoll(15_000);
      this.scheduleOutboxPoll(this.config.outboxPollIntervalMs);
      return this;
    } catch (error) {
      await this.stop({ exit: false });
      throw error;
    }
  }

  async launchBrowser() {
    if (this.config.transport === 'http') {
      this.log('INIT', '使用 HTTP 直连模式（不启动浏览器）');
      const { HttpEamsClient } = require('./http_eams_client');
      this.eams = new HttpEamsClient(this.config, { env: this.env, log: this.log });
      return;
    }
    this.log('INIT', `启动浏览器 (${this.config.browserChannel}${this.config.headless ? ' / headless' : ''})...`);
    const launchOptions = {
      headless: this.config.headless,
      args: this.config.headless ? [] : ['--start-maximized'],
      viewport: this.config.headless ? { width: 1440, height: 1000 } : null,
    };
    if (this.config.browserChannel !== 'chromium') launchOptions.channel = this.config.browserChannel;
    this.context = await this.chromium.launchPersistentContext(this.config.profileDir, launchOptions);
    if (!this.running) {
      await this.context.close();
      throw new Error('监控启动已取消');
    }
    const pages = this.context.pages();
    const page = pages[0] || await this.context.newPage();
    this.eams = new EamsClient(page, this.config, { env: this.env, log: this.log });
  }

  assertActive() {
    if (!this.running) throw new Error('监控启动已取消');
  }

  async ensureLogin() {
    if (this.config.transport === 'http') {
      this.log('INIT', 'HTTP 直连登录...');
      if (!await this.eams.autoLogin()) throw new Error('登录失败');
      return;
    }
    this.log('INIT', '访问 EAMS...');
    await this.eams.page.goto(this.config.eamsEntry, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await this.eams.page.waitForTimeout(2000);
    if (this.eams.isOnEamsPage()) {
      this.log('INIT', '会话有效，跳过登录');
      return;
    }
    if (!this.eams.isOnCasPage()) {
      throw new Error(`未进入 EAMS 或 CAS，当前页面: ${this.eams.page.url()}`);
    }
    if (!await this.eams.login()) throw new Error('登录失败');
  }

  async initializeGrades() {
    this.log('INIT', '首次抓取成绩...');
    // 尝试从已发现学期中获取最新学期的成绩
    const semesters = await this.pageLock.run(() => this.eams.listSemesters());
    let targetSemester = null;
    if (semesters?.length > 0) {
      // 取 id 最大的学期（最新学期）
      const sorted = semesters.sort((a, b) => Number(b.id) - Number(a.id));
      targetSemester = sorted[0];
      this.currentSemester = targetSemester;
      this.log('INIT', `使用最新学期: ${targetSemester.label} (id=${targetSemester.id})`);
    }

    this.lastGrades = await this.pageLock.run(() =>
      targetSemester
        ? this.eams.extractGrades({ semesterId: Number(targetSemester.id) })
        : this.eams.extractGrades()
    );
    if (this.lastGrades.length === 0) throw new Error('未抓到成绩，保留旧快照并退出');

    const savedGrades = readGradesSnapshot(this.config.lastGradesFile);
    const startupChanges = savedGrades.length > 0 ? diffGrades(savedGrades, this.lastGrades) : [];
    if (startupChanges.length > 0) {
      this.log('INIT', `发现停机期间 ${startupChanges.length} 门课程有变化`);
      this.enqueueGradeChanges(startupChanges);
    }
    writeGradesSnapshot(this.config.lastGradesFile, this.lastGrades);
    await this.flushOutbox();
    this.state.gradeCount = this.lastGrades.length;
    this.state.latestGrades = this.lastGrades;
    this.log('INIT', `初始快照: ${this.lastGrades.length} 门课程`);
  }

  printReadyMessage() {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`  监控已启动，每 ${this.config.checkIntervalMs / 60000} 分钟检查一次成绩`);
    console.log(`  通知队列: ${this.state.outboxPending} 条待发送`);
    if (this.config.imapEnabled && this.imap.isConfigured()) {
      console.log(`  邮件指令每 ${this.config.imapIntervalMs / 1000} 秒轮询`);
    } else {
      console.log('  邮件指令轮询未启用或邮箱配置不完整');
    }
    console.log(`${'='.repeat(50)}\n`);
  }

  /** 启动期健康提示：auth 服务、通知通道 */
  async printHealthHints() {
    // tju-auth 健康
    if (this.config.authServiceUrl) {
      try {
        const { HttpEamsClient } = require('./http_eams_client');
        const healthClient = new HttpEamsClient(this.config, { log: () => {} });
        const health = await healthClient.checkAuthService();
        if (health.available) {
          this.log('HEALTH', 'tju-auth 服务正常（' + health.cookies + ' 条 cookie）');
        } else {
          this.log('HEALTH', 'tju-auth 不可达（' + health.reason + '），使用验证码登录降级模式');
        }
      } catch (e) {
        this.log('HEALTH', 'tju-auth 不可达（' + e.message + '），使用验证码登录降级模式');
      }
    }

    // 通知通道健康
    const channels = this.notifier.health();
    const primary = this.notifier.primaryAvailable();
    if (!primary) {
      this.log('HEALTH', '无可用的通知通道（SMTP 未配置或 QQ 通知未启用）');
    } else {
      this.log('HEALTH', '通知通道: ' + channels.map(c => c.configured ? c.name + '✓' : c.name + '✗').join(', '));
    }
  }

  async waitForRelogin() {
    this.sessionRecovering = true;
    try {
      if (await this.pageLock.run(() => this.eams.autoLogin())) {
        this.failCount = 0;
        return true;
      }
      if (this.config.transport === 'http') {
        this.log('CHECK', 'HTTP 直连模式自动重登失败');
        return false;
      }
      const timeoutMinutes = this.config.reloginTimeoutMs / 60000;
      this.log('CHECK', `请在浏览器中重新登录，最多等待 ${timeoutMinutes} 分钟...`);
      const success = await this.eams.waitForEams(this.config.reloginTimeoutMs);
      if (success) {
        this.log('CHECK', '登录成功，恢复监控');
        this.failCount = 0;
      }
      return success;
    } finally {
      this.sessionRecovering = false;
    }
  }

  async sendAlert(subject, body) {
    try {
      const ok = await this.notifier.send(subject, body);
      if (!ok) this.log('MAIL', '报警发送失败（无可用的通知通道或主通道返回失败）');
    } catch (error) { this.log('MAIL', `报警发送失败: ${error.message}`); }
  }

  async checkGrades() {
    if (!this.running) return;
    if (this.checkInProgress) return false;
    this.checkInProgress = true;
    let nextDelay = this.config.checkIntervalMs;
    this.log('CHECK', '开始检查');
    this.state.lastCheck = new Date();
    try {
      let freshGrades = await this.pageLock.run(() =>
        this.currentSemester
          ? this.eams.extractGrades({ semesterId: Number(this.currentSemester.id) })
          : this.eams.extractGrades()
      );
      if (freshGrades.length === 0 && this.eams.isOnCasPage()) {
        this.state.lastResult = 'cas';
        if (await this.waitForRelogin()) {
          freshGrades = await this.pageLock.run(() =>
            this.currentSemester
              ? this.eams.extractGrades({ semesterId: Number(this.currentSemester.id) })
              : this.eams.extractGrades()
          );
        } else {
          this.recordFailure();
          if (this.failCount === 1) {
            await this.sendAlert('EAMS 会话已过期', `<p>【${now()}】自动重新登录失败，请在浏览器中重新登录 EAMS。</p>`);
          }
          return;
        }
      }
      if (freshGrades.length === 0) {
        this.recordFailure();
        this.log('CHECK', `提取失败 (连续 ${this.failCount} 次)`);
        if (this.failCount === 3) {
          await this.sendAlert('EAMS 监控异常', `<p>【${now()}】连续 ${this.failCount} 次提取失败，请检查浏览器窗口。</p>`);
        }
        return;
      }

      this.failCount = 0;
      this.state.failCount = 0;
      this.state.gradeCount = freshGrades.length;
      const changes = diffGrades(this.lastGrades, freshGrades);
      if (changes.length > 0) {
        this.state.lastResult = 'change';
        this.state.lastChange = now();
        this.log('CHECK', `发现 ${changes.length} 门课程有变化`);
        this.enqueueGradeChanges(changes);
      } else {
        this.state.lastResult = 'nochange';
        this.log('CHECK', '无变化');
      }
      this.lastGrades = freshGrades;
      this.state.latestGrades = freshGrades;
      writeGradesSnapshot(this.config.lastGradesFile, freshGrades);
      try {
        const histLine = JSON.stringify({
          time: now(),
          count: freshGrades.length,
          changes: changes.map(c => ({
            name: c.name || c.courseName || '?',
            old: c.old?.score ?? c.old ?? '',
            new: c.new?.score ?? c.new ?? '',
          })),
        });
        require('fs').appendFileSync(this.config.historyFile, histLine + '\n');
      } catch (e) { this.log('HIST', '写入历史失败: ' + e.message); }
      if (changes.length > 0) await this.flushOutbox();
    } catch (error) {
      if (isFatalBrowserError(error)) {
        this.log('FATAL', `浏览器已关闭: ${error.message}`);
        await this.stop({ exit: true, code: 1 });
        return;
      }
      this.recordFailure();
      this.log('CHECK', `异常: ${error.message} (连续 ${this.failCount} 次)`);
      if (this.failCount === 3) {
        await this.sendAlert('EAMS 监控异常', `<p>【${now()}】连续 ${this.failCount} 次异常: ${escapeHtml(error.message)}</p>`);
      }
      if (this.eams.isOnCasPage() && await this.waitForRelogin()) {
        nextDelay = 0;
      }
    } finally {
      this.checkInProgress = false;
      if (this.running) this.scheduleGradeCheck(nextDelay);
    }
    return true;
  }

  recordFailure() {
    this.failCount++;
    this.state.failCount = this.failCount;
    this.state.lastResult = 'fail';
  }

  scheduleGradeCheck(delay) {
    if (!this.autoMonitoring) {
      this.log('GRADE', '自动查分已暂停，跳过本次定时检查');
      return;
    }
    if (this.gradeTimer) {
      clearTimeout(this.gradeTimer);
      this.timers.delete(this.gradeTimer);
    }
    this.gradeTimer = this.setTimer(() => this.checkGrades(), delay);
  }

  scheduleHeartbeat() {
    const beat = async () => {
      if (!this.running) return;
      try { this.guard.beat(); }
      catch (error) { this.log('HEARTBEAT', `写入失败: ${error.message}`); }
      if (this.running) this.setTimer(beat, this.config.heartbeatIntervalMs);
    };
    this.setTimer(beat, this.config.heartbeatIntervalMs);
  }

  scheduleOutboxPoll(delay) {
    const poll = async () => {
      if (!this.running) return;
      try { await this.flushOutbox(); }
      catch (error) { this.log('OUTBOX', `处理异常: ${error.message}`); }
      if (this.running) this.setTimer(poll, this.config.outboxPollIntervalMs);
    };
    this.setTimer(poll, delay);
  }

  scheduleImapPoll(delay) {
    if (!this.config.imapEnabled || !this.imap.isConfigured()) return;
    const poll = async () => {
      if (!this.running) return;
      try { await this.imap.poll(command => this.handleEmailCommand(command)); }
      catch (error) { this.log('IMAP', `轮询异常: ${error.message}`); }
      if (this.running) this.setTimer(poll, this.config.imapIntervalMs);
    };
    this.setTimer(poll, delay);
  }

  async handleEmailCommand({ command, subject }) {
    let body;
    if (command === 'status') {
      body = buildStatusEmail(this.state, this.config);
    } else if (command === 'log') {
      body = buildHistoryEmail(this.config.historyFile);
    } else if (command === 'help') {
      body = buildHelpEmail();
    } else if (this.sessionRecovering) {
      body = `<p>【${now()}】EAMS 会话正在恢复，请稍后重试。</p>`;
    } else if (command === 'weighted') {
      let data = await this.pageLock.run(() => this.eams.extractWeightedGrades());
      if (data === null && this.eams.autoLogin) {
        await this.pageLock.run(() => this.eams.autoLogin());
        data = await this.pageLock.run(() => this.eams.extractWeightedGrades());
      }
      body = data === null
        ? `<p>【${now()}】会话已过期，自动重登失败。请稍后再试。</p>`
        : buildWeightedEmail(data);
    } else if (command === 'grades') {
      const semesters = await this.pageLock.run(() => this.eams.listSemesters());
      if (!semesters?.length) {
        body = `<p>【${now()}】未能获取学期列表。</p>`;
      } else {
        const allData = [];
        for (const sem of semesters.sort((a, b) => Number(a.id) - Number(b.id))) {
          const grades = await this.pageLock.run(() => this.eams.extractGrades({ semesterId: Number(sem.id) }));
          allData.push({ label: sem.label, grades });
        }
        body = buildAllSemestersEmail(allData);
      }
    } else if (command === 'start') {
      this.autoMonitoring = true;
      this.scheduleGradeCheck(0);
      body = `<p>【${now()}】自动查分已启动，每 ${this.config.checkIntervalMs / 60000} 分钟检查一次。发"停止"可停止。</p>`;
    } else if (command === 'stop') {
      this.autoMonitoring = false;
      if (this.gradeTimer) { clearTimeout(this.gradeTimer); this.timers?.delete(this.gradeTimer); this.gradeTimer = null; }
      body = `<p>【${now()}】自动查分已停止。邮件查询功能仍可用。</p>`;
    } else if (command && command.startsWith('semester:')) {
      const userSem = command.split(':')[1];
      const yy = parseInt(userSem.slice(0, 2));
      const sem = parseInt(userSem[4]);
      const eamsSid = 117 + (yy - 25) * 2 + (sem - 2);
      let grades = await this.pageLock.run(() => this.eams.extractGrades({ semesterId: eamsSid }));
      if ((grades.length === 0 || this.eams.isOnCasPage()) && this.eams.autoLogin) {
        await this.pageLock.run(() => this.eams.autoLogin());
        grades = await this.pageLock.run(() => this.eams.extractGrades({ semesterId: eamsSid }));
      }
      body = grades.length === 0
        ? `<p>【${now()}】学期 ${userSem} 未查到成绩（可能该学期无课程）。</p>`
        : buildGradesEmail(grades, `学期 ${userSem} 成绩单`);
    } else {
      body = buildHelpEmail();
    }
    const replySubject = subject.replace(/^(Re|回复|答复):\s*/i, '') || 'TJU-Auto-Grade 指令';
    const ok = await this.notifier.send(`Re: ${replySubject}`, body);
    if (!ok) this.log('MAIL', '邮件指令回复发送失败');
  }

  getSnapshot() {
    return {
      running: this.running,
      sessionRecovering: this.sessionRecovering,
      checkInProgress: this.checkInProgress,
      state: { ...this.state },
    };
  }

  getNotifications(limit = 100) {
    return this.outbox.state.items.slice(-limit).reverse().map(item => ({
      id: item.id,
      subject: item.subject,
      meta: item.meta,
      status: item.status,
      attempts: item.attempts,
      createdAt: item.createdAt,
      nextAttemptAt: item.nextAttemptAt,
      sentAt: item.sentAt,
      lastError: item.lastError,
    }));
  }

  async checkNow() {
    if (!this.running || !this.eams) throw new Error('监控尚未就绪');
    const completed = await this.checkGrades();
    if (completed === false) throw new Error('已有查分任务正在进行');
    return this.getSnapshot();
  }

  async retryNotifications() {
    return this.flushOutbox();
  }

  async queryWeightedGrades() {
    if (!this.running || !this.eams) throw new Error('监控尚未就绪');
    if (this.sessionRecovering) throw new Error('EAMS 会话正在恢复');
    return this.pageLock.run(() => this.eams.extractWeightedGrades());
  }

  async listSemesters() {
    if (!this.running || !this.eams) throw new Error('监控尚未就绪');
    if (this.sessionRecovering) throw new Error('EAMS 会话正在恢复');
    return this.pageLock.run(() => this.eams.listSemesters());
  }

  async querySemesterGrades(semesterId) {
    if (!this.running || !this.eams) throw new Error('监控尚未就绪');
    if (this.sessionRecovering) throw new Error('EAMS 会话正在恢复');
    return this.pageLock.run(() => this.eams.extractGrades({ semesterId, logTag: 'HISTORY' }));
  }

  async sendTestEmail() {
    return this.notifier.send(
      'TJU-Auto-Grade 控制台测试',
      `<p>【${now()}】本机控制台邮件配置正常。</p>`,
    );
  }

  installProcessHandlers() {
    const onSignal = () => { this.stop({ exit: true, code: 0 }); };
    const onUnhandledRejection = reason => {
      this.log('FATAL', `未处理的 Promise 拒绝: ${reason}`);
      this.stop({ exit: true, code: 1 });
    };
    const onUncaughtException = error => {
      this.log('FATAL', `未捕获的异常: ${error.message}`);
      this.stop({ exit: true, code: 1 });
    };
    for (const [event, handler] of [
      ['SIGINT', onSignal],
      ['SIGTERM', onSignal],
      ['unhandledRejection', onUnhandledRejection],
      ['uncaughtException', onUncaughtException],
    ]) {
      process.on(event, handler);
      this.processHandlers.push([event, handler]);
    }
  }

  removeProcessHandlers() {
    for (const [event, handler] of this.processHandlers) process.removeListener(event, handler);
    this.processHandlers = [];
  }

  async stop(options = {}) {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.running = false;
    this.autoMonitoring = true;
    this.log('EXIT', '正在关闭...');
    this.clearTimers();
    this.removeProcessHandlers();
    this.guard?.release();
    // 完整释放所有资源
    this.imap?.close();
    this.notifier?.close();
    this.outbox?.persist();
    try { await this.context?.close(); } catch {}
    // 释放 tesseract worker（通过 require.cache 清除）
    try {
      const tesseractPath = require.resolve('tesseract.js');
      delete require.cache[tesseractPath];
    } catch {}
    if (options.exit) process.exit(options.code || 0);
  }
}

module.exports = {
  AsyncLock,
  GradeMonitor,
  createLogger,
  createState,
};
