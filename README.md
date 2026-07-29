# 天津大学自动查分系统

常驻 Edge 浏览器监控 EAMS 成绩变化，默认每 15 分钟刷新一次，仅在首次启动、成绩变化或监控异常时发送邮件。

## 功能

- **AI 自动登录** — 使用千问 VL 识别验证码；未配置 API Key 或识别失败时回退到浏览器手动登录
- **会话自动恢复** — 查询被重定向到 CAS 时立即重新登录并重试本次查询
- **常驻监控** — 使用持久化浏览器资料保存登录会话，查询完成后再开始下一轮倒计时
- **增量推送** — 以课程代码、学期、教学班和课程名称组成唯一键，只通知新增、变更或移除的课程
- **快照恢复** — 重启时读取 `grades_latest.json`，检测停机期间出现的成绩变化
- **故障报警** — 连续 3 次失败发送一次报警，恢复后发送恢复通知
- **进程看护** — 独立看门狗检查 PID 和每分钟心跳，确认进程身份后清理故障进程并尝试自动重启
- **日志持久化** — 运行记录写入 `eams_monitor.log`，最多保留最近 500 行

## 快速开始

### 1. 安装

需要 Node.js 20 或更高版本，以及本机 Microsoft Edge：

```bash
npm install
```

### 2. 配置

复制配置模板：

```bash
copy eams.env.example eams.env
```

编辑 `eams.env`：

```env
EAMS_USERNAME=你的学号
EAMS_PASSWORD=你的教务密码

QQ_EMAIL=你的QQ号@qq.com
QQ_SMTP_CODE=QQ邮箱授权码
NOTIFY_EMAIL=接收通知的邮箱

# 可选：使用千问自动识别验证码
DASHSCOPE_API_KEY=sk-xxxx
```

`eams.env`、浏览器会话、日志和成绩快照均已加入 `.gitignore`。这些文件包含敏感信息，请只保存在可信设备上。

### 3. 运行

```bash
npm start
```

浏览器打开后，如果自动登录不可用，请直接在浏览器中完成登录。程序不会在终端中读取或回显密码。

### 4. 启动看门狗（推荐）

另开一个终端：

```bash
npm run watchdog
```

也可以双击 `watchdog.bat`。看门狗默认会在主程序停止或心跳超时后尝试自动重启；设置 `WATCHDOG_AUTO_RESTART=false` 可改为仅报警。

## 工作流程

```text
启动
  → 读取持久化快照与 Edge 会话
  → 必要时通过 AI 或浏览器手动登录
  → 抓取当前全部成绩
  → 首次运行：保存快照并发送全量启动邮件
  → 再次运行：与磁盘快照比较，通知停机期间的变化
  → 每 15 分钟查询一次
      → 会话过期：重新登录并立即重试
      → 有变化：逐门发送邮件并原子更新快照
      → 无变化：只记录日志
      → 连续 3 次失败：发送一次异常报警
      → 恢复正常：发送恢复通知
```

## 配置项

| 变量 | 必需 | 默认值 | 说明 |
|---|---|---|---|
| `EAMS_USERNAME` | 建议 | — | 学号；AI 登录需要 |
| `EAMS_PASSWORD` | 建议 | — | 教务密码；AI 登录需要 |
| `QQ_EMAIL` | 通知需要 | — | 发件邮箱 |
| `QQ_SMTP_CODE` | 通知需要 | — | QQ 邮箱 SMTP 授权码 |
| `NOTIFY_EMAIL` | 否 | 发件邮箱 | 接收通知的邮箱 |
| `DASHSCOPE_API_KEY` | 否 | — | 千问 API Key |
| `VISION_MODEL` | 否 | `qwen-vl-plus` | 验证码识别模型 |
| `CHECK_INTERVAL_MINUTES` | 否 | `15` | 成绩检查间隔 |
| `EAMS_ENTRY_URL` | 否 | 天津大学 EAMS 首页 | 登录入口 |
| `EAMS_GRADE_URL` | 否 | 无固定学期参数的成绩查询页 | 页面变化时可覆盖 |
| `EAMS_CAS_HOST` | 否 | `sso.tju.edu.cn` | CAS 登录页主机名 |
| `SMTP_HOST` | 否 | `smtp.qq.com` | 自定义 SMTP 主机 |
| `SMTP_PORT` | 否 | `465` | 自定义 SMTP 端口 |
| `SMTP_SECURE` | 否 | 端口 465 时为 `true` | 是否直接使用 TLS |
| `WATCHDOG_AUTO_RESTART` | 否 | `true` | 看门狗是否自动重启主程序 |

## 目录

```text
├── eams_grade_checker.js   # 主程序、成绩提取与变化检测
├── vision.js               # 千问 VL 验证码识别
├── mailer.js               # Nodemailer SMTP 封装
├── watchdog.js             # PID、心跳、报警与自动重启
├── watchdog.bat            # Windows 看门狗启动脚本
├── test_email.js           # 邮件模板人工测试
├── test_email.bat
├── test/                   # 自动化测试
├── eams.env.example        # 配置模板
└── package.json
```

## 开发与验证

```bash
npm run check
npm test
npm audit
```

自动化测试覆盖课程唯一键、成绩新增/更新/移除、重复课程、快照读写、邮件 HTML 转义和 SMTP 配置。

## 注意事项

- 电脑需要保持开机，关闭屏幕可以，但不要进入睡眠。
- 浏览器窗口必须保持打开，可以最小化。
- EAMS 页面结构变化时，程序会把空成绩表视为失败，而不会覆盖已有快照。
- `.eams_profile` 中保存登录 Cookie；不要上传、共享或备份到不可信位置。
