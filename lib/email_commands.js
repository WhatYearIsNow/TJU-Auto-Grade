const fs = require('fs');
const tls = require('tls');
const { atomicWriteFile } = require('./storage');

function decodeBytes(buffer, charset = 'utf-8') {
  try { return new TextDecoder(charset).decode(buffer); }
  catch { return buffer.toString('utf-8'); }
}

function decodeBase64(value, charset = 'utf-8') {
  try { return decodeBytes(Buffer.from(value.replace(/\s/g, ''), 'base64'), charset); }
  catch { return value; }
}

function decodeQP(value, charset = 'utf-8') {
  try {
    const unfolded = value.replace(/=\r?\n/g, '');
    const chunks = [];
    let offset = 0;
    const encodedByte = /=([0-9A-Fa-f]{2})/g;
    let match;
    while ((match = encodedByte.exec(unfolded)) !== null) {
      if (match.index > offset) chunks.push(Buffer.from(unfolded.slice(offset, match.index), 'utf-8'));
      chunks.push(Buffer.from([parseInt(match[1], 16)]));
      offset = match.index + match[0].length;
    }
    if (offset < unfolded.length) chunks.push(Buffer.from(unfolded.slice(offset), 'utf-8'));
    return decodeBytes(Buffer.concat(chunks), charset);
  } catch {
    return value;
  }
}

function decodeRFC2047(value) {
  return value.replace(/=\?([^?]+)\?([BQ])\?([^?]+)\?=/gi, (_, charset, encoding, payload) =>
    encoding.toUpperCase() === 'B'
      ? decodeBase64(payload, charset)
      : decodeQP(payload.replace(/_/g, ' '), charset)
  );
}

function splitHeadersAndBody(value) {
  const match = /\r?\n\r?\n/.exec(value);
  if (!match) return null;
  return {
    headers: value.slice(0, match.index),
    body: value.slice(match.index + match[0].length),
  };
}

function getHeader(rawHeaders, name) {
  const unfolded = rawHeaders.replace(/\r?\n[ \t]+/g, ' ');
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = unfolded.match(new RegExp(`^${escapedName}:\\s*(.*)$`, 'im'));
  return match ? match[1].trim() : '';
}

