# 重构变更日志

## Phase 1 — 通知通道与错误分类

### 新增文件
- `lib/notifier/index.js` — Notifier 类，编排 SMTP 主通道 + NapCat QQ 辅助通道
- `lib/notifier/smtp.js` — SmtpChannel，封装 Mailer 发送
- `lib/notifier/qq.js` — QqChannel，封装 NapCat HTTP API 发送
- `lib/errors.js` — 错误分类体系：TransportError / AuthError / ServerError / EmptyDataError + classifyError()
- `lib/semester.js` — 学期自动发现：从 historyCourseGrade 接口解析学期列表
- `lib/elect_monitor.js` — 通用选课捡漏引擎
- `lib/logger.js` — 结构化日志（追加写 + 自动轮转）
- `scripts/doctor.js` — 配置自检脚本（8 项检查）
- `test/unit/config.test.js` — 11 个配置解析测试
- `test/unit/errors.test.js` — 12 个错误分类测试
- `test/unit/grades.test.js` — 11 个成绩 diff 测试
- `test/unit/notifier.test.js` — 17 个通知通道测试
- `test/unit/outbox.test.js` — 11 个通知发件箱测试
- `test/unit/semester.test.js` — 12 个学期发现测试
- `test/unit/doctor.test.js` — 5 个 doctor 脚本测试

### 修改文件
- `lib/mailer.js` — 恢复 SMTP send() 实现（此前被硬编码的 NapCat 调用替代，始终返回 true）
- `lib/monitor.js` — 使用 Notifier 替代 Mailer；添加 printHealthHints()；添加 currentSemester 跟踪；修复 stop() 释放所有资源（IMAP / notifier / outbox / tesseract）；使用新 logger
- `lib/monitor_controller.js` — sendTestEmail() 使用 Notifier；新增 waitForStart() 方法
- `lib/http_eams_client.js` — 新增 checkAuthService()；登录添加总超时；_getHtml() 集成错误分类
- `lib/notification_outbox.js` — 添加 notifiedFingerprints Set，防止 prune() 后重复通知
- `lib/config.js` — 新增 napcatUrl / napcatToken / qqTargetUser / electTargetId / electTargetName / electTargetTeacher / electTargetTime / electIntervalMs / loginTimeoutMs / monitorPidFile / monitorHeartbeatFile
- `lib/dashboard_server.js` — 集成选课监控；新增 /api/actions/elect-start / /api/actions/elect-stop；/api/status 添加 capabilities；/api/health 健康检查
- `bin/elect_loop.js` — 替换为委托给 ElectMonitor 的入口
- `.gitignore` — 新增 eams.env.bak-* 和 *.bak-* 模式
- `package.json` — 测试 glob 改为 test/unit/*.test.js；新增 scripts.doctor

### 关键变更
- **P0-1 邮件修复**：Mailer.send() 此前被硬编码为 NapCat 调用（catch 后返回 true），导致邮件通知完全失效。恢复 SMTP 实现，创建 Notifier 抽象使通道可插拔且失败可见。
- **P0-5 发件箱去重**：prune() 删除已发送记录后，相同成绩变化会重复通知。添加 notifiedFingerprints Set 在 prune() 后保留。
- **P0-6 EAMS 500 误判**：_getHtml() 未检测 500 错误页面。添加错误分类和错误页面关键词检测。
- **Elect 通用化**：硬编码课程捡漏脚本重构为通用 ElectMonitor 类，通过配置驱动。

## Phase 2 — 学期自动发现

### 修改文件
- `lib/config.js` — 移除 gradeUrl 默认值中的 semesterId=117
- `lib/monitor.js` — initializeGrades() 调用 listSemesters() 并使用最新学期；checkGrades() 使用 this.currentSemester.id
- `lib/http_eams_client.js` — listSemesters() 重写为使用 historyCourseGrade 接口

### 关键变更
- **P0-2 学期硬编码**：semesterId=117 硬编码在 config 默认值和 monitor 中。移除硬编码，monitor 启动时自动发现最新学期。
- **P0-3 /api/semesters 返回空**：静态 cheerio 无法解析 JS 渲染的学期日历。重写为使用 historyCourseGrade HTML 表格解析。

## Phase 3 — 进程守护与资源管理

### 修改文件
- `lib/storage.js` — 新增 releaseOwn() 方法
- `lib/monitor.js` — PID 文件分离（monitorPidFile / monitorHeartbeatFile）；stop() 完整释放所有资源
- `lib/monitor_controller.js` — 新增 waitForStart() 方法
- `lib/email_commands.js` — 替换 138 行 idleLoop() 死代码为注释 + 存根

### 关键变更
- **PID 冲突**：dashboard 和 monitor 共享同一 PID 文件。分离为独立 PID 和心跳文件。
- **资源泄漏**：重启时 IMAP 连接、tesseract worker、outbox 未释放。stop() 添加完整清理。
- **start() 同步返回**：异步启动失败被隐藏。添加 waitForStart() 方法。
- **Logger O(n) I/O**：每次日志读取整个文件。新 logger.js 使用追加写 + 轮转。

## Phase 4 — 健康检查与诊断

### 新增文件
- `scripts/doctor.js` — 配置自检脚本（8 项检查）
- `test/unit/doctor.test.js` — 5 个 doctor 测试

### 修改文件
- `lib/dashboard_server.js` — 新增 /api/health 端点（auth 健康、通知通道健康、监控 PID 健康）

### 关键变更
- **Auth 健康提示**：启动时检查 tju-auth 服务可达性，不可达时输出降级提示。
- **配置自检**：doctor.js 检查配置文件、凭据、目录、依赖、端口等。

## Phase 5 — 收尾

### 修改文件
- `query_grades.js` — 移除硬编码路径；修复中文字段名（课程名称/总评成绩/学分/绩点）
- `query_all_grades.js` — 同上
- `query_weighted.js` — 同上
- `README.md` — 全面校正：移除过时文件引用、Windows 特定指令、补充 16+ 新配置项

### 关键变更
- **查询脚本损坏**：硬编码路径 + 英文字段名与中文 EAMS 数据不匹配。修复路径和字段名。
- **README 过时**：引用不存在的文件（eams_grade_checker_v2.js、Windows 批处理文件），缺少新配置项文档。全面重写。
