# 安全策略

## 支持范围

本项目目前只维护 `master` 分支上的最新版本。旧提交和个人分支不提供安全更新。

## 报告漏洞

请通过 [GitHub Private Vulnerability Reporting](https://github.com/WhatYearIsNow/tju-auto-grade/security/advisories/new) 私下报告安全问题，不要创建公开 Issue。

报告中请包含：

- 受影响版本或提交；
- 可复现步骤与影响范围；
- 已做脱敏处理的日志或截图；
- 建议的修复方式（如有）。

请勿发送真实教务密码、邮箱授权码、API Key、Cookie、浏览器会话目录或完整成绩数据。维护者确认问题前，也请不要公开利用细节。

## 安全边界

控制台默认仅监听 `127.0.0.1`，并使用随机令牌保护写操作。`eams.env`、浏览器会话、成绩快照、通知队列和日志均保存在本机并被 Git 忽略。用户仍需自行保护电脑账户、邮箱授权码和第三方 API Key。
