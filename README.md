# 天津大学自动查分系统

基于 Node.js 的 TJU EAMS 成绩监控工具。程序通过 HTTP 直连教务系统（默认模式），定时抓取成绩；发现变化后通过 QQ 邮箱（SMTP）发送通知，也可配置 NapCat QQ 作为辅助通道。

正式入口是本机 Web 控制台 `bin/dashboard.js`，默认地址为 `http://127.0.0.1:3765`。

## 功能

- 定时监控最新学期成绩，默认每 5 分钟检查一次
- 自动发现学期列表，学期轮换后自动切换到最新学期
- 只推送发生变化的课程（支持新增、修改、学分变化）
- 使用学期、课程代码、课程名称和教学班组成课程标识，避免同名教学班覆盖
- 监控总评、绩点、平时、期末和实验成绩明细
- 会话过期后优先尝试 CASTGC 静默续期，失败时走验证码登录
- 重启时对比本地快照，补发停机期间出现的成绩变化
- 成绩变化写入持久化通知队列，邮件失败后指数退避重试并自动去重
- 回复通知邮件可查询状态、成绩单、总加权和变化日志
- 页面操作加锁，避免定时检查与邮件指令同时操作
- PID + 心跳防重复启动并判断运行健康度
- 通知通道可插拔：SMTP（主）+ NapCat QQ（辅），失败可见
- 本机 Web 控制台集中展示状态、成绩、通知队列、日志和配置
- 健康检查端点 `/api/health`，支持容器化部署

## 环境要求

- Node.js 22 或更高版本（Node 20 也可运行）
- 可访问天津大学 EAMS (`classes.tju.edu.cn`) 与统一认证系统 (`sso.tju.edu.cn`) 的网络
- QQ 邮箱 SMTP/IMAP 服务（需要邮件通知或邮件指令时）
- Playwright Chromium（仅在 `EAMS_TRANSPORT=browser` 时需要）

## 快速开始

```bash
npm ci
npm start
```

控制台会自动打开首次配置页面。填写学号和教务密码后即可启动监控。

如需预先准备配置文件：

```bash
cp eams.env.example eams.env
```

至少填写教务账号；若需要邮件通知，还要填写 QQ 邮箱和授权码：

```env
EAMS_USERNAME=你的学号
EAMS_PASSWORD=你的教务密码
QQ_EMAIL=你的QQ号@qq.com
QQ_SMTP_CODE=你的QQ邮箱授权码
NOTIFY_EMAIL=接收通知的邮箱
```

## 传输模式

默认使用 `EAMS_TRANSPORT=http`（纯 Node.js fetch 直连，不启动浏览器，常驻约 60MB）。如需浏览器模式，改为 `EAMS_TRANSPORT=browser`，此时需要安装 Playwright Chromium。

## 配置项

