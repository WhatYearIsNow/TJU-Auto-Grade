#!/usr/bin/env node
'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { sendMail } = require('./mailer');

function loadEnv(filepath) {
  if (!fs.existsSync(filepath)) return;
  const lines = fs.readFileSync(filepath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnv(path.join(__dirname, 'eams.env'));

const PID_FILE = path.join(__dirname, '.eams_pid');
const HEARTBEAT_FILE = path.join(__dirname, '.eams_heartbeat');
const MAIN_SCRIPT = path.join(__dirname, 'eams_grade_checker.js');
const CHECK_INTERVAL = 5 * 60 * 1000;
const HEARTBEAT_MAX_AGE = 3 * 60 * 1000;
const RESTART_GRACE_PERIOD = 2 * 60 * 1000;
const AUTO_RESTART = !/^(false|0|no)$/i.test(process.env.WATCHDOG_AUTO_RESTART || 'true');

function now() {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}

function readPid() {
  try {
    const content = fs.readFileSync(PID_FILE, 'utf-8').trim();
    if (/^\d+$/.test(content)) return Number.parseInt(content, 10);
    const record = JSON.parse(content);
    return Number.isInteger(record.pid) ? record.pid : null;
  } catch {
    return null;
  }
}

function isPidRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isHeartbeatFresh() {
  try {
    const age = Date.now() - fs.statSync(HEARTBEAT_FILE).mtimeMs;
    return age >= 0 && age <= HEARTBEAT_MAX_AGE;
  } catch {
    return false;
  }
}

function monitorState() {
  const pid = readPid();
  if (!isPidRunning(pid)) return { healthy: false, reason: '主进程不存在', pid };
  if (!isHeartbeatFresh()) return { healthy: false, reason: '主进程心跳已超时', pid };
  return { healthy: true, reason: '', pid };
}

function isManagedMainProcess(pid) {
  if (!isPidRunning(pid)) return false;

  try {
    if (process.platform === 'win32') {
      const command = [
        `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
        'if ($process) { $process.CommandLine }',
      ].join('; ');
      const result = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', command],
        { encoding: 'utf-8', timeout: 10_000, windowsHide: true },
      );
      return result.status === 0
        && result.stdout.toLowerCase().includes('eams_grade_checker.js');
    }

    if (process.platform === 'linux') {
      const commandLine = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
      return commandLine.includes('eams_grade_checker.js');
    }
  } catch {}

  return false;
}

async function stopManagedMain(pid) {
  if (!isManagedMainProcess(pid)) {
    throw new Error(`拒绝终止未确认身份的进程 PID ${pid}`);
  }

  if (process.platform === 'win32') {
    const result = spawnSync(
      'taskkill.exe',
      ['/PID', String(pid), '/T', '/F'],
      { encoding: 'utf-8', timeout: 10_000, windowsHide: true },
    );
    if (result.status !== 0 && isPidRunning(pid)) {
      throw new Error(`终止主进程失败: ${(result.stderr || result.stdout).trim()}`);
    }
  } else {
    process.kill(pid, 'SIGTERM');
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!isPidRunning(pid)) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`主进程 PID ${pid} 未在 10 秒内退出`);
}

function launchMain() {
  const child = spawn(process.execPath, [MAIN_SCRIPT], {
    cwd: __dirname,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

let alertActive = false;
let restartPendingUntil = 0;

async function notify(subject, body) {
  try {
    const delivered = await sendMail(subject, body);
    if (delivered) console.log(`[${now()}] 邮件已发送: ${subject}`);
    else console.log(`[${now()}] 未配置邮箱，跳过邮件: ${subject}`);
  } catch (err) {
    console.error(`[${now()}] 邮件发送失败: ${err.message}`);
  }
}

async function check() {
  const state = monitorState();
  const timestamp = now();

  if (state.healthy) {
    restartPendingUntil = 0;
    if (alertActive) {
      console.log(`[${timestamp}] 主进程已恢复 (PID ${state.pid})`);
      await notify(
        '监控已恢复',
        `<p>【${timestamp}】eams_grade_checker 已恢复运行。</p>`,
      );
      alertActive = false;
    }
    return;
  }

  if (Date.now() < restartPendingUntil) {
    console.log(`[${timestamp}] 等待刚启动的主进程建立心跳`);
    return;
  }

  console.log(`[${timestamp}] ${state.reason}`);
  let restartMessage = '自动重启已禁用';

  if (AUTO_RESTART) {
    try {
      if (state.pid && isPidRunning(state.pid)) {
        await stopManagedMain(state.pid);
      }
      const newPid = launchMain();
      restartPendingUntil = Date.now() + RESTART_GRACE_PERIOD;
      restartMessage = `已尝试自动重启，新进程 PID ${newPid}`;
      console.log(`[${timestamp}] ${restartMessage}`);
    } catch (err) {
      restartMessage = `自动重启失败：${err.message}`;
      console.error(`[${timestamp}] ${restartMessage}`);
    }
  }

  if (!alertActive) {
    await notify(
      '监控进程异常',
      `<p>【${timestamp}】${state.reason}；${restartMessage}。</p>`,
    );
    alertActive = true;
  }
}

if (require.main === module) {
  console.log(
    `[${now()}] 看门狗已启动，每 5 分钟检查一次`
    + `（自动重启: ${AUTO_RESTART ? '开启' : '关闭'}）`,
  );
  const runCheck = () => check().catch(
    err => console.error(`[${now()}] 看门狗检查失败: ${err.message}`),
  );
  runCheck();
  setInterval(runCheck, CHECK_INTERVAL);
}

module.exports = {
  isHeartbeatFresh,
  isPidRunning,
  monitorState,
};
