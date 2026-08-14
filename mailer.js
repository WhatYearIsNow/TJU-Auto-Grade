'use strict';

const nodemailer = require('nodemailer');

let transporter = null;
let transporterKey = '';

function mailConfig(env = process.env) {
  const user = env.QQ_EMAIL;
  const pass = env.QQ_SMTP_CODE;
  const host = env.SMTP_HOST || 'smtp.qq.com';
  const parsedPort = Number.parseInt(env.SMTP_PORT || '465', 10);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 465;
  const secure = env.SMTP_SECURE
    ? !/^(false|0|no)$/i.test(env.SMTP_SECURE)
    : port === 465;

  return {
    configured: Boolean(user && pass),
    user,
    pass,
    to: env.NOTIFY_EMAIL || user,
    host,
    port,
    secure,
  };
}

function getTransport(config) {
  const key = JSON.stringify([
    config.host,
    config.port,
    config.secure,
    config.user,
    config.pass,
  ]);

  if (!transporter || transporterKey !== key) {
    transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: {
        user: config.user,
        pass: config.pass,
      },
      connectionTimeout: 30_000,
      greetingTimeout: 30_000,
      socketTimeout: 30_000,
    });
    transporterKey = key;
  }

  return transporter;
}

async function sendMail(subject, html, env = process.env) {
  const config = mailConfig(env);
  if (!config.configured) return false;

  await getTransport(config).sendMail({
    from: {
      name: 'tju-auto-grade',
      address: config.user,
    },
    to: config.to,
    subject,
    html,
    disableFileAccess: true,
    disableUrlAccess: true,
  });

  return true;
}

module.exports = {
  mailConfig,
  sendMail,
};