| 变量 | 默认值 | 说明 |
|---|---|---|
| `EAMS_USERNAME` | 无 | 学号 |
| `EAMS_PASSWORD` | 无 | 教务密码 |
| `QQ_EMAIL` | 无 | QQ 发件邮箱，同时用于 IMAP 收取指令 |
| `QQ_SMTP_CODE` | 无 | QQ 邮箱 SMTP 授权码 |
| `NOTIFY_EMAIL` | `QQ_EMAIL` | 通知接收邮箱 |
| `COMMAND_EMAIL` | `NOTIFY_EMAIL` | 邮件指令发件邮箱 |
| `COMMAND_TOKEN` | 无 | 可选指令口令 |
| `DASHSCOPE_API_KEY` | 无 | 千问视觉 API Key（验证码备用通道） |
| `VISION_MODEL` | `qwen3.5-ocr` | 验证码识别模型 |
| `CAPTCHA_PROVIDER` | `tesseract` | 验证码识别方式：`tesseract`（本地 WASM）或 `dashscope`（千问） |
| `CHECK_INTERVAL_MINUTES` | `5` | 成绩检查间隔（1-1440 分钟） |
| `EAMS_TRANSPORT` | `http` | 传输层：`http`（纯 Node fetch）或 `browser`（Playwright） |
| `BROWSER_CHANNEL` | `msedge` | Playwright 浏览器通道（仅 browser 模式） |
| `HEADLESS` | `false` | 无头模式（仅 browser 模式） |
| `DASHBOARD_PORT` | `3765` | 控制台端口（只监听 127.0.0.1） |
| `DASHBOARD_AUTO_OPEN` | `true` | 启动后自动打开浏览器 |
| `IMAP_ENABLED` | `true` | 启用邮件指令轮询 |
| `IMAP_INTERVAL_SECONDS` | `60` | 邮件轮询间隔（15-3600 秒） |
| `IMAP_SOCKET_TIMEOUT_SECONDS` | `600` | IMAP 连接超时（60-1800 秒） |
| `RELOGIN_TIMEOUT_MINUTES` | `10` | 自动登录失败后等待手动登录的时间 |
| `OUTBOX_POLL_INTERVAL_SECONDS` | `30` | 通知队列检查间隔（10-3600 秒） |
| `OUTBOX_RETRY_BASE_SECONDS` | `60` | 邮件失败首次重试等待（10-3600 秒） |
| `OUTBOX_RETRY_MAX_SECONDS` | `3600` | 指数退避最长等待（60-86400 秒） |
| `OUTBOX_RETENTION_DAYS` | `30` | 已发送事件去重保留天数（1-365 天） |
| `WATCHDOG_INTERVAL_MINUTES` | `5` | 看门狗检查间隔（1-1440 分钟） |
| `WATCHDOG_HEARTBEAT_MAX_AGE_MINUTES` | `3` | 心跳超时判定（1-1440 分钟） |
| `WATCHDOG_AUTO_RESTART` | `true` | 看门狗是否自动重启 |
| `HEARTBEAT_INTERVAL_SECONDS` | `30` | 心跳写入间隔（10-300 秒） |
| `AUTH_SERVICE_URL` | 无 | tju-auth 共享登录服务地址（可选） |
| `AUTH_SERVICE_TOKEN` | 无 | tju-auth 认证令牌 |
| `NAPCAT_URL` | `http://127.0.0.1:3002/send_private_msg` | NapCat HTTP API 地址 |
| `NAPCAT_TOKEN` | 无 | NapCat 认证令牌 |
| `QQ_TARGET_USER` | 无 | QQ 通知目标用户 |
| `ELECT_TARGET_ID` | 无 | 选课监控目标课程 ID |
| `ELECT_TARGET_NAME` | 无 | 选课监控目标课程名称 |
| `ELECT_TARGET_TEACHER` | 无 | 选课监控目标教师 |
| `ELECT_TARGET_TIME` | 无 | 选课监控目标时间 |
| `ELECT_INTERVAL_MINUTES` | `1` | 选课监控轮询间隔（1-60 分钟） |
| `LOGIN_TIMEOUT_MINUTES` | `2` | 登录总超时（1-10 分钟） |

非 QQ 邮箱可以通过 `SMTP_HOST`、`SMTP_PORT`、`SMTP_SECURE`、`SMTP_USER`、`SMTP_PASS` 以及对应的 `IMAP_*` 配置覆盖默认服务器。

不要提交 `eams.env`。该文件包含教务密码、邮箱授权码和 API Key，已加入 `.gitignore`。

## 本机控制台

控制台包含五个页面：

- **运行概览**：监控状态、课程数量、运行时间、失败次数、通知队列状态、服务能力
- **成绩中心**：最近学期成绩、即时查询总加权、历史查询
- **通知记录**：待发送、重试中、已发送的通知详情
- **运行日志**：实时查看最近 200 条日志
- **系统设置**：修改登录、邮箱、检查频率和浏览器模式，保存后自动重启

控制台只绑定本机回环地址，外部设备无法访问。所有写操作验证页面来源和启动时随机生成的安全令牌。

浏览器实际加载的是 `web/dashboard.html`。由 `web/index.html`、`web/styles.css`、`web/app.js` 构建生成；运行 `npm start` 时自动重新生成。

## 邮件指令

从 `COMMAND_EMAIL` 回复任意通知邮件，正文中包含下列指令之一：

| 指令 | 作用 |
|---|---|
| `状态` / `status` | 查看运行状态 |
| `成绩单` / `成绩` | 即时抓取成绩 |
| `总加权` / `加权` | 即时抓取累计成绩 |
| `日志` / `log` | 查看成绩变化记录 |
| `帮助` / `help` | 返回指令列表 |
| `启动` / `start` | 启动自动查分 |
| `停止` / `stop` | 暂停自动查分 |

