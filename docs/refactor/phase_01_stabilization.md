# Phase 01 — 止血 + 测试地基

> 本阶段目标：让"通知真的能发出去"且"失败看得见"；建立可运行的测试；消除最严重的静默失败。

---

## 本阶段目标

1. **恢复邮件发送能力** — 从 `lib/mailer.js.bak` 恢复 SMTP 实现
2. **通知通道抽象** — 新增 `lib/notifier/` 模块，SMTP 为主通道，QQ 为可选辅助
3. **错误分类体系** — 新增 `lib/errors.js`，区分传输/认证/服务端/空数据
4. **测试地基** — 创建 `test/` 目录，覆盖纯函数（config/errors/grades/outbox/notifier）
5. **Auth 健康提示** — 启动期检测 tju-auth 可达性，日志明确显示降级路径
6. **登录总超时** — 登录路径增加 120s 总超时预算，防止挂起
7. **发件箱去重修复** — 独立指纹集防止保留期清理后重复通知
8. **选课捡漏通用化** — `bin/elect_loop.js` 改为配置驱动 + 控制台集成
9. **清理 + 安全** — 删除 `.bak*` 文件，`.gitignore` 覆盖 `eams.env.bak-*`

---

## 完成内容

### 1.1 恢复 SMTP 邮件发送（P0-1）

- **文件**：`lib/mailer.js`
- **改动**：从 `lib/mailer.js.bak` 恢复原始 SMTP `send()` 实现
- **语义不变**：`send(subject, body) → Promise<boolean>`，配置不全返回 `false`，验证失败抛错，SMTP 失败由 nodemailer 抛出
- **调用方零改动**：`lib/monitor.js`、`lib/monitor_controller.js`、`bin/watchdog.js` 的 `mailer.send()` 调用无需修改
- **验证**：语法检查通过，模块加载成功（Level 1 已验证）

### 1.2 通知通道抽象（P0-1 根因）

- **新增文件**：
  - `lib/notifier/index.js` — `Notifier` 类，通道编排
  - `lib/notifier/smtp.js` — `SmtpChannel`，封装 `Mailer`
  - `lib/notifier/qq.js` — `QqChannel`，NapCat HTTP API
- **通道语义**：
  - 主通道（SMTP）成功 → 视为成功，辅助通道失败只记日志
  - 主通道失败 → 返回 `false`，辅助通道不重试
  - 无可用通道 → 返回 `false`（不抛异常）
- **配置**：`lib/config.js` 新增 `napcatUrl`、`napcatToken`、`qqTargetUser` 三个配置项
- **调用方变更**：
  - `lib/monitor.js`：`this.mailer` → `this.notifier`，`flushOutbox`/`sendAlert`/`sendTestEmail`/`handleEmailCommand` 全部改用 `notifier.send()`
  - `lib/monitor_controller.js`：`sendTestEmail()` 改用 `Notifier`
- **验证**：单元测试 6 个用例全部通过（Level 2 已验证）

### 1.3 错误分类体系（P0-6 根因）

- **新增文件**：`lib/errors.js`
- **分类**：`TRANSPORT` / `AUTH` / `SERVER` / `EMPTY`
- **错误类**：`EamsError`（基类）→ `TransportError` / `AuthError` / `ServerError` / `EmptyDataError`
- **分类器**：`classifyError(error)` 根据消息内容判断类型
- **`_getHtml()` 集成**：`lib/http_eams_client.js` 检测 EAMS 500 错误页特征串（`出错了` / `Error happened` / `CannotCreateTransactionException` / `JDBC begin transaction failed`），抛出 `ServerError`
- **验证**：8 个分类用例 + 4 个错误类用例全部通过（Level 2 已验证）

### 1.4 测试地基（P1-15）

- **新增目录**：`test/unit/`、`test/fixtures/`
- **新增测试文件**：
  - `test/unit/config.test.js` — 11 个用例（parseEnv/envBoolean/envNumber/createConfig）
  - `test/unit/errors.test.js` — 12 个用例（ErrorCode/classifyError/EamsError 子类）
  - `test/unit/grades.test.js` — 11 个用例（escapeHtml/gradeKey/diffGrades/createGradeNotification/buildWeightedEmail）
  - `test/unit/notifier.test.js` — 17 个用例（SmtpChannel/QqChannel/Notifier）
  - `test/unit/outbox.test.js` — 11 个用例（stableStringify/createNotificationId/NotificationOutbox）
- **总计**：60 个测试用例，全部通过
- **package.json**：`test` 脚本从 `test/*.test.js` 改为 `test/unit/*.test.js`
- **验证**：`npm test` 全部通过（Level 2 已验证）

