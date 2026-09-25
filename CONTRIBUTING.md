# 贡献指南

感谢你改进 TJU Auto Grade。提交修改前，请先确认问题可以复现，并避免在 Issue、日志、截图或提交中包含教务密码、邮箱授权码、API Key、成绩单等个人信息。

## 开发环境

- Windows 10/11（主要运行环境）
- Node.js 22 或更高版本
- Microsoft Edge

```powershell
git clone https://github.com/WhatYearIsNow/tju-auto-grade.git
cd tju-auto-grade
npm ci
Copy-Item eams.env.example eams.env
```

`eams.env` 只用于本机调试，禁止提交。无需真实教务账号的修改应优先使用现有离线测试和预览服务器验证。

## 修改原则

- 保持 `dashboard.js` 作为默认入口，避免破坏 HTML 和批处理启动方式。
- 业务逻辑放在 `lib/`，页面源文件放在 `web/`，构建与维护脚本放在 `scripts/`。
- 变量、函数和类使用英文命名；用户界面与日志可以使用中文。
- 文件使用 UTF-8；JavaScript、Markdown 和 JSON 使用 LF，批处理与 PowerShell 使用 CRLF。
- 不提交运行日志、成绩快照、浏览器会话、测试截图或任何凭据。

## 验证

提交 Pull Request 前运行：

```powershell
npm ci
npm run validate
```

涉及控制台交互时，还应执行 `test/ui/` 中对应的 Playwright 测试，并说明验证的桌面端和手机端场景。

首次运行界面测试前安装 Python 依赖和 Chromium：

```powershell
python -m pip install -r requirements-ui.txt
python -m playwright install chromium
npm run test:ui
```

## Pull Request

- 每个 Pull Request 聚焦一个问题，避免夹带无关重构。
- 描述修改原因、用户可见影响、测试结果和可能的兼容性风险。
- 行为变化应同步更新 README、配置示例和测试。
- 不要直接提交生成中的验证码、真实日志或本机配置。

安全问题请按照 [SECURITY.md](SECURITY.md) 私下报告，不要创建公开 Issue。
