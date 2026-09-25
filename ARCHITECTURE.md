# 天津大学自动查分系统 — 架构文档

## 1. 系统概述

本系统是一个基于 Node.js 的 TJU EAMS 成绩监控工具，通过 HTTP 直连或 Playwright 浏览器登录天津大学教务系统，定时抓取成绩变化并通过邮件通知用户。系统以本机 Web 控制台 `bin/dashboard.js` 为正式入口，提供监控管理、成绩查询、通知队列查看、运行日志和配置修改等全部功能。

## 2. 架构分层

```
┌─────────────────────────────────────────────────────────────┐
│                    本机 Web 控制台 (Dashboard)               │
│  bin/dashboard.js → lib/dashboard.js → lib/dashboard_server.js │
│  端口 127.0.0.1:3765 · 静态页面: web/dashboard.html         │
├─────────────────────────────────────────────────────────────┤
│                    监控控制器 (Monitor Controller)           │
│  lib/monitor_controller.js                                   │
│  生命周期: start / stop / restart / checkNow                 │
├─────────────────────────────────────────────────────────────┤
│                    监控核心 (Grade Monitor)                  │
│  lib/monitor.js                                              │
│  调度: 成绩检查 · IMAP 轮询 · 通知队列 · 心跳 · 浏览器管理    │
├──────────────┬──────────────────┬────────────────────────────┤
│  传输层       │  通知层          │  存储层                    │
│  eams.js     │  notifier/       │  storage.js                │
│  http_eams_  │  smtp.js         │  notification_outbox.js    │
│  client.js   │  qq.js           │  grades_latest.json        │
├──────────────┴──────────────────┴────────────────────────────┤
│  辅助模块: config · grades · email_commands · captcha_ocr     │
│           semester · elect_monitor · errors · logger          │
└─────────────────────────────────────────────────────────────┘
```

## 3. 核心模块

### 3.1 传输层

系统支持两种传输方式，通过 `EAMS_TRANSPORT` 环境变量切换：

- **HTTP 直连（默认 `http`）**：使用 Node.js 原生 `fetch` 直接请求 CAS 和 EAMS 接口。登录流程：GET CAS 入口 → 302 到 CAS → 获取验证码 → DES 加密表单 → POST 提交。不启动浏览器，常驻内存约 60MB。
- **Playwright 浏览器（`browser`）**：通过 Playwright 启动 Chromium/Edge 浏览器实例，模拟完整浏览器操作。需要浏览器二进制。

CAS 登录使用天津大学自定义 DES 加密（`lib/tju_cas_des.js`），加密学号 + 密码 + CAS 登录令牌（lt）。

### 3.2 成绩监控

`lib/monitor.js` 中的 `GradeMonitor` 类是核心调度器：

1. **启动阶段**：获取 PID 锁 → 检查 auth 服务和通知通道健康 → 重发待通知 → 启动浏览器/初始化 HTTP 客户端 → 登录 → 自动发现最新学期 → 抓取初始成绩快照 → 对比历史快照补发停机期间变化
2. **运行阶段**：定时器驱动的成绩检查 → 成绩 diff → 变化入队 → 通知队列批量发送 → IMAP 邮件指令轮询
3. **会话管理**：CASTGC 静默续期 → 验证码登录 → 手动登录等待（超时退出）
4. **关闭阶段**：清除定时器 → 释放 IMAP 连接 → 关闭通知通道 → 持久化出队 → 关闭浏览器 → 清除 tesseract worker → 释放 PID 锁

### 3.3 通知系统

通知系统采用可插拔通道架构（`lib/notifier/`）：

- **主通道 SMTP**：通过 `lib/mailer.js`（nodemailer）发送 QQ 邮箱或任意 SMTP 邮件
- **辅助通道 NapCat QQ**：通过 HTTP API 发送 QQ 私聊消息，失败静默忽略
- **降级策略**：主通道成功 → 辅助通道失败仅记录日志；主通道失败 → 不重试辅助通道
- **持久化发件箱**（`lib/notification_outbox.js`）：所有成绩变化写入 JSON 文件，支持指数退避重试、SHA-256 指纹去重、保留天数自动清理

### 3.4 邮件指令

`lib/email_commands.js` 中的 `ImapCommandClient` 支持两种模式：

- **IDLE 推送模式**：通过 TLS 原生 IMAP IDLE 命令实时接收新邮件
- **轮询模式**（默认）：定期 IMAP FETCH 检查新邮件

