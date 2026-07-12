# 天津大学自动查分系统

常驻浏览器监控 EAMS 成绩变化，每小时自动检查，仅发送有变化的科目到 QQ 邮箱。

## 功能

- **常驻监控** — 浏览器保持打开，每小时自动刷新成绩页
- **增量推送** — 只有分数变化的科目才通知，不会重复轰炸
- **智能标题** — 有新成绩 → "出分啦！"，无变化 → "请无视此邮件"
- **会话保持** — 登录一次后浏览器不关，不会频繁要求重新登录

## 快速开始

### 1. 安装依赖

```bash
npm install
npx playwright install chromium
```

（本地用 Edge 浏览器，无需额外安装）

### 2. 配置

```bash
cp eams.env.example eams.env
```

编辑 `eams.env`，填入：

```env
EAMS_USERNAME=你的学号
EAMS_PASSWORD=你的教务密码
QQ_EMAIL=你的QQ号@qq.com
QQ_SMTP_CODE=QQ邮箱授权码
NOTIFY_EMAIL=接收通知的邮箱（可选）
```

> QQ 邮箱授权码获取：QQ邮箱 → 设置 → 账户 → POP3/SMTP 服务 → 开启 → 获取授权码

### 3. 运行

```bash
node eams_grade_checker.js
```

浏览器会打开 EAMS 登录页，手动输入验证码登录。之后全自动运行。

## 目录结构

```
├── eams_grade_checker.js   # 主程序
├── eams.env.example        # 配置文件模板
├── vision.js               # 验证码识别（需千问 API Key，可选）
├── package.json
└── .gitignore
```

## 注意事项

- 电脑需要一直开机，可以关闭屏幕但不能睡眠
- 首次登录后可关闭千问 API（验证码识别仅用于 CI 环境自动登录，本地用不到）
- 成绩快照保存在 `grades_latest.json`，删除它可以触发重新全量推送
