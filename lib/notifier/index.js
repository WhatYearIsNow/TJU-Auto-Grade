const { SmtpChannel } = require('./smtp');
const { QqChannel } = require('./qq');

/**
 * 通知器 — 通道选择与编排
 *
 * 通道优先级：
 *   1. SMTP（主通道）— 配置齐全即启用
 *   2. QQ（辅助通道）— 仅当显式配置 napcatUrl + qqTargetUser 时启用
 *
 * 语义：
 *   - 主通道成功 → 视为成功，辅助通道失败只记日志不阻塞
 *   - 主通道失败 → 抛异常/返回 false，辅助通道不重试
 *   - 无可用通道 → 返回 false（不抛异常，调用方可安全处理）
 */

class Notifier {
  constructor(config, options = {}) {
    this.log = options.log || (() => {});
    this.channels = [];

    // 主通道：SMTP
    if (config.smtp && config.smtp.user && config.smtp.pass && config.smtp.to) {
      this.channels.push(new SmtpChannel(config.smtp, { log: this.log }));
    }

    // 辅助通道：QQ（仅显式配置时启用）
    const qqConfig = {
      napcatUrl: config.napcatUrl,
      napcatToken: config.napcatToken,
      qqTargetUser: config.qqTargetUser,
    };
    if (new QqChannel(qqConfig).isConfigured()) {
      this.channels.push(new QqChannel(qqConfig, { log: this.log }));
    }
  }

  /** 是否有至少一个可用通道 */
  isConfigured() {
    return this.channels.length > 0;
  }

  /** 主通道（SMTP）是否可用 */
  primaryAvailable() {
    const primary = this.channels[0];
    return primary && primary.isConfigured();
  }

  /** 各通道健康状态（用于 /api/health） */
  health() {
    return this.channels.map(ch => ({
      name: ch.name,
      configured: ch.isConfigured(),
    }));
  }

  /**
   * 发送通知
   * @param {string} subject
   * @param {string} body
   * @returns {Promise<boolean>} 主通道成功返回 true；无可用通道或主通道失败返回 false
   */
  async send(subject, body) {
    const primary = this.channels[0];
    if (!primary || !primary.isConfigured()) {
      this.log('NOTIFY', '无可用的通知通道');
      return false;
    }

    // 主通道
    try {
      const result = await primary.send(subject, body);
      if (result === true) {
        // 主通道成功，尝试辅助通道（不影响主通道结果）
        await this._sendSecondary(subject, body);
        return true;
      }
      // 主通道返回 false
      return false;
    } catch (error) {
      // 主通道抛异常
      this.log('NOTIFY', '主通道发送失败: ' + error.message);
      return false;
    }
  }

  /** 辅助通道（不阻塞主通道） */
  async _sendSecondary(subject, body) {
    for (let i = 1; i < this.channels.length; i++) {
      const ch = this.channels[i];
      if (!ch.isConfigured()) continue;
      try {
        const result = await ch.send(subject, body);
        if (!result) {
          this.log('NOTIFY', ch.name + ' 辅助通知失败（不影响主通道）');
        }
      } catch (error) {
        this.log('NOTIFY', ch.name + ' 辅助通知异常: ' + error.message);
      }
    }
  }

  /** 关闭所有通道 */
  close() {
    for (const ch of this.channels) {
      try { ch.close(); } catch {}
    }
  }
}

module.exports = { Notifier, SmtpChannel, QqChannel };
