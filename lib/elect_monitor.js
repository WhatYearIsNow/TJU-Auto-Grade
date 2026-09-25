/**
 * 选课监控 — 通用化选课捡漏引擎
 *
 * 替代 bin/elect_loop.js 的硬编码版本。
 * 从配置读取目标课程，复用 HttpEamsClient 和 Notifier。
 *
 * 用法：
 *   const elect = new ElectMonitor(config, { log });
 *   await elect.start();
 *   // 成功后自动退出，失败持续轮询
 */

const { HttpEamsClient } = require('./http_eams_client');
const { Notifier } = require('./notifier');

class ElectMonitor {
  constructor(config, options = {}) {
    this.config = config;
    this.log = options.log || (() => {});
    this.targetId = config.electTargetId || '';
    this.targetName = config.electTargetName || '未知课程';
    this.targetTeacher = config.electTargetTeacher || '';
    this.targetTime = config.electTargetTime || '';
    this.intervalMs = config.electIntervalMs || 60_000;
    this.electBaseUrl = config.electBaseUrl || 'https://classes.tju.edu.cn/eams';
    this.client = null;
    this.notifier = null;
    this.running = false;
  }

  async start() {
    if (!this.targetId) {
      this.log('ELECT', '未配置 electTargetId，跳过选课监控');
      return;
    }

    this.client = new HttpEamsClient(this.config, {
      env: this.config.env || process.env,
      log: (tag, msg) => this.log(`[ELECT/${tag}] ${msg}`),
    });
    this.notifier = new Notifier(this.config);

    this.log('ELECT', `启动选课监控，目标 lessonItem.id=${this.targetId}（${this.targetName}${this.targetTeacher ? ' / ' + this.targetTeacher : ''}${this.targetTime ? ' / ' + this.targetTime : ''}），每 ${this.intervalMs / 1000}s 一次`);

    // 首次登录
    await this.client.autoLogin();

    this.running = true;
    while (this.running) {
      try {
        // 每轮强制刷新 cookie
        await this.client.autoLogin();

        const res = await this.client.request(
          `${this.electBaseUrl}/exp/std-elect-lesson-item!election.action?lessonItem.id=${this.targetId}`,
          { headers: { 'X-Requested-With': 'XMLHttpRequest', 'Referer': this.electBaseUrl + '/exp/std-elect-lesson-item.action' } }
        );
        const body = await res.text();
        const text = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

        // 会话失效
        if (res.url.includes('sso.tju.edu.cn/cas/login') || body.includes('Unified Identity Authentication')) {
          this.log('ELECT', 'session 失效，重新登录...');
          continue;
        }
        if (text.includes('会话已经被过期') || text.includes('重复登录')) {
          this.log('ELECT', '会话被判定过期（重复登录），重新登录...');
          continue;
        }
        if (res.status >= 500 || body.includes('出错了')) {
          this.log('ELECT', `HTTP ${res.status} 服务端错误，刷新会话后下一轮再试`);
          continue;
        }
        if (text.includes('已达上限') || text.includes('已满')) {
          this.log('ELECT', '名额已满/个人选课到顶，继续蹲');
        } else if (text.includes('已选') && body.includes(this.targetId)) {
          if (await this._confirmElected()) {
            this.log('ELECT', '>>> 抢课成功！');
            await this._notifySuccess();
            this.running = false;
            process.exit(0);
          } else {
            this.log('ELECT', '返回含"已选"但已选列表未检出目标，继续蹲');
          }
        } else {
          await new Promise(r => setTimeout(r, 800));
          if (await this._confirmElected()) {
            this.log('ELECT', '>>> 抢课成功！已在已选列表中检出目标');
            await this._notifySuccess();
            this.running = false;
            process.exit(0);
          } else {
            this.log('ELECT', `HTTP ${res.status}，响应未含错误/满员/已选，摘要: ${text.slice(0, 150)}`);
          }
        }
      } catch (e) {
        this.log('ELECT', `请求异常: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, this.intervalMs));
    }
  }

  async _confirmElected() {
    try {
      const res = await this.client.request(
        `${this.electBaseUrl}/exp/std-elect-lesson-item!electedList.action`,
        { headers: { 'X-Requested-With': 'XMLHttpRequest', 'Referer': this.electBaseUrl + '/exp/std-elect-lesson-item.action' } }
      );
      const body = await res.text();
      return body.includes(this.targetName) && body.includes(this.targetTeacher);
    } catch {
      return false;
    }
  }

  async _notifySuccess() {
    const subject = `【抢课成功】${this.targetName}`;
    const body = `你已成功选上：\n\n项目：${this.targetName}\n教师：${this.targetTeacher}\n时间：${this.targetTime}\nID：${this.targetId}\n时间：${new Date().toLocaleString('zh-CN')}`;
    await this.notifier.send(subject, body);
  }

  stop() {
    this.running = false;
    this.notifier?.close();
  }
}

module.exports = { ElectMonitor };
