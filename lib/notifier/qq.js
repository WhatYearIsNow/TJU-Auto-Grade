/**
 * NapCat QQ 通知通道 — 辅助通道（可选）
 * 契约：isConfigured() → boolean, send(subject, body) → Promise<boolean>
 * 失败返回 false 或抛异常，不影响主通道。
 */

function sanitizeHeader(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

class QqChannel {
  constructor(config, options = {}) {
    this.napcatUrl = config.napcatUrl || 'http://127.0.0.1:3002/send_private_msg';
    this.token = config.napcatToken || '';
    this.targetUser = config.qqTargetUser || '';
    this.log = options.log || (() => {});
    this.name = 'qq';
  }

  isConfigured() {
    return Boolean(this.targetUser && this.napcatUrl);
  }

  async send(subject, body) {
    const message = sanitizeHeader(subject);
    try {
      await fetch(this.napcatUrl, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + this.token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          user_id: Number(this.targetUser),
          message: message.slice(0, 1500),
        }),
      });
      this.log('QQ', 'QQ通知已发送: ' + subject);
      return true;
    } catch (e) {
      this.log('QQ', 'QQ通知失败: ' + e.message);
      return false;
    }
  }

  close() { /* 无资源需要释放 */ }
}

module.exports = { QqChannel };