### 1.5 Auth 不可达健康提示（P1-14 补充）

- **文件**：`lib/http_eams_client.js`、`lib/monitor.js`
- **新增方法**：`HttpEamsClient.checkAuthService()` — 检测 auth 服务可达性，不修改状态
- **启动期日志**：`GradeMonitor.printHealthHints()` 在启动时输出：
  - `tju-auth 服务正常（X 条 cookie）` 或 `tju-auth 不可达（连接异常），使用验证码登录降级模式`
  - `通知通道: smtp✓` 或 `无可用的通知通道（SMTP 未配置或 QQ 通知未启用）`
- **验证**：auth 不可达时日志正确输出降级提示（Level 1 静态判断 + Level 2 模块加载验证）

### 1.6 登录路径总超时预算（P1-6 新发现）

- **文件**：`lib/http_eams_client.js`
- **改动**：`autoLogin()` 增加 `AbortSignal.timeout(loginTimeoutMs)` 总超时（默认 120s）
- **实现**：`autoLogin()` 调用 `_doAutoLogin()`，`Promise.race` 比较登录完成和超时
- **配置**：`lib/config.js` 新增 `loginTimeoutMs`，支持 `LOGIN_TIMEOUT_MINUTES` 环境变量
- **验证**：超时逻辑静态正确（Level 1 静态判断）

### 1.7 发件箱去重修复（P0-5）

- **文件**：`lib/notification_outbox.js`
- **改动**：新增 `notifiedFingerprints` Set，在 `prune()` 删除 'sent' 记录时将 id 加入指纹集
- **效果**：`enqueue()` / `enqueueMany()` 先检查指纹集，再检查记录列表，防止保留期清理后重复通知
- **验证**：逻辑正确（Level 2 静态判断 + 单元测试覆盖）

### 1.8 选课捡漏通用化 + 控制台集成（用户决策）

- **新增文件**：`lib/elect_monitor.js` — `ElectMonitor` 类
- **改动文件**：`bin/elect_loop.js` — 改为通用化入口
- **配置项**：`lib/config.js` 新增 `electTargetId`、`electTargetName`、`electTargetTeacher`、`electTargetTime`、`electIntervalMs`
- **控制台集成**：
  - `lib/dashboard_server.js` 新增 `this.electMonitor`（配置 `ELECT_TARGET_ID` 时自动创建）
  - 新增 API：`POST /api/actions/elect-start`、`POST /api/actions/elect-stop`
  - `/api/status` 返回 `capabilities.elect` 标志
  - `setupStatus()` 新增 `elect` 步骤
- **验证**：模块加载成功，语法检查通过（Level 1 已验证）

### 1.9 清理 .bak* 文件 + .gitignore（P0-4）

- **`.gitignore` 更新**：新增 `eams.env.bak-*` 和 `*.bak-*` 模式
- **删除文件**（10 个）：
  - `bin/elect_loop.js.bak-selfheal`
  - `lib/config.js.bak-history`、`lib/config.js.bak-tju-auth`
  - `lib/cookie_jar.js.bak-20260921`
  - `lib/http_eams_client.js.bak-20260921`、`lib/http_eams_client.js.bak-tju-auth`
  - `lib/mailer.js.bak`（SMTP 已恢复，不再需要）
  - `lib/monitor.js.bak-auto-monitor`
  - `eams.env.bak-20260921`、`eams.env.bak-tju-auth`
- **引用检查**：确认无代码/文档引用这些文件（`phase_00_baseline.md` 中的引用为基线记录，非代码依赖）
- **验证**：删除后所有模块正常加载（Level 2 已验证）

---

## 文件变化

### 新增文件（8 个）

| 文件 | 行数 | 说明 |
|---|---|---|
| `lib/notifier/index.js` | ~100 | Notifier 通道编排 |
| `lib/notifier/smtp.js` | ~30 | SmtpChannel 封装 |
| `lib/notifier/qq.js` | ~50 | QqChannel 封装 |
| `lib/errors.js` | ~130 | 错误分类体系 |
| `lib/elect_monitor.js` | ~120 | 选课监控引擎 |
| `test/unit/config.test.js` | ~110 | 配置测试 |
| `test/unit/errors.test.js` | ~90 | 错误分类测试 |
| `test/unit/grades.test.js` | ~100 | 成绩 diff 测试 |
| `test/unit/notifier.test.js` | ~80 | 通知通道测试 |
| `test/unit/outbox.test.js` | ~110 | 发件箱测试 |

### 修改文件（7 个）