程序只接受 `COMMAND_EMAIL` 发来的指令，并跳过带有 `X-TJU-Auto-Grade` 标记的通知邮件。

## 选课监控

配置 `ELECT_TARGET_ID` 等环境变量后，可通过控制台 `/api/actions/elect-start` 启动选课捡漏监控。也可独立运行：

```bash
node bin/elect_loop.js
```

## 看门狗

在另一个终端运行：

```bash
npm run watchdog
```

看门狗检查 PID 和心跳文件。主进程退出后尝试后台重启；心跳超时只报警不强制结束。

如需关闭自动重启，设置 `WATCHDOG_AUTO_RESTART=false`。

## 常用命令

```bash
npm start             # 启动控制台和监控
npm run dashboard     # 同上
npm run monitor       # 仅启动纯终端监控
npm run watchdog      # 启动看门狗
npm run build         # 重新生成单文件 HTML
npm run build:check   # 检查 HTML 与源码同步
npm run check         # 检查全部 JavaScript 文件
npm test              # 运行单元测试
npm run doctor        # 配置自检
npm run validate      # 完整代码检查与测试
npm run test:email    # 发送测试邮件
```

## 运行文件

| 文件 | 说明 |
|---|---|
| `bin/dashboard.js` | 控制台入口 |
| `bin/monitor.js` | 纯终端监控入口 |
| `bin/watchdog.js` | 看门狗 |
| `bin/elect_loop.js` | 选课监控入口 |
| `bin/vision.js` | 验证码视觉识别客户端 |
| `lib/dashboard.js` | 控制台生命周期 |
| `lib/dashboard_server.js` | HTTP API、静态资源、设置读写 |
| `lib/monitor_controller.js` | 监控生命周期管理 |
| `lib/monitor.js` | 监控调度、通知、IMAP |
| `lib/eams.js` | Playwright 传输层 |
| `lib/http_eams_client.js` | HTTP 直连传输层 |
| `lib/grades.js` | 成绩 diff、邮件模板 |
| `lib/email_commands.js` | IMAP 指令解析 |
| `lib/mailer.js` | SMTP 发信 |
| `lib/notifier/` | 通知通道抽象（SMTP + QQ） |
| `lib/semester.js` | 学期自动发现 |
| `lib/elect_monitor.js` | 选课监控引擎 |
| `lib/errors.js` | 错误分类体系 |
| `lib/logger.js` | 结构化日志 + 轮转 |
| `lib/config.js` | 配置解析 |
| `lib/storage.js` | 原子写、PID、心跳、ProcessGuard |
| `lib/notification_outbox.js` | 通知发件箱 |
| `lib/captcha_ocr.js` | 验证码 OCR |
| `lib/cookie_jar.js` | Cookie 管理 |
| `lib/tju_cas_des.js` | CAS DES 加密 |
| `query_grades.js` | 命令行查当前学期成绩 |
| `query_all_grades.js` | 命令行查所有学期成绩 |
| `query_weighted.js` | 命令行查加权成绩 |
| `scripts/doctor.js` | 配置自检 |
| `web/dashboard.html` | 控制台前端（构建产物） |
| `web/index.html` / `web/styles.css` / `web/app.js` | 控制台前端源码 |

## 常见问题

1. 浏览器模式登录后反复跳回统一认证：关闭其他占用 `.eams_profile` 的浏览器，确认只启动了一个实例。
2. 收不到邮件：在 QQ 邮箱设置中开启 SMTP，确认填写的是授权码，运行 `npm run test:email`。
3. 邮件回复无响应：检查发件邮箱是否与 `COMMAND_EMAIL` 一致，查看 `data/eams_monitor.log`。
4. Edge 无法启动：确认 Edge 已安装；或安装 Playwright Chromium 后设置 `BROWSER_CHANNEL=chromium`。
5. 想彻底重新登录：退出程序后删除 `data/.eams_profile`，再运行 `npm start`。

## 隐私说明

成绩快照、通知队列、浏览器会话（如使用 browser 模式）、日志和凭据均保存在本机。通知队列包含待发送邮件正文，因此也被排除在 Git 之外。

## 贡献与许可证

提交修改前请阅读 [贡献指南](CONTRIBUTING.md)。安全问题请按照 [安全策略](SECURITY.md) 私下报告。

本项目采用 [MIT License](LICENSE)。