function extractEmailAddress(value) {
  const angleAddress = value.match(/<([^<>\s]+@[^<>\s]+)>/);
  if (angleAddress) return angleAddress[1].toLowerCase();
  const plainAddress = value.match(/[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/);
  return plainAddress ? plainAddress[0].toLowerCase() : '';
}

function decodeBody(headers, body) {
  const charset = getHeader(headers, 'Content-Type').match(/charset=["']?([^;"'\s]+)/i)?.[1] || 'utf-8';
  const encoding = getHeader(headers, 'Content-Transfer-Encoding').toLowerCase();
  if (encoding === 'base64') return decodeBase64(body, charset);
  if (encoding === 'quoted-printable') return decodeQP(body, charset);
  return body;
}

function extractTextBody(rawEmail) {
  const message = splitHeadersAndBody(rawEmail);
  if (!message) return '';
  const contentType = getHeader(message.headers, 'Content-Type');
  const boundary = contentType.match(/multipart\/[^;]*;[\s\S]*?boundary=["']?([^"'\r\n;]+)/i)?.[1];
  if (!boundary) return decodeBody(message.headers, message.body);

  const parts = message.body.split(`--${boundary}`);
  for (const part of parts) {
    const mimePart = splitHeadersAndBody(part);
    if (!mimePart || !/^text\/plain(?:;|$)/i.test(getHeader(mimePart.headers, 'Content-Type'))) continue;
    return decodeBody(mimePart.headers, mimePart.body.replace(/--\r?\n$/, '').trim());
  }
  return '';
}

function extractReplyText(rawEmail) {
  let fullText = extractTextBody(rawEmail);
  if (!fullText) return '';
  const cutPatterns = [
    /^-----[\s]*原始邮件[^-]*-----/im,
    /^-----[\s]*Original Message[^-]*-----/im,
    /^\d{4}[-/]\d{2}[-/]\d{2}\s+\d{2}:\d{2}.*?(?:写道|wrote):/im,
    /^On\s+\w+.*?wrote:/im,
  ];
  for (const pattern of cutPatterns) {
    const match = fullText.match(pattern);
    if (match) {
      fullText = fullText.substring(0, match.index).trim();
      break;
    }
  }
  return fullText.split(/\r?\n/)
    .filter(line => !/^\s*>/.test(line))
    .join('\n')
    .trim();
}

function currentSemesterId(now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  let startYear, sem;
  if (m >= 9) { startYear = y; sem = 1; }        // 9-12月：新学年第1学期
  else if (m >= 2) { startYear = y - 1; sem = 2; } // 2-7月：上一学年第2学期
  else { startYear = y - 1; sem = 1; }              // 1月：上一学年第1学期
  const yy = String(startYear).slice(2);
  const yy1 = String(startYear + 1).slice(2);
  return Number(yy + yy1 + sem);
}

function parseCommand(text) {
  const value = (text || '').toLowerCase().replace(/\s+/g, ' ').slice(0, 500);
  const semMatch = value.match(/\b(\d{5})\b/);
  if (semMatch) return 'semester:' + semMatch[1];
  if (/启动|开始/.test(value)) return 'start';
  if (/停止|终止/.test(value)) return 'stop';
  if (/状态/.test(value)) return 'status';
  if (/日志/.test(value)) return 'log';
  if (/总加权|加权成绩|加权平均|gpa/.test(value)) return 'weighted';
  if (/成绩单|成绩表/.test(value)) return 'grades';
  return null;
}

function readLastUid(file) {
  try { return parseInt(fs.readFileSync(file, 'utf-8').trim(), 10) || 0; }
  catch { return 0; }
}

class ImapCommandClient {
  constructor(config, options) {
    this.config = config;
    this.lastUidFile = options.lastUidFile;
    this.socketTimeoutMs = options.socketTimeoutMs;
    this.verbose = options.verbose;
    this.log = options.log || (() => {});
  }

  isConfigured() {
    return Boolean(this.config.user && this.config.pass && this.config.commandEmail);
  }

  async poll(handleCommand) {
    if (!this.isConfigured()) return 0;
    let lastUid = readLastUid(this.lastUidFile);

    return new Promise(resolve => {
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      let buffer = '';
      let tagId = 0;
      const imapTag = () => `A${++tagId}`;
      const socket = tls.connect({
        host: this.config.host,
        port: this.config.port,
        servername: this.config.host,
      });

      const waitForResponse = (tag, timeoutMs = 20_000) => new Promise((resolveResponse, reject) => {
        const timer = setTimeout(() => {
          socket.removeListener('data', onData);
          reject(new Error(`IMAP 等待 ${tag} 超时`));
        }, timeoutMs);
        function onData(data) {
          buffer += data.toString('binary');
          const match = buffer.match(new RegExp(`^${tag} (OK|NO|BAD)(?: |$)`, 'm'));
          if (!match) return;
          clearTimeout(timer);
          socket.removeListener('data', onData);
          if (match[1] === 'OK') resolveResponse();
          else reject(new Error(`IMAP ${tag} ${match[1]}`));
        }
        socket.on('data', onData);
      });

      socket.once('secureConnect', async () => {
        try {
          await new Promise((resolveGreeting, reject) => {
            const timer = setTimeout(() => reject(new Error('IMAP greeting 超时')), 15_000);
            const onData = data => {
              buffer += data.toString('binary');
              clearTimeout(timer);
              socket.removeListener('data', onData);
              resolveGreeting();
            };
            socket.on('data', onData);
          });
          if (this.verbose) this.log('IMAP', '已连接');

          const escapedUser = this.config.user.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          const escapedPass = this.config.pass.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          buffer = '';
          let tag = imapTag();
          socket.write(`${tag} LOGIN "${escapedUser}" "${escapedPass}"\r\n`);
          await waitForResponse(tag);

          buffer = '';
          tag = imapTag();
          socket.write(`${tag} SELECT INBOX\r\n`);
          await waitForResponse(tag);

          if (lastUid === 0) {
            buffer = '';
            tag = imapTag();
            socket.write(`${tag} UID SEARCH ALL\r\n`);
            await waitForResponse(tag);
            const search = buffer.match(/\* SEARCH(?: (.*?))?\r?\n/);
            const allUids = search?.[1]?.trim().split(/\s+/).filter(Boolean) || [];
            lastUid = parseInt(allUids.at(-1), 10) || 0;
            if (lastUid > 0) atomicWriteFile(this.lastUidFile, String(lastUid));
            this.log('IMAP', `初始化: 跳过已有 ${lastUid > 0 ? `UID ≤ ${lastUid}` : '邮件'}`);
          }

          buffer = '';
          tag = imapTag();
          socket.write(`${tag} UID SEARCH UID ${lastUid + 1}:*\r\n`);
          await waitForResponse(tag);
          const search = buffer.match(/\* SEARCH(?: (.*?))?\r?\n/);
          const uids = search?.[1]?.trim().split(/\s+/).filter(Boolean) || [];
          if (uids.length === 0) {
            socket.write(`${imapTag()} LOGOUT\r\n`);
            socket.end();
            finish(0);
            return;
          }

          this.log('IMAP', `发现 ${uids.length} 封新邮件 (UID: ${uids[0]}~${uids.at(-1)})`);
          let processed = 0;
          let maxUid = lastUid;
          for (const uid of uids) {
            const uidNumber = parseInt(uid, 10);
            if (!Number.isInteger(uidNumber)) continue;
            buffer = '';
            tag = imapTag();
            socket.write(`${tag} UID FETCH ${uid} (BODY.PEEK[])\r\n`);
            await waitForResponse(tag, 30_000);

            const literal = buffer.match(/BODY\[\]\s*\{(\d+)\}\r?\n/);
            if (!literal) {
              maxUid = Math.max(maxUid, uidNumber);
              continue;
            }
            const size = parseInt(literal[1], 10);
            const start = buffer.indexOf(literal[0]) + literal[0].length;
            const raw = buffer.substring(start, start + size);
            const message = splitHeadersAndBody(raw);
            if (!message) {
              maxUid = Math.max(maxUid, uidNumber);
              continue;
            }

            if (/^X-TJU-Auto-Grade:\s*true/im.test(message.headers)) {
              maxUid = Math.max(maxUid, uidNumber);
              continue;
            }
            const fromEmail = extractEmailAddress(getHeader(message.headers, 'From'));
            if (fromEmail !== this.config.commandEmail) {
              if (this.verbose) this.log('IMAP', `忽略非授权发件人: ${fromEmail || '未知'}`);
              maxUid = Math.max(maxUid, uidNumber);
              continue;
            }

            const subject = decodeRFC2047(getHeader(message.headers, 'Subject'));
            const text = extractReplyText(raw);
            const token = this.config.commandToken;
            if (token && !subject.includes(token) && !text.includes(token)) {
              this.log('IMAP', '忽略缺少 COMMAND_TOKEN 的邮件');
              maxUid = Math.max(maxUid, uidNumber);
              continue;
            }
            const command = parseCommand((subject + ' ' + text).replace(token, ''));
            if (command) {
              this.log('IMAP', `指令: ${command} (主题: ${subject})`);
              await handleCommand({ command, subject });
              processed++;
            }
            maxUid = Math.max(maxUid, uidNumber);
          }

          if (maxUid > lastUid) atomicWriteFile(this.lastUidFile, String(maxUid));
          socket.write(`${imapTag()} LOGOUT\r\n`);
          socket.end();
          if (processed > 0) this.log('IMAP', `已处理 ${processed} 封指令邮件`);
          finish(processed);
        } catch (error) {
          this.log('IMAP', `异常: ${error.message}`);
          socket.destroy();
          finish(0);
        }
      });

      socket.on('error', error => {
        this.log('IMAP', `连接失败: ${error.message}`);
        finish(0);
      });
      socket.setTimeout(this.socketTimeoutMs, () => {
        this.log('IMAP', '连接超时');
        socket.destroy();
        finish(0);
      });
    });
  }

  /**
   * IDLE 推送模式（死代码，从未被调用）
   *
   * 原计划用于 IMAP 实时推送替代轮询，但存在以下问题：
   * - 缺少 commandToken 校验（任何邮件都可触发指令）
   * - while(true) 无退出条件
   * - 手动 TLS 实现复杂，维护成本高
   *
   * 当前 poll() 每 60s 轮询已满足需求。
   * 如需 IDLE，建议：
   * 1. 新增 commandToken 校验
   * 2. 增加 graceful shutdown
   * 3. 与 poll() 二选一，不并存
   */
  async idleLoop(handleCommand) {
    // 死代码占位，完整实现见 git history
    throw new Error('idleLoop 已废弃，使用 poll() 替代');
  }
}

module.exports = {
  ImapCommandClient,
  decodeQP,
  decodeRFC2047,
  extractEmailAddress,
  extractReplyText,
  extractTextBody,
  getHeader,
  parseCommand,
  splitHeadersAndBody,
};
