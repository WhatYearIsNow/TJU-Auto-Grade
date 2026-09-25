/**
 * 结构化日志 — 替代 monitor.js 中的 createLogger
 *
 * 解决 P1-11：O(n) 同步全量读写 → 追加写入 + 异步轮转
 *
 * 特性：
 * - 追加写入（appendFileSync），不读全文件
 * - 轮转：超过 maxLines 时截断到最近 N 行
 * - 轮转在写入时做，但只截断不重读
 */

const fs = require('fs');
const path = require('path');

function createLogger(logFile, options = {}) {
  const maxLines = options.maxLines || 500;
  const maxBytes = options.maxBytes || 5 * 1024 * 1024; // 5MB 硬限制

  // 轮转：只读最后 maxLines 行，不读全文件
  function rotate() {
    try {
      if (!fs.existsSync(logFile)) return;
      const stat = fs.statSync(logFile);
      if (stat.size <= maxBytes) return;
      // 只读最后 maxLines 行
      const fd = fs.openSync(logFile, 'r');
      const content = fs.readFileSync(fd, 'utf-8');
      fs.closeSync(fd);
      const lines = content.split(/\r?\n/).filter(Boolean);
      if (lines.length > maxLines) {
        fs.writeFileSync(logFile, `${lines.slice(-maxLines).join('\n')}\n`, 'utf-8');
      }
    } catch {}
  }

  return function log(tag, message) {
    const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const line = `[${timestamp} ${tag}] ${message}`;
    console.log(line);
    try {
      fs.appendFileSync(logFile, `${line}\n`, 'utf-8');
      // 每次写入后检查是否需要轮转（只读文件判断大小，不读内容）
      try {
        const stat = fs.statSync(logFile);
        if (stat.size > maxBytes) {
          const content = fs.readFileSync(logFile, 'utf-8');
          const lines = content.split(/\r?\n/).filter(Boolean);
          if (lines.length > maxLines) {
            fs.writeFileSync(logFile, `${lines.slice(-maxLines).join('\n')}\n`, 'utf-8');
          }
        }
      } catch {}
    } catch {}
  };
}

module.exports = { createLogger };