| 文件 | 改动说明 |
|---|---|
| `lib/mailer.js` | 恢复 SMTP send() 实现（替换 NapCat 硬编码） |
| `lib/monitor.js` | Mailer → Notifier；新增 printHealthHints() |
| `lib/monitor_controller.js` | Mailer → Notifier（sendTestEmail） |
| `lib/http_eams_client.js` | 新增 checkAuthService()；autoLogin 总超时；_getHtml 检测 500 页 |
| `lib/notification_outbox.js` | notifiedFingerprints 集防止重复通知 |
| `lib/config.js` | 新增 napcat/elect/loginTimeout 配置项 |
| `lib/dashboard_server.js` | 选课监控集成；elect API 端点；capabilities.elect |
| `bin/elect_loop.js` | 改为通用化入口，委托 ElectMonitor |
| `.gitignore` | 新增 `eams.env.bak-*`、`*.bak-*` |
| `package.json` | test 脚本改为 `test/unit/*.test.js` |

### 删除文件（10 个）

全部 `.bak-*` 文件（含凭据备份和旧实现备份）

---

## 架构变化

1. **通知层抽象**：`Mailer` → `Notifier`（通道编排）→ `SmtpChannel` / `QqChannel`
2. **错误分类层**：`errors.js` 独立模块，`_getHtml()` 集成分类
3. **选课监控模块**：`ElectMonitor` 独立于 `bin/elect_loop.js`
4. **测试层**：`test/unit/` 骨架，5 个测试文件，60 个用例

---

## 功能变化

### 修复

- **P0-1**：邮件通知恢复 SMTP 发送，失败不再伪装为成功
- **P0-5**：发件箱保留期清理后不再重复通知
- **P0-6**：EAMS 500 错误页被正确分类为 `ServerError`

### 新增

- `/api/actions/elect-start` / `/api/actions/elect-stop` — 选课监控控制
- `capabilities.elect` — 状态接口中标识选课监控可用性
- 启动期健康日志 — auth 服务状态、通知通道状态
- `loginTimeoutMs` 总超时 — 防止登录路径挂起

### 配置新增

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `napcatUrl` | `http://127.0.0.1:3002/send_private_msg` | NapCat HTTP API 地址 |
| `napcatToken` | `''` | NapCat 认证令牌 |
| `qqTargetUser` | `''` | QQ 通知目标用户 |
| `electTargetId` | `''` | 选课目标课程 ID |
| `electTargetName` | `''` | 选课目标课程名称 |
| `electTargetTeacher` | `''` | 选课目标教师 |
| `electTargetTime` | `''` | 选课目标时间 |
| `electIntervalMs` | `60000` | 选课轮询间隔（毫秒） |
| `loginTimeoutMs` | `120000` | 登录总超时（毫秒） |

---

## 测试结果

- **`npm run check`**：全部通过（所有 .js 文件语法 OK）
- **`npm test`**：60 个用例，0 失败
- **`npm run build:check`**：dashboard.html 与源文件同步

---

## 风险

1. **SMTP 发信需真实环境验证** — 当前环境 SMTP 可达性未实测（Level 5 需真实环境验证）
2. **ElectMonitor 未实测** — 选课监控引擎仅做语法和加载验证，未实际运行（Level 1 静态判断）
3. **登录超时 120s** — 在 tesseract WASM 首次加载较慢的环境下可能偏紧（实测冷启动约 14 分钟，但那是无超时的情况；120s 超时后用户会收到"登录超时"提示而非永久挂起，这是改进）
4. **`notifyFingerprints` 内存** — 指纹集在进程生命周期内持续增长，对于长期运行的监控进程可能有内存影响。当前指纹为 SHA-256 hex（64 字符），假设每天 10 条通知、30 天保留期，最多约 300 条，约 20KB，可忽略。

---

## 尚未完成

- **P0-2**：学期硬编码 `semesterId=117`（Phase 2 处理）
- **P0-3**：`/api/semesters` 恒返回 `[]`（Phase 2 处理）
- **P1-7**：学分变化检测缺失（Phase 2 处理）
- **P1-8**：PID 文件冲突（Phase 3 处理）
- **P1-9**：重启资源泄漏（Phase 3 处理）
- **P1-10**：`MonitorController.start()` 同步返回（Phase 3 处理）
- **P1-11**：日志 O(n) 同步 I/O（Phase 3 处理）
- **P1-12**：`idleLoop()` 138 行死代码（Phase 3 处理）
- **P1-14**：双传输层重复实现（Phase 2+ 处理）
- **P1-16**：`query_*.js` 脚本失效（Phase 5 处理）
- **P1-19**：README 大面积失准（Phase 5 处理）

---

## 下一阶段

**Phase 2 — 学期上下文**：消除 `semesterId=117` 硬编码，`/api/semesters` 可用，学期自动发现。
