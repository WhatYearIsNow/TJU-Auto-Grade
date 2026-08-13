const test = require('node:test');
const assert = require('node:assert/strict');
const { Mailer } = require('../lib/mailer');

test('Mailer uses one hardened transport and sanitizes the subject', async () => {
  const transportOptions = [];
  const messages = [];
  const transport = {
    async sendMail(message) { messages.push(message); },
    close() {},
  };
  const mailer = new Mailer({
    host: 'smtp.example.com',
    port: 465,
    secure: true,
    user: 'sender@example.com',
    pass: 'secret',
    to: 'receiver@example.com',
  }, {
    lookup: async () => ({ address: '203.0.113.10', family: 4 }),
    transportFactory(options) {
      transportOptions.push(options);
      return transport;
    },
  });

  await mailer.send('成绩更新\r\nBcc: attacker@example.com', '<p>安全正文</p>');
  await mailer.send('第二封', '<p>正文</p>');

  assert.equal(transportOptions.length, 1);
  assert.equal(transportOptions[0].host, '203.0.113.10');
  assert.equal(transportOptions[0].servername, 'smtp.example.com');
  assert.equal(transportOptions[0].tls.servername, 'smtp.example.com');
  assert.equal(transportOptions[0].disableFileAccess, true);
  assert.equal(transportOptions[0].disableUrlAccess, true);
  assert.equal(messages[0].subject, '成绩更新 Bcc: attacker@example.com');
  assert.equal(messages[0].headers['X-TJU-Auto-Grade'], 'true');
});

test('Mailer reports incomplete configuration without opening a connection', async () => {
  const mailer = new Mailer({ host: 'smtp.qq.com', port: 465, secure: true, user: '', pass: '', to: '' });
  assert.equal(mailer.isConfigured(), false);
  assert.equal(await mailer.send('test', '<p>test</p>'), false);
});
