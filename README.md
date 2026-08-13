# 天津大学自动查分系统

[![CI](https://github.com/WhatYearIsNow/tju-auto-grade/actions/workflows/ci.yml/badge.svg)](https://github.com/WhatYearIsNow/tju-auto-grade/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

基于 Playwright 的 TJU EAMS 成绩监控工具。程序保持浏览器会话，定时抓取成绩；发现新成绩、分数调整或成绩明细变化后，通过 QQ 邮箱发送通知。

正式入口是本机 Web 控制台 `dashboard.js`，默认地址为 `http://127.0.0.1:3765`。控制台与成绩监控运行在同一进程中；`eams_grade_checker_v2.js` 保留为纯终端备用入口。

## 功能

- 定时监控全部学期成绩，默认每 5 分钟检查一次
- 只推送发生变化的课程，支持新增、修改和移除
- 使用学期、课程代码、课程名称和教学班组成课程标识，避免重修或同名教学班互相覆盖
- 监控总评、绩点、平时、期末和实验成绩明细
- 会话过期后优先尝试 AI 自动重新登录，失败时等待手动登录并发邮件提醒
- 重启时对比本地快照，补发停机期间出现的成绩变化
- 成绩变化先写入持久化通知队列，邮件失败后指数退避重试并自动去重
- 回复通知邮件可查询状态、成绩单、总加权和变化日志
- 页面操作加锁，避免定时检查与邮件指令同时操作浏览器
- PID + 心跳防重复启动并判断运行健康度，支持优雅退出、日志轮转和可选自动重启看门狗
- SMTP 统一使用 Nodemailer，发送失败进入持久化队列并自动重试
- 本机 Web 控制台集中展示状态、成绩、通知队列、日志和配置
- 在页面中立即查分、查询总加权、重试通知、测试邮箱以及启动/停止/重启监控
- 设置页面只显示敏感凭据是否已配置，留空保存不会覆盖原密码或授权码

## 环境要求

- Windows 10/11
- Node.js 22 或更高版本
- Microsoft Edge（默认）
- 可访问天津大学 EAMS 与统一认证系统的网络
- QQ 邮箱 SMTP/IMAP 服务（需要邮件通知或邮件指令时）

## 快速开始

```powershell
npm ci
npm start
```

控制台会自动打开首次配置页面。填写学号和教务密码后即可启动监控；邮件通知、验证码模型、检查频率和浏览器模式也可以在页面中设置。

如果需要预先准备配置文件，可以复制示例并手动编辑：

```powershell
Copy-Item eams.env.example eams.env
```

至少填写教务账号；若需要邮件通知，还要填写 QQ 邮箱和授权码：

```env
EAMS_USERNAME=你的学号
EAMS_PASSWORD=你的教务密码
QQ_EMAIL=你的QQ号@qq.com
QQ_SMTP_CODE=你的QQ邮箱授权码
NOTIFY_EMAIL=接收通知的邮箱
DASHSCOPE_API_KEY=sk-xxxx
```

也可以双击 `快速使用\查成绩.bat`。启动后会自动打开控制台；若没有自动打开，请访问 `http://127.0.0.1:3765`。快捷脚本使用相对路径，项目移动到其他目录后仍可运行。

首次运行会打开 Edge。若没有配置千问 API Key，或验证码自动识别失败，请在浏览器中完成登录；登录状态会保存在 `.eams_profile`。

如果尚未创建 `eams.env`，控制台只启动配置界面，不会提前打开教务浏览器。填写学号和教务密码并保存后，监控才会启动；QQ 邮箱、通用 SMTP/IMAP、检查频率和浏览器模式也都可以直接在页面中配置。

## 配置项

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `EAMS_USERNAME` | 无 | 学号；未配置时可在终端或浏览器中输入 |
| `EAMS_PASSWORD` | 无 | 教务密码 |
| `QQ_EMAIL` | 无 | QQ 发件邮箱，同时用于 IMAP 收取指令 |
| `QQ_SMTP_CODE` | 无 | QQ 邮箱 SMTP/IMAP 授权码，不是邮箱密码 |
| `NOTIFY_EMAIL` | `QQ_EMAIL` | 通知接收邮箱 |
| `COMMAND_EMAIL` | `NOTIFY_EMAIL` | 唯一允许发送查询指令的邮箱 |
| `COMMAND_TOKEN` | 无 | 可选指令口令；设置后邮件主题或正文必须包含它 |
| `DASHSCOPE_API_KEY` | 无 | 千问视觉 API Key，用于验证码识别和自动重登录 |
| `VISION_MODEL` | `qwen3.5-ocr` | 验证码识别模型，可在设置页面修改 |
| `CHECK_INTERVAL_MINUTES` | `5` | 成绩检查间隔，最小 1 分钟 |
| `IMAP_ENABLED` | `true` | 是否启用邮件指令轮询 |
| `IMAP_INTERVAL_SECONDS` | `60` | 邮件轮询间隔，最小 15 秒 |
| `IMAP_SOCKET_TIMEOUT_SECONDS` | `600` | 邮件指令等待页面操作的最长空闲连接时间 |
| `RELOGIN_TIMEOUT_MINUTES` | `10` | 自动登录失败后等待手动登录的时间 |
| `BROWSER_CHANNEL` | `msedge` | Playwright 浏览器通道 |
| `HEADLESS` | `false` | 无头模式；启用后无法手动处理登录 |
| `DASHBOARD_PORT` | `3765` | 本机控制台端口，只监听 `127.0.0.1` |
| `DASHBOARD_AUTO_OPEN` | `true` | 启动后是否自动打开控制台页面 |
| `OUTBOX_POLL_INTERVAL_SECONDS` | `30` | 通知队列后台检查间隔，最小 10 秒 |
| `OUTBOX_RETRY_BASE_SECONDS` | `60` | 邮件失败后的首次重试等待时间 |
| `OUTBOX_RETRY_MAX_SECONDS` | `3600` | 指数退避的最长等待时间 |
| `OUTBOX_RETENTION_DAYS` | `30` | 已发送事件的去重保留天数 |
| `WATCHDOG_AUTO_RESTART` | `true` | 看门狗发现主进程退出后是否自动重启 |
| `WATCHDOG_INTERVAL_MINUTES` | `5` | 看门狗检查间隔 |
| `WATCHDOG_HEARTBEAT_MAX_AGE_MINUTES` | `3` | 超过该时间未更新心跳则判定为卡住 |
| `HEARTBEAT_INTERVAL_SECONDS` | `30` | 主进程写入健康心跳的间隔 |

非 QQ 邮箱可以通过 `SMTP_HOST`、`SMTP_PORT`、`SMTP_SECURE`、`SMTP_USER`、`SMTP_PASS` 以及对应的 `IMAP_*` 配置覆盖默认服务器。

不要提交 `eams.env`。该文件包含教务密码、邮箱授权码和 API Key，已加入 `.gitignore`。

## 本机控制台

控制台包含五个页面：

- **运行概览**：查看监控状态、课程数量、运行时间、失败次数和服务能力
- **成绩中心**：默认显示最近 8 个学期，更早学期可按需展开；支持搜索、筛选、查看成绩明细和即时查询总加权，历史查询不会覆盖监控快照
- **通知记录**：查看待发送、重试中和已发送的成绩通知
- **运行日志**：实时查看最近 200 条日志
- **系统设置**：修改登录、邮箱、检查频率和浏览器模式，保存后自动重启监控

设置页支持导入和导出 JSON 配置，方便在其他电脑复现相同参数。导出文件不会包含教务密码、邮箱授权码、邮件指令口令或 API Key，这些敏感信息需要在新设备上重新填写。

控制台只绑定本机回环地址，外部设备无法访问。所有写操作还会验证页面来源和每次启动随机生成的安全令牌。

浏览器实际加载的是 `web/dashboard.html`。这是由页面结构、样式和交互脚本合并生成的单个 HTML 文件；运行 `npm start` 时会自动重新生成。HTML 负责显示和操作，本机后台负责登录教务系统、查分及邮件通知。

若希望直接双击 HTML 自动启动后台，请先运行一次根目录下的 `安装HTML启动支持.bat`。安装后双击 `web/dashboard.html`，页面会自动启动隐藏的本机服务并跳转到控制台；首次唤起时 Edge 可能要求确认打开 TJU Auto Grade。需要移除该功能时运行 `卸载HTML启动支持.bat`。

## 邮件指令

直接从 `COMMAND_EMAIL` 回复任意通知邮件，正文中包含下列指令之一：

| 指令 | 作用 |
|---|---|
| `状态` / `status` | 查看运行时长、最近检查结果和日志 |
| `成绩单` / `成绩` | 即时抓取成绩页 |
| `总加权` / `加权` | 即时抓取累计成绩页面 |
| `日志` / `log` | 查看最近成绩变化记录 |
| `帮助` / `help` | 返回指令列表 |

程序只接受 `COMMAND_EMAIL` 发来的指令，并跳过带有自身标记的通知邮件，避免其他来信误触发操作或形成邮件循环。

## 看门狗

在另一个终端运行：

```powershell
npm run watchdog
```

看门狗默认每 5 分钟同时检查 `.eams_pid` 与 `.eams_heartbeat`。主进程确实退出后会尝试后台重启；如果 PID 仍存在但心跳停止，只报警而不强制结束进程，避免 PID 复用时误杀其他程序。若只想报警而不自动重启，可在 `eams.env` 中设置：

```env
WATCHDOG_AUTO_RESTART=false
```

## 常用命令

```powershell
npm start             # 启动本机 Web 控制台和监控
npm run dashboard     # 同上
npm run build         # 重新生成单文件 HTML
npm run build:check   # 检查单文件 HTML 是否与页面源码同步
npm run monitor       # 仅启动纯终端监控
npm run start:legacy  # 兼容旧命令，启动纯终端监控
npm run watchdog      # 启动看门狗
npm run check         # 检查仓库内全部 JavaScript 文件
npm test              # 运行离线单元测试
npm run test:ui       # 运行桌面端、手机端和首次配置浏览器验收
npm run validate      # 执行提交前的完整代码检查与测试
npm run verify        # 实际启动并关闭一次浏览器，验证本机运行环境
npm run test:email    # 交互式发送测试邮件
```

单元测试和界面验收使用隔离的模拟数据，不会访问教务系统或发送邮件。首次运行界面验收前，需要执行 `python -m pip install -r requirements-ui.txt` 和 `python -m playwright install chromium`；本机默认使用 Edge，也可设置 `DASHBOARD_BROWSER_CHANNEL=chromium`。

GitHub Actions 会在 Windows 和 Linux 上使用 Node.js 22、24 执行同一套验证，另在 Chromium 中验收桌面端、手机端、首次配置与配置导入导出，并单独检查生产依赖安全公告。

## 运行文件

| 文件 | 说明 |
|---|---|
| `dashboard.js` / `web/dashboard.html` | 本机控制台入口与单文件 HTML |
| `web/index.html` / `web/styles.css` / `web/app.js` | 单文件 HTML 的可维护源文件 |
| `lib/dashboard.js` | 控制台生命周期、PID 与心跳 |
| `lib/dashboard_server.js` | 本机 API、静态资源和写操作安全校验 |
| `lib/monitor_controller.js` | 在网页中启动、停止和重启监控 |
| `eams_grade_checker_v2.js` | 纯终端备用入口 |
| `lib/monitor.js` | 监控调度、通知队列和生命周期 |
| `lib/eams.js` | 登录、成绩页抓取和表格解析 |
| `lib/grades.js` | 课程标识、成绩差异和邮件内容 |
| `lib/email_commands.js` | 邮件正文解析与 IMAP 指令轮询 |
| `lib/mailer.js` | 统一、安全的 SMTP 发送 |
| `lib/config.js` / `lib/storage.js` | 配置、原子快照、PID 和心跳 |
| `vision.js` | 验证码视觉识别客户端 |
| `watchdog.js` | 进程检查与自动重启 |
| `test_email.js` | 邮件模板与 SMTP 测试 |
| `grades_latest.json` | 最近一次成绩快照，自动生成 |
| `notification_outbox.json` | 持久化通知队列和发送状态，自动生成 |
| `eams_monitor.log` | 最近 500 行运行日志，自动生成 |
| `.eams_profile/` | 浏览器登录状态，自动生成 |
| `.imap_last_uid` | 已处理邮件 UID，自动生成 |
| `.eams_heartbeat` | 主进程健康心跳，自动生成 |

## 常见问题

1. 登录后仍反复跳回统一认证：关闭其他占用 `.eams_profile` 的浏览器或脚本，确认只启动了一个实例，再重新登录。
2. 收不到邮件：在 QQ 邮箱设置中开启 SMTP 和 IMAP，确认填写的是授权码，并运行 `npm run test:email`。
3. 邮件回复没有响应：检查发件邮箱是否与 `COMMAND_EMAIL` 完全一致，并查看 `eams_monitor.log`。
4. Edge 无法启动：确认 Edge 已安装；也可以安装 Playwright Chromium 后，将 `BROWSER_CHANNEL` 改为 `chromium`。
5. 想彻底重新登录：退出程序后删除 `.eams_profile`，再运行 `npm start`。

## 隐私说明

成绩快照、通知队列、浏览器会话、日志和凭据均保存在本机。通知队列包含待发送邮件正文，因此也被排除在 Git 之外。验证码图片只在识别期间临时生成，使用后会删除；启用 AI 验证码识别时，图片会发送到你配置的视觉模型服务。

## 贡献与许可证

提交修改前请阅读 [贡献指南](CONTRIBUTING.md)。安全问题请按照 [安全策略](SECURITY.md) 私下报告，不要在公开 Issue 中附带凭据、日志或成绩数据。

本项目采用 [MIT License](LICENSE)。
