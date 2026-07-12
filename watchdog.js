const fs = require('fs');
const path = require('path');
const tls = require('tls');

function loadEnv(filepath) {
  if (!fs.existsSync(filepath)) return;
  const lines = fs.readFileSync(filepath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnv(path.join(__dirname, 'eams.env'));

const PID_FILE = path.join(__dirname, '.eams_pid');

function now() {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}

function isMainRunning() {
  try {
    const pid = fs.readFileSync(PID_FILE, 'utf-8').trim();
    // 检查该 PID 的进程是否还在运行
    try {
      process.kill(parseInt(pid), 0); // 信号 0 只检查不杀进程
      return true;
    } catch {
      return false;
    }
  } catch {
    return false; // PID 文件不存在
  }
}

function sendMail(subject, body) {
  return new Promise((resolve, reject) => {
    const smtpUser = process.env.QQ_EMAIL;
    const smtpPass = process.env.QQ_SMTP_CODE;
    const toEmail = process.env.NOTIFY_EMAIL || smtpUser;
    if (!smtpUser || !smtpPass) { console.log('[FAIL] 未配置邮箱'); return resolve(false); }

    const raw = [
      `From: "tju-auto-grade" <${smtpUser}>`,
      `To: <${toEmail}>`,
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=UTF-8',
      '',
      body,
    ].join('\r\n');

    const socket = tls.connect({ host: 'smtp.qq.com', port: 465 }, () => {
      let step = 0;
      function send(cmd) { socket.write(cmd + '\r\n'); }
      socket.on('data', (d) => {
        const code = parseInt(d.toString().slice(0, 3));
        if (code >= 500) return reject(new Error(`SMTP ${code}`));
        switch (step) {
          case 0: step = 1; send('EHLO eams-watchdog'); break;
          case 1: step = 2; send('AUTH LOGIN'); break;
          case 2: step = 3; send(Buffer.from(smtpUser).toString('base64')); break;
          case 3: step = 4; send(Buffer.from(smtpPass).toString('base64')); break;
          case 4: step = 5; send(`MAIL FROM:<${smtpUser}>`); break;
          case 5: step = 6; send(`RCPT TO:<${toEmail}>`); break;
          case 6: step = 7; send('DATA'); break;
          case 7: step = 8; send(raw + '\r\n.'); break;
          case 8: send('QUIT'); console.log(`[${now()}] 报警已发送`); resolve(true); break;
        }
      });
    });
    socket.on('error', reject);
    socket.setTimeout(30000, () => reject(new Error('SMTP 超时')));
  });
}

// ── 主循环：每 5 分钟检查一次 ──
const CHECK_INTERVAL = 5 * 60 * 1000;
let alertSent = false;

async function check() {
  const running = isMainRunning();
  const ts = now();

  if (running) {
    if (alertSent) {
      console.log(`[${ts}] 主进程已恢复`);
      try {
        await sendMail('监控已恢复', `<p>【${ts}】eams_grade_checker 进程已恢复运行。</p>`);
      } catch {}
      alertSent = false;
    }
  } else {
    if (!alertSent) {
      console.log(`[${ts}] 主进程未运行，发送报警...`);
      try {
        await sendMail('监控进程异常中止',
          `<p>【${ts}】eams_grade_checker 进程未在运行，请检查。</p>`);
        alertSent = true;
      } catch (err) {
        console.error(`[${ts}] 报警发送失败: ${err.message}`);
      }
    }
  }
}

console.log(`[${now()}] 看门狗已启动，每 5 分钟检查一次 (PID 文件: ${PID_FILE})`);
check();
setInterval(check, CHECK_INTERVAL);
