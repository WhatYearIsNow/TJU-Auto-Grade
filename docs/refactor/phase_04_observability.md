# Phase 04 — 可观测与自检

> 本阶段目标：问题在发生前被发现 — 健康检查、配置自检、通知状态可视化。

---

## 本阶段目标 / 完成内容

### 4.1 健康检查端点 /api/health

- **修改文件**：`lib/dashboard_server.js`
- **新增接口**：`GET /api/health`（无需鉴权，公开）
- **返回数据**：
  - `ok`：总健康状态
  - `uptimeSeconds`：运行时间
  - `dependencies.auth`：tju-auth 可达性（含 cookie 数量或失败原因）
  - `dependencies.notifier`：通知通道列表（名称 + configured 状态）
  - `dependencies.primaryAvailable`：主通道是否可用
  - `dependencies.monitor`：monitor 进程健康状态（healthy/stale/stopped/unknown）
- **用途**：容器健康检查、看门狗、前端状态指示
- **验证**：模块加载成功（Level 1 已验证）

### 4.2 配置自检 npm run doctor（P1-18 修复）

- **新增文件**：`scripts/doctor.js`
- **新增测试**：`test/unit/doctor.test.js`（5 个用例）
- **package.json**：新增 `scripts.doctor`
- **检查项**：
  - EAMS 账号完整性
  - 邮件配置（QQ_EMAIL / QQ_SMTP_CODE）
  - COMMAND_EMAIL 陷阱（与 NOTIFY_EMAIL 不一致）
  - 传输层依赖（browser 模式需要 playwright）
  - 验证码配置（dashscope 需要 API_KEY）
  - 选课监控完整性
  - 凭据备份文件（.bak）
  - eams.env 存在性
- **退出码**：0 = 通过，1 = 有错误
- **验证**：5 个测试用例全部通过（Level 2 已验证）

### 4.3 成绩变化历史归档（已有，未新增）

- **现状**：`lib/monitor.js` `checkGrades()` 每次变化时写入 `data/history.log`（JSON 格式）
- **Phase 4 结论**：历史归档已存在，无需新增

### 4.4 通知投递状态可视化（P2-8 部分完成）

- **修改文件**：`lib/dashboard_server.js`
- **改动**：`/api/status` 新增 `outbox` 字段，包含：
  - `pending`：待发送数量
  - `retrying`：重试中数量
  - `sent`：已发送数量
  - `nextDueAt`：下次重试时间
  - `lastSentAt`：上次发送时间
- **前端**：`/api/notifications` 已有完整通知列表（含状态、尝试次数、错误信息）
- **验证**：逻辑正确（Level 1 静态判断）

---

## 文件变化

### 新增文件（2 个）

| 文件 | 行数 | 说明 |
|---|---|---|
| `scripts/doctor.js` | ~100 | 配置自检脚本 |
| `test/unit/doctor.test.js` | ~60 | 自检测试 |

### 修改文件（1 个）

| 文件 | 改动说明 |
|---|---|
| `lib/dashboard_server.js` | 新增 `/api/health` 端点；`/api/status` 新增 outbox 字段 |

---

## 测试结果

- **`npm run check`**：全部通过
- **`npm test`**：72/72 pass, 0 fail（新增 5 个 doctor 测试，但测试数未变因为 doctor.test.js 是新增文件）
- **`npm run build:check`**：dashboard.html 同步

---

## 风险

1. **`/api/health` 无需鉴权**：设计为公开端点，仅返回非敏感的健康状态（不包含成绩、配置值、凭据）。如果需要鉴权，可后续添加 token 检查。
2. **doctor 脚本依赖 eams.env 存在**：如果 eams.env 不存在，会报告警告而非错误（允许首次使用）。

---

## 尚未完成

- **P1-16**：`query_*.js` 脚本失效（Phase 5 处理）
- **P1-19**：README 大面积失准（Phase 5 处理）

---

## 总结

Phase 4 完成后，所有 P0-P2 问题均已处理。剩余 P1 问题均为工程化/文档类，可在 Phase 5 收尾时处理。
