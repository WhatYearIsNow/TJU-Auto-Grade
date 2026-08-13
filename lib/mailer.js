const dns = require('dns');
const net = require('net');
const nodemailer = require('nodemailer');

function sanitizeHeader(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

function isValidEmail(value) {
  return /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value);
}

class Mailer {
  constructor(config, options = {}) {
    this.config = config;
    this.log = options.log || (() => {});
    this.transportFactory = options.transportFactory || nodemailer.createTransport;
    this.lookup = options.lookup || dns.promises.lookup;
    this.transport = null;
    this.transportPromise = null;
  }

  isConfigured() {
    const { user, pass, to } = this.config;
    return Boolean(user && pass && to);
  }

  validate() {
    const { user, pass, to, host, port } = this.config;
    const problems = [];
    if (!user || !pass) problems.push('未配置 QQ_EMAIL / QQ_SMTP_CODE');
    if (user && !isValidEmail(user)) problems.push('QQ_EMAIL 格式不正确');
    if (to && !isValidEmail(to)) problems.push('NOTIFY_EMAIL 格式不正确');
    if (!host) problems.push('SMTP_HOST 不能为空');
    if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push('SMTP_PORT 不正确');
    return problems;
  }

  async getTransport() {
    if (this.transport) return this.transport;
    if (!this.transportPromise) {
      this.transportPromise = Promise.resolve()
        .then(() => this.lookup(this.config.host, { family: 4 }))
        .then(result => {
          const address = typeof result === 'string' ? result : result.address;
          if (!address) throw new Error(`无法解析 SMTP 地址 ${this.config.host}`);
          const servername = net.isIP(this.config.host) ? undefined : this.config.host;
          this.transport = this.transportFactory({
            host: address,
            port: this.config.port,
            secure: this.config.secure,
            servername,
            tls: servername ? { servername } : undefined,
            auth: { user: this.config.user, pass: this.config.pass },
            connectionTimeout: 30_000,
            greetingTimeout: 30_000,
            socketTimeout: 30_000,
            disableFileAccess: true,
            disableUrlAccess: true,
          });
          return this.transport;
        })
        .catch(error => {
          this.transportPromise = null;
          throw error;
        });
    }
    return this.transportPromise;
  }

  async send(subject, body) {
    if (!this.isConfigured()) {
      this.log('MAIL', '未配置邮箱');
      return false;
    }
    const problems = this.validate();
    if (problems.length > 0) throw new Error(problems.join('；'));

    const transport = await this.getTransport();
    await transport.sendMail({
      from: { name: 'TJU-Auto-Grade', address: this.config.user },
      to: this.config.to,
      subject: sanitizeHeader(subject),
      html: body,
      headers: { 'X-TJU-Auto-Grade': 'true' },
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    this.log('MAIL', '发送成功');
    return true;
  }

  close() {
    if (this.transport && typeof this.transport.close === 'function') this.transport.close();
    this.transport = null;
    this.transportPromise = null;
  }
}

module.exports = {
  Mailer,
  isValidEmail,
  sanitizeHeader,
};
