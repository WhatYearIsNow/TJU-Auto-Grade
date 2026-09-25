const crypto = require('crypto');
const fs = require('fs');
const { atomicWriteJson } = require('./storage');

const STATE_VERSION = 1;

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function createNotificationId(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function parseTime(value, fallback) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : fallback;
}

function safeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, ' ').slice(0, 500);
}

class NotificationOutbox {
  constructor(file, options = {}) {
    this.file = file;
    this.now = options.now || (() => Date.now());
    this.baseRetryMs = options.baseRetryMs || 60 * 1000;
    this.maxRetryMs = options.maxRetryMs || 60 * 60 * 1000;
    this.retentionMs = options.retentionMs || 30 * 24 * 60 * 60 * 1000;
    this.processing = null;
    // 已通知指纹集：独立于记录生命周期，防止保留期清理后重复通知
    this.notifiedFingerprints = new Set();
    this.state = this.load();
  }

  load() {
    if (!fs.existsSync(this.file)) return { version: STATE_VERSION, items: [] };
    const parsed = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
    if (parsed?.version !== STATE_VERSION || !Array.isArray(parsed.items)) {
      throw new Error(`通知队列格式不受支持: ${this.file}`);
    }
    return parsed;
  }

  persist() {
    atomicWriteJson(this.file, this.state);
  }

  prune() {
    const cutoff = this.now() - this.retentionMs;
    const before = this.state.items.length;
    this.state.items = this.state.items.filter(item => {
      if (item.status !== 'sent' || parseTime(item.sentAt, 0) >= cutoff) return true;
      // 删除已发送的记录，但保留指纹防止重复通知
      this.notifiedFingerprints.add(item.id);
      return false;
    });
    return before - this.state.items.length;
  }

  enqueue(event) {
    if (!event?.id || !event.subject || !event.body) {
      throw new Error('通知事件缺少 id、subject 或 body');
    }
    const pruned = this.prune();
    // 检查：是否在已通知指纹集中（保留期清理后仍去重）
    if (this.notifiedFingerprints.has(event.id)) return false;
    if (this.state.items.some(item => item.id === event.id)) {
      if (pruned > 0) this.persist();
      return false;
    }
    const timestamp = new Date(this.now()).toISOString();
    this.state.items.push({
      id: event.id,
      subject: event.subject,
      body: event.body,
      meta: event.meta || {},
      status: 'pending',
      attempts: 0,
      createdAt: timestamp,
      nextAttemptAt: timestamp,
      sentAt: null,
      lastError: null,
    });
    this.persist();
    return true;
  }

  enqueueMany(events) {
    let added = 0;
    const pruned = this.prune();
    for (const event of events) {
      if (!event?.id || !event.subject || !event.body) {
        throw new Error('通知事件缺少 id、subject 或 body');
      }
      // 检查：是否在已通知指纹集中
      if (this.notifiedFingerprints.has(event.id)) continue;
      if (this.state.items.some(item => item.id === event.id)) continue;
      const timestamp = new Date(this.now()).toISOString();
      this.state.items.push({
        id: event.id,
        subject: event.subject,
        body: event.body,
        meta: event.meta || {},
        status: 'pending',
        attempts: 0,
        createdAt: timestamp,
        nextAttemptAt: timestamp,
        sentAt: null,
        lastError: null,
      });
      added++;
    }
    if (added > 0 || pruned > 0) this.persist();
    return added;
  }

  stats() {
    const pendingItems = this.state.items.filter(item => item.status === 'pending');
    const lastSentTime = this.state.items
      .filter(item => item.status === 'sent')
      .map(item => parseTime(item.sentAt, 0))
      .sort((a, b) => b - a)[0];
    const nextDue = pendingItems
      .map(item => parseTime(item.nextAttemptAt, 0))
      .filter(time => time > 0)
      .sort((a, b) => a - b)[0];
    return {
      pending: pendingItems.length,
      retrying: pendingItems.filter(item => item.attempts > 0).length,
      sent: this.state.items.filter(item => item.status === 'sent').length,
      nextDueAt: nextDue ? new Date(nextDue).toISOString() : null,
      lastSentAt: lastSentTime ? new Date(lastSentTime).toISOString() : null,
    };
  }

  async process(send, options = {}) {
    if (this.processing) return this.processing;
    this.processing = this.processInternal(send, options);
    try {
      return await this.processing;
    } finally {
      this.processing = null;
    }
  }

  async processInternal(send, options = {}) {
    const limit = options.limit || 20;
    const dueItems = this.state.items
      .filter(item => item.status === 'pending' && parseTime(item.nextAttemptAt, 0) <= this.now())
      .sort((a, b) => parseTime(a.createdAt, 0) - parseTime(b.createdAt, 0))
      .slice(0, limit);

    let sent = 0;
    let failed = 0;
    for (const item of dueItems) {
      try {
        const result = await send({ ...item });
        if (result === false) throw new Error('发送函数返回失败');
        item.status = 'sent';
        item.sentAt = new Date(this.now()).toISOString();
        item.nextAttemptAt = null;
        item.lastError = null;
        sent++;
      } catch (error) {
        item.attempts += 1;
        const delay = Math.min(
          this.baseRetryMs * (2 ** Math.max(0, item.attempts - 1)),
          this.maxRetryMs,
        );
        item.nextAttemptAt = new Date(this.now() + delay).toISOString();
        item.lastError = safeErrorMessage(error);
        failed++;
      }
      this.persist();
    }

    if (this.prune() > 0) this.persist();
    return { delivered: sent, failed, ...this.stats() };
  }
}

module.exports = {
  NotificationOutbox,
  createNotificationId,
  stableStringify,
};
