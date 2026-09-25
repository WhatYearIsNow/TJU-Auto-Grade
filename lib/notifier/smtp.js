const { Mailer } = require('../mailer');

/**
 * SMTP 通知通道 — 主通道
 * 契约：isConfigured() → boolean, send(subject, body) → Promise<boolean>
 * 失败必须抛出异常或返回 false，禁止吞异常后返回 true。
 */
class SmtpChannel {
  constructor(config, options = {}) {
    this.mailer = options.mailer || new Mailer(config, { log: options.log || (() => {}) });
    this.name = 'smtp';
  }

  isConfigured() {
    return this.mailer.isConfigured();
  }

  validate() {
    return this.mailer.validate();
  }

  async send(subject, body) {
    return this.mailer.send(subject, body);
  }

  close() {
    this.mailer.close();
  }
}

module.exports = { SmtpChannel };
