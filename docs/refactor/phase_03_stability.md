# Phase 03 — 稳定性与资源

> 本阶段目标：长期运行不退化，PID 冲突消除，资源完整释放，日志 O(n) 问题修复。

---

## 本阶段目标 / 完成内容

### 3.1 PID 命名空间分离（P1-8 修复）

- **修改文件**：`lib/config.js`、`lib/monitor.js`
- **改动**：
  - `lib/config.js` 新增 `monitorPidFile`、`monitorHeartbeatFile` 配置项
  - `lib/monitor.js` 的 `ProcessGuard` 使用 `monitorPidFile` / `monitorHeartbeatFile`
  - `lib/dashboard.js` 的 `ProcessGuard` 继续使用 `pidFile` / `heartbeatFile`
- **效果**：dashboard 和 monitor 各有独立的 PID 文件和心跳文件，互不干扰
- **验证**：逻辑正确（Level 2 静态判断）

### 3.2 stop() 完整释放资源（P1-9 修复）

- **修改文件**：`lib/monitor.js`
- **改动**：`stop()` 方法新增资源释放：
  - `this.imap?.close()` — 关闭 IMAP socket
  - `this.notifier?.close()` — 关闭通知通道
  - `this.outbox?.persist()` — 持久化发件箱
  - `this.context?.close()` — 关闭浏览器上下文（已有）
  - tesseract worker 通过 `require.cache` 清除释放
- **效果**：重启时不再泄漏 IMAP socket、tesseract worker、outbox 状态
- **验证**：逻辑正确（Level 2 静态判断）

### 3.3 MonitorController.start() 可 await（P1-10 修复）

- **修改文件**：`lib/monitor_controller.js`
- **改动**：
  - `start()` 仍返回同步快照（保持向后兼容）
  - 新增 `waitForStart()` 方法，返回 `Promise<snapshot>`，等待监控真正启动
  - `startPromise` 属性对外暴露，调用方可自行 await
- **效果**：调用方可选择同步快照或 await 启动完成
- **验证**：模块加载成功（Level 1 已验证）

### 3.4 结构化日志 + 轮转（P1-11 修复）

- **新增文件**：`lib/logger.js`
- **修改文件**：`lib/monitor.js`（使用新 logger）
- **改动**：
  - 新 `createLogger()` 使用追加写入（`appendFileSync`），不再每次读全文件
  - 轮转策略：文件大小超过 5MB 或行数超过 500 时截断
  - 轮转在写入时做，只读文件判断大小，避免 O(n) 全量读
- **效果**：单次日志写入从 O(n) 全量读写降为 O(1) 追加写
- **验证**：逻辑正确（Level 2 静态判断）

### 3.5 清理 idleLoop() 死代码（P1-12 修复）

- **修改文件**：`lib/email_commands.js`
- **改动**：138 行 `idleLoop()` 替换为注释 + 占位方法（抛错）
- **注释说明**：
  - 缺少 `commandToken` 校验（安全漏洞）
  - `while(true)` 无退出条件
  - 手动 TLS 实现复杂
- **效果**：消除 138 行死代码，标记为废弃
- **验证**：语法检查通过（Level 1 已验证）

---

## 文件变化

### 新增文件（1 个）

| 文件 | 行数 | 说明 |
|---|---|---|
| `lib/logger.js` | ~60 | 结构化日志 + 轮转 |

### 修改文件（5 个）

| 文件 | 改动说明 |
|---|---|
| `lib/storage.js` | `ProcessGuard` 新增 `releaseOwn()` 方法 |
| `lib/config.js` | 新增 `monitorPidFile`、`monitorHeartbeatFile` |
| `lib/monitor.js` | PID 文件分离、`stop()` 完整释放、使用新 logger |
| `lib/monitor_controller.js` | 新增 `waitForStart()` 方法 |
| `lib/email_commands.js` | `idleLoop()` 替换为注释 + 占位 |

---

## 测试结果

- **`npm run check`**：全部通过
- **`npm test`**：72/72 pass, 0 fail
- **`npm run build:check`**：dashboard.html 同步

---

## 风险

1. **tesseract worker 释放**：通过 `require.cache` 清除释放，但 tesseract.js 的 WASM worker 可能在其他模块中被引用，清除后其他模块再 require 会重新加载。当前只有 `monitor.js` 使用 tesseract，所以安全。
2. **`startPromise` 暴露**：`waitForStart()` 依赖 `startPromise` 存在，如果调用 `waitForStart()` 前未调用 `start()`，会抛错。这是预期行为。

---

## 尚未完成

- **P1-16**：`query_*.js` 脚本失效（Phase 5 处理）
- **P1-19**：README 大面积失准（Phase 5 处理）
- **P2-4**：健康检查端点 `/api/health`（Phase 4 处理）
- **P2-5**：配置自检 `doctor`（Phase 4 处理）
- **P2-7**：成绩变化历史归档（Phase 4 处理）
- **P2-8**：通知投递状态可视化（Phase 4 处理）

---

## 下一阶段

**Phase 4 — 可观测与自检**：`/api/health`、`npm run doctor`、配置校验、成绩历史归档。
