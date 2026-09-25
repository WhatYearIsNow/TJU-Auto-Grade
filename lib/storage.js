const fs = require('fs');
const path = require('path');

function atomicWriteFile(file, content) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempFile, content, 'utf-8');
    fs.renameSync(tempFile, file);
  } catch (error) {
    try { fs.unlinkSync(tempFile); } catch {}
    throw error;
  }
}

function atomicWriteJson(file, value) {
  atomicWriteFile(file, JSON.stringify(value, null, 2));
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function readGradesSnapshot(file) {
  const value = readJson(file, []);
  if (!Array.isArray(value)) throw new Error(`成绩快照格式不正确: ${file}`);
  return value;
}

function writeGradesSnapshot(file, grades) {
  if (!Array.isArray(grades)) throw new TypeError('成绩快照必须是数组');
  atomicWriteJson(file, grades);
}

function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidRecord(file) {
  try {
    const raw = fs.readFileSync(file, 'utf-8').trim();
    if (/^\d+$/.test(raw)) return { version: 0, pid: Number(raw), script: null };
    const record = JSON.parse(raw);
    if (!Number.isInteger(record.pid) || record.pid <= 0) return null;
    return record;
  } catch {
    return null;
  }
}

function readHeartbeat(file) {
  try {
    const heartbeat = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!Number.isInteger(heartbeat.pid) || !heartbeat.updatedAt) return null;
    return heartbeat;
  } catch {
    return null;
  }
}

class ProcessGuard {
  constructor(options) {
    this.pidFile = options.pidFile;
    this.heartbeatFile = options.heartbeatFile;
    this.script = path.resolve(options.script);
    this.now = options.now || (() => Date.now());
    this.pid = options.pid || process.pid;
    this.startedAt = new Date(this.now()).toISOString();
  }

  acquire() {
    const existing = readPidRecord(this.pidFile);
    if (existing && existing.pid !== this.pid && isProcessRunning(existing.pid)) {
      throw new Error(`已有实例正在运行 (PID ${existing.pid})`);
    }
    atomicWriteJson(this.pidFile, {
      version: 1,
      pid: this.pid,
      script: this.script,
      startedAt: this.startedAt,
    });
    this.beat();
  }

  beat() {
    atomicWriteJson(this.heartbeatFile, {
      version: 1,
      pid: this.pid,
      script: this.script,
      startedAt: this.startedAt,
      updatedAt: new Date(this.now()).toISOString(),
    });
  }

  release() {
    const existing = readPidRecord(this.pidFile);
    if (existing?.pid === this.pid) {
      try { fs.unlinkSync(this.pidFile); } catch {}
    }
    const heartbeat = readHeartbeat(this.heartbeatFile);
    if (heartbeat?.pid === this.pid) {
      try { fs.unlinkSync(this.heartbeatFile); } catch {}
    }
  }

  /** 释放但不删除 PID 文件（用于 dashboard 释放 monitor 的 PID） */
  releaseOwn() {
    const existing = readPidRecord(this.pidFile);
    if (existing?.pid === this.pid) {
      try { fs.unlinkSync(this.pidFile); } catch {}
    }
    const heartbeat = readHeartbeat(this.heartbeatFile);
    if (heartbeat?.pid === this.pid) {
      try { fs.unlinkSync(this.heartbeatFile); } catch {}
    }
  }
}

function inspectProcessHealth(options) {
  const record = readPidRecord(options.pidFile);
  if (!record || !isProcessRunning(record.pid)) {
    return { status: 'stopped', pid: record?.pid || null, heartbeatAgeMs: null };
  }

  const heartbeat = readHeartbeat(options.heartbeatFile);
  if (!heartbeat || heartbeat.pid !== record.pid) {
    return { status: 'unknown', pid: record.pid, heartbeatAgeMs: null };
  }

  const updatedAt = Date.parse(heartbeat.updatedAt);
  const heartbeatAgeMs = Number.isFinite(updatedAt) ? options.now() - updatedAt : Infinity;
  const actualScript = path.resolve(heartbeat.script || '').toLowerCase();
  const expectedScripts = (options.scripts || [options.script])
    .filter(Boolean)
    .map(script => path.resolve(script).toLowerCase());
  if (!expectedScripts.includes(actualScript)) {
    return { status: 'unknown', pid: record.pid, heartbeatAgeMs };
  }
  return {
    status: heartbeatAgeMs <= options.maxHeartbeatAgeMs ? 'healthy' : 'stale',
    pid: record.pid,
    heartbeatAgeMs,
  };
}

module.exports = {
  ProcessGuard,
  atomicWriteFile,
  atomicWriteJson,
  inspectProcessHealth,
  isProcessRunning,
  readGradesSnapshot,
  readHeartbeat,
  readJson,
  readPidRecord,
  writeGradesSnapshot,
};