指令解析支持中文和英文指令名，通过发件邮箱地址和可选指令口令双重验证。通知邮件带有 `X-TJU-Auto-Grade` 标记，避免循环响应。

### 3.5 本机控制台

`lib/dashboard_server.js` 提供 HTTP API 和静态页面服务：

- **只绑定 127.0.0.1**：外部设备无法访问
- **写操作安全令牌**：页面加载时生成随机 nonce，POST 请求必须携带 `X-TJU-Dashboard-Token` 头
- **CSP 头**：限制脚本和样式来源
- **API 端点**：
  - `GET /api/status` — 监控状态、能力指示器
  - `GET /api/grades` — 成绩快照
  - `GET /api/semesters` — 学期列表
  - `GET /api/notifications` — 通知队列
  - `GET /api/logs` — 运行日志
  - `GET /api/settings` — 可编辑配置
  - `GET /api/health` — 健康检查（auth、通知通道、监控 PID）
  - `POST /api/actions/*` — 启动/停止/重启/检查/重试/加权/选课监控
  - `POST /api/settings` — 保存配置（自动重启）

### 3.6 进程守护

`lib/storage.js` 中的 `ProcessGuard` 使用 PID 文件 + 心跳文件双重机制：

- **PID 文件**：防止重复启动
- **心跳文件**：判断进程是否真正存活（看门狗据此决定是否需要重启）
- **独立 PID/心跳**：dashboard 和 monitor 各自使用独立的 PID 和心跳文件，避免冲突

### 3.7 选课监控

`lib/elect_monitor.js` 是通用选课捡漏引擎，通过配置目标课程 ID、名称、教师和时间来监控课程余量。通过控制台 `/api/actions/elect-start` 和 `/api/actions/elect-stop` 管理，也可独立运行 `bin/elect_loop.js`。

## 4. 数据流

### 4.1 成绩检查流程

```
定时器 → checkGrades()
  → eams.extractGrades({ semesterId })
  → diffGrades(lastGrades, freshGrades)
  → changes.length > 0
    → createGradeNotification(change)
    → outbox.enqueueMany(events)  [SHA-256 去重]
    → flushOutbox()
      → notifier.send(subject, body)  [SMTP 主 + QQ 辅]
      → outbox.process(callback)  [指数退避重试]
  → writeGradesSnapshot(lastGradesFile)
  → append to history.log
```

### 4.2 邮件指令流程

```
IMAP poll → 新邮件
  → 过滤 From == COMMAND_EMAIL
  → 跳过 X-TJU-Auto-Grade 标记
  → parseCommand(subject + body)
  → 页面锁保护 → 执行指令 → 回复邮件
```

### 4.3 学期自动发现

```
listSemesters()
  → historyCourseGrade 接口
  → 解析 HTML 表格
  → 返回 { id, label } 数组
  → 取 id 最大的作为当前学期
```

## 5. 错误分类体系

`lib/errors.js` 定义了错误层次：

```
EamsError (base)
  ├── TransportError — 网络/传输层错误 (retryable: true)
  ├── AuthError — 认证/验证码错误 (retryable: true)
  ├── ServerError — 服务端错误 (alert: true, retryable: true)
  └── EmptyDataError — 空数据 (retryable: false, failCount: false)
```

`classifyError()` 根据错误消息关键词自动分类，使监控系统能区分可恢复错误和需要人工干预的错误。

## 6. 配置体系

`lib/config.js` 统一解析 `eams.env` 文件和 `process.env`，提供以下特性：

- 环境变量优先级高于 `.env` 文件
- 数值范围校验（`envNumber`）
- 布尔值标准化（`envBoolean`）
- 所有配置项通过 `Object.freeze` 不可变
- 时间配置统一使用毫秒内部表示，环境变量使用人类可读单位

## 7. 日志系统

`lib/logger.js` 提供结构化日志：

- 追加写模式（append-only），避免 O(n) 文件读取
- 自动轮转（默认 500 行）
- 写入失败不阻塞主流程

## 8. 安全设计

- **本机绑定**：控制台和所有 API 只监听 127.0.0.1
- **写操作令牌**：POST 请求需要页面加载时生成的随机 nonce
- **Origin 校验**：跨域写操作验证来源
- **凭据隔离**：`eams.env` 加入 `.gitignore`，`.bak` 文件自动忽略
- **通知去重**：SHA-256 指纹防止重复通知
- **CSP 头**：限制脚本和样式来源
- **敏感字段脱敏**：设置 API 不返回密码和授权码
