# 天津大学自动查分系统

常驻浏览器监控 EAMS 成绩变化，定时刷新，仅发送有变化的科目到 QQ 邮箱。

## 功能

- **AI 自动登录** — 千问 VL 模型识别验证码，自动完成 CAS 认证（失败回退手动）
- **常驻监控** — 浏览器保持打开，定时刷新成绩页，无需反复登录
- **增量推送** — 只有分数变化的科目才通知，附带学期、学分、绩点、课程性质
- **智能标题** — TEST（首次）/ 出分啦！（有更新）/ 请无视此邮件（无更新）/ 监控异常（连续失败）
- **容错机制** — 页面加载 3 次重试，连续失败发报警邮件
- **日志持久化** — 运行记录写入 `eams_monitor.log`，重启可追溯
- **定时器无漂移** — setTimeout 链式调度，任务跑完才倒计时

## 快速开始

### 1. 安装

```bash
npm install
```

（本地用 Edge 浏览器，无需额外安装。可选 `npx playwright install chromium` 用于 CI）

### 2. 配置

```bash
cp eams.env.example eams.env
```

编辑 `eams.env`：

```env
EAMS_USERNAME=你的学号
EAMS_PASSWORD=你的教务密码
QQ_EMAIL=你的QQ号@qq.com
QQ_SMTP_CODE=QQ邮箱授权码
NOTIFY_EMAIL=接收通知的邮箱（可选）
DASHSCOPE_API_KEY=sk-xxxx（可选，AI 登录用）
```

### 3. 运行

```bash
node eams_grade_checker.js
```

或双击桌面的 `查成绩.bat`。浏览器打开后完成登录，之后全自动。

## 工作流程

```
启动 → Edge 浏览器
  → AI 尝试自动登录（需千问 API）
  → 失败则手动登录
  → 首次抓取全部成绩 → 发 TEST 邮件
  → 每 30 分钟刷新 → 对比快照
    → 有变化 → 发出分啦！（仅列变化科目，含学期/学分/绩点/性质）
    → 无变化 → 发请无视此邮件
    → 连续 3 次失败 → 发异常报警
```

## 目录

```
├── eams_grade_checker.js   # 主程序
├── vision.js               # 验证码 AI 识别
├── eams.env.example        # 配置模板
├── package.json
├── .gitignore
└── README.md
```

## 配置项说明

| 变量 | 必需 | 说明 |
|------|------|------|
| `EAMS_USERNAME` | 是 | 学号 |
| `EAMS_PASSWORD` | 是 | 教务密码 |
| `QQ_EMAIL` | 是 | 发件邮箱 |
| `QQ_SMTP_CODE` | 是 | QQ邮箱授权码（设置→账户→POP3/SMTP） |
| `NOTIFY_EMAIL` | 否 | 接收通知的邮箱，默认发给自己 |
| `DASHSCOPE_API_KEY` | 否 | 千问 API Key，用于 AI 识别验证码 |

## 注意事项

- 电脑需保持开机，可关闭屏幕但不能睡眠
- 首次运行建议手动登录建立会话，后续自动跳过
- 浏览器窗口不能关，最小化即可
- 日志文件 `eams_monitor.log` 可随时查看运行状态
