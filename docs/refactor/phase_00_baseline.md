# Phase 00 — 项目基线（Baseline）

> 本文档是重构前的**只读基线快照**。所有结论均标注验证等级。
> 验证等级定义：
> - **【已验证】** 实际运行/复现过，附命令或输出证据
> - **【部分验证】** 关键路径验证，边界未穷尽
> - **【静态判断】** 仅通过读代码/调用链推断，未运行
> - **【尚未验证】** 有怀疑但无证据
> - **【需真实环境验证】** 依赖外部系统（EAMS/QQ邮箱/NapCat/tju-auth），当前环境不可达
>
> 基线时间：2026-09-25
> 基线版本：`package.json` version = `2.2.0`
> 代码规模：65 个受版本管理文件（不含 node_modules / .eams_profile / data）

---

## 1. 当前项目架构

### 1.1 分层视图（实测）

```
┌──────────────────────────────────────────────────────────────────┐
│  入口层 (bin/)                                                    │
│  dashboard.js ──► lib/dashboard.js ──► DashboardApplication       │
│  monitor.js   ──► lib/monitor.js   ──► GradeMonitor (独立进程)     │
│  watchdog.js  ──► 健康检查 + 拉起                                   │
│  vision.js    ──► DashScope Qwen-VL 子进程（验证码备用通道）        │
│  elect_loop.js──► 【个人专用】选课捡漏死循环，硬编码路径/ID          │
├──────────────────────────────────────────────────────────────────┤
│  控制层                                                           │
│  lib/dashboard_server.js  HTTP API + 静态资源 + 设置读写 + 鉴权     │
│  lib/monitor_controller.js 监控生命周期（进程内）                   │
├──────────────────────────────────────────────────────────────────┤
│  业务层                                                           │
│  lib/monitor.js        监控主循环 / 状态机 / 定时器 / 日志          │
│  lib/grades.js         成绩 diff / 邮件正文模板 / HTML 转义         │
│  lib/email_commands.js IMAP 收信 + 指令解析 + 回复                  │
│  lib/notification_outbox.js 通知发件箱（去重/重试/保留）            │
├──────────────────────────────────────────────────────────────────┤
│  传输层（两条并存，互不共享）                                       │
│  lib/http_eams_client.js  fetch + CookieJar（EAMS_TRANSPORT=http） │
│  lib/eams.js              Playwright 持久化上下文（=browser）       │
├──────────────────────────────────────────────────────────────────┤
│  基础设施层                                                       │
│  lib/config.js         eams.env 解析 → 冻结 config 对象             │
│  lib/storage.js        原子写 / PID / 心跳 / ProcessGuard / 健康     │
│  lib/cookie_jar.js     自研 CookieJar（按 origin 分桶 + 持久化）     │
│  lib/captcha_ocr.js    tesseract.js WASM 本地 OCR（单例 worker）    │
│  lib/tju_cas_des.js    CAS 登录 DES 加密（strEnc）                  │
│  lib/mailer.js         SMTP 发信【当前已被破坏，见 P0-1】            │
├──────────────────────────────────────────────────────────────────┤
│  前端层 (web/)                                                    │
│  index.html + styles.css + app.js ──build──► dashboard.html        │
│  单文件打包，token/nonce 占位符替换，5 个视图，5s 轮询               │
└──────────────────────────────────────────────────────────────────┘
```

### 1.2 依赖方向（实测，无循环依赖）

```
bin/* ──► lib/dashboard.js ──► lib/dashboard_server.js ──► lib/config.js
                          └──► lib/monitor_controller.js ──► lib/monitor.js
                                                          └──► lib/mailer.js
                          └──► lib/storage.js

lib/monitor.js ──► lib/eams.js (browser) 或 lib/http_eams_client.js (http)
              ──► lib/grades.js, lib/notification_outbox.js,
                  lib/email_commands.js, lib/captcha_ocr.js, lib/storage.js
```
**结论【已验证】**：`lib/` 内部依赖方向单一，未发现循环依赖。`bin/elect_loop.js` 是唯一绕过 `lib/` 直接持有业务逻辑的入口。

### 1.3 运行形态（实测）

| 形态 | 命令 | 说明 |
|---|---|---|
| 控制台（推荐） | `npm run dashboard` → `bin/dashboard.js` | HTTP 服务 + 进程内监控 |
| 纯监控 | `npm start` → `bin/monitor.js` | 无 HTTP，独立进程 |
| 看门狗 | `npm run watchdog` | 检查心跳，必要时拉起 |
| 构建前端 | `npm run build` | `web/*` → `web/dashboard.html` |

**关键结构问题【已验证】**：`bin/dashboard.js` 与 `bin/monitor.js` **共用同一个 PID 文件**（`config.pidFile`），且各自 `new ProcessGuard(...)`。实测：先起 dashboard 再起 monitor，PID 文件被后者覆盖，dashboard 的 `guard.release()` 会删掉 monitor 的 PID 记录，健康检查随之失真。

---

## 2. 核心模块与职责

| 模块 | 行数 | 职责 | 职责是否单一 | 备注 |
|---|---|---|---|---|
| `lib/monitor.js` | 591 | 监控主循环、状态机、定时器、日志、快照 | ⚠️ 偏胖 | 同时承担 GradeMonitor + AsyncLock + createLogger + createState 四个概念 |
| `lib/dashboard_server.js` | 468 | HTTP 路由、鉴权、设置读写、静态资源 | ⚠️ 偏胖 | 同时承担 env 文件读写 + 设置校验 + 路由 |
| `lib/email_commands.js` | 469 | MIME 解码、指令解析、IMAP 客户端 | ⚠️ 偏胖 | 含 138 行死代码 `idleLoop()` |
| `lib/http_eams_client.js` | 405 | HTTP 传输 + 登录 + 成绩解析 | ✅ | `listSemesters()` 实现不完整（见 P0-3） |
| `lib/eams.js` | 402 | Playwright 传输 + 成绩解析 + 纯函数导出 | ✅ | 与 http 客户端存在**重复实现** |
| `lib/grades.js` | 394 | diff、邮件模板、转义 | ✅ | 有重复 `parseNum` 定义 |
| `lib/notification_outbox.js` | 183 | 发件箱去重/重试/保留 | ✅ | 保留策略有缺陷（见 P0-5） |
| `lib/storage.js` | 157 | 原子写、PID、心跳、健康 | ✅ | |
| `lib/config.js` | 130 | env 解析 → 冻结 config | ✅ | 含硬编码 `semesterId=117` |
| `lib/monitor_controller.js` | 114 | 监控生命周期 | ✅ | `start()` 同步返回，掩盖异步失败 |
| `lib/mailer.js` | 104 | SMTP 发信 | ❌ | **已被替换为硬编码 NapCat 调用** |
| `lib/captcha_ocr.js` | — | 验证码 OCR | ✅ | 单例 worker 永不释放 |
| `lib/cookie_jar.js` | — | Cookie 管理 | ✅ | 有不可达分支 |
| `lib/tju_cas_des.js` | — | CAS DES 加密 | ✅ | |
| `web/app.js` | 774 | 控制台前端 | ⚠️ | 单文件，无模块化 |

### 2.1 双传输层重复实现（结构性问题）

`lib/eams.js`（Playwright）与 `lib/http_eams_client.js`（fetch）**各自独立实现了**：
- 登录流程（CAS 跳转、验证码、DES 加密、表单提交）
- `extractGrades()` / `extractWeightedGrades()`
- `listSemesters()`
- 表格解析

两者**不共享任何代码**。`lib/eams.js` 导出了纯函数 `parseGradeTables` / `normalizeSemesterOptions` / `normalizeCell`，但 `http_eams_client.js` 没有复用它们，而是自己写了一份 `_tablesFromHtml()`。

**影响【静态判断】**：任何解析规则变更（例如 EAMS 改表头）必须改两处，且极易只改一处 —— 这正是 P0-3（`listSemesters` 在 http 下返回 `[]`，而 browser 下有展开逻辑）的根因模式。

---

## 3. 主要数据流 / 调用链

### 3.1 主监控链路（已验证可跑通）

```
bin/dashboard.js
  └─ DashboardApplication.start()
       ├─ ProcessGuard.acquire()                    # 写 PID + 心跳
       ├─ DashboardServer.start()                   # 监听 127.0.0.1:3765
       └─ MonitorController.start()
            └─ GradeMonitor.start()
                 ├─ EamsClient/HttpEamsClient.autoLogin()   # CASTGC 免密 → 失败则验证码登录
                 ├─ initializeGrades()  ──► extractGrades()  # ⚠️ 无 semesterId 参数
                 │        └─ 写 data/grades_latest.json
                 └─ setInterval(checkIntervalMs)
                      └─ checkNow()
                           ├─ extractGrades()
                           ├─ diffGrades(prev, curr)
                           ├─ 有变化 → createGradeNotification() → outbox.enqueue()
                           └─ outbox.process() → Mailer.send()
```

**实测证据【已验证】**：
- `npm run dashboard` 可启动，`curl 127.0.0.1:3765/api/state` 返回正常
- 监控成功抓取 **18 门课程**（`EAMS_GRADE_URL` 默认学期 117）
- CASTGC 静默续期生效，无需验证码

### 3.2 通知链路（**当前完全断裂**）

```
diffGrades() → createGradeNotification() → NotificationOutbox.enqueue()
                                                    │
                                          outbox.process()
                                                    │
                                            Mailer.send()
                                                    │
                              ┌─────────────────────┴─────────────────────┐
                              │  【当前代码】硬编码 fetch NapCat            │
                              │  http://127.0.0.1:3002/send_private_msg    │
                              │  catch 里只 log，然后 return true           │
                              └───────────────────────────────────────────┘
                                                    │
                                     outbox 标记 status='sent'，永不重试
```

**实测证据【已验证】**：
- 用真实 `eams.env` 构造 `Mailer`：`isConfigured() === true`，`validate() === []`
- `curl http://127.0.0.1:3002/` → **HTTP 000**（NapCat 不可达）
- 调用 `send()` → 日志输出 `[MAIL] QQ通知失败: fetch failed` → **返回值仍为 `true`**
- `data/notification_outbox.json` **不存在**（从未产生过待发通知记录）

### 3.3 邮件指令链路（IMAP）

```
ImapCommandClient.poll()  # 每 60s 重连一次
  └─ 拉取未读 → parseCommand() → 分发
       ├─ 查询类 → buildXxxEmail() → Mailer.send()
       └─ 控制类 → 修改监控状态
```
**结构问题【静态判断】**：`poll()` 每次重建 TLS 连接，无连接复用；`idleLoop()`（138 行）是死代码，含 `commandToken` 校验缺失与 `while(true)` 无退出条件。

### 3.4 前端数据流

```
web/app.js ──5s 轮询──► GET /api/state
                       GET /api/grades
                       GET /api/notifications
                       GET /api/logs
                       GET /api/settings
           ──写操作──► POST /api/actions/*   (X-TJU-Dashboard-Token)
           ──设置───► POST /api/settings    → updateEnvFile() → 重启监控
```

---

## 4. 当前功能地图

| 功能 | 状态 | 验证等级 | 说明 |
|---|---|---|---|
| 教务登录（CASTGC 免密续期） | ✅ 可用 | 已验证 | 实测续期成功 |
| 教务登录（验证码 + DES） | ✅ 可用 | 部分验证 | OCR 路径存在，实测未走通全流程 |
| 成绩抓取（当前学期） | ✅ 可用 | 已验证 | 18 门课程 |
| 成绩抓取（历史学期） | ✅ 可用 | 已验证 | `historyCourseGrade` 端点返回 32 门/2 学期 |
| 加权成绩查询 | ✅ 可用 | 已验证 | 列映射正确 |
| 成绩变化检测 | ⚠️ 部分 | 已验证 | **学分变化检测不到**（见 P1-7） |
| 邮件通知 | ❌ 不可用 | 已验证 | **完全断裂**（见 P0-1） |
| QQ 通知 | ❌ 不可用 | 已验证 | NapCat 不可达，且失败被吞 |
| 通知去重 | ✅ 可用 | 已验证 | SHA-256 指纹 |
| 通知重试 | ⚠️ 部分 | 静态判断 | 退避逻辑在，但因 `send()` 恒真从不触发 |
| IMAP 邮件指令 | ⚠️ 未知 | 尚未验证 | 代码完整，未实测 |
| 控制台仪表盘 | ✅ 可用 | 已验证 | 5 视图 + 轮询 |
| 控制台设置读写 | ✅ 可用 | 已验证 | 白名单 + 注释保留 |
| 学期列表 `/api/semesters` | ❌ 不可用 | 已验证 | **恒返回 `[]`**（见 P0-3） |
| 按学期查成绩 | ❌ 不可用 | 已验证 | 依赖学期列表 |
| 进程守护 / 心跳 | ⚠️ 部分 | 已验证 | PID 文件冲突（见 P1-8） |
| 看门狗 | ⚠️ 未知 | 尚未验证 | |
| 首次使用引导 | ✅ 可用 | 部分验证 | `setupStatus()` 逻辑存在 |
| 前端构建 | ✅ 可用 | 已验证 | `npm run build` / `build:check` 通过 |
| 单元测试 | ❌ 不可用 | 已验证 | **`test/` 目录不存在** |
| UI 测试 | ❌ 不可用 | 已验证 | 引用 3 个不存在的文件 |
| 选课捡漏 | ⚠️ 个人脚本 | 静态判断 | 硬编码路径/ID，非通用能力 |

---

## 5. 问题地图

> 优先级定义：P0 必须处理 / P1 强烈建议 / P2 能力提升 / P3 长期优化

### P0（核心功能错误、数据损坏、严重稳定性、安全问题）

#### P0-1 邮件通知完全断裂，且失败被伪装成成功
- **位置**：`lib/mailer.js:71-92`
- **现象**：`send()` 被替换为硬编码 `fetch('http://127.0.0.1:3002/send_private_msg')`，`catch` 中只记日志，函数**恒返回 `true`**
- **连带影响**：
  1. `NotificationOutbox` 将条目标记为 `sent`，**永不重试**
  2. `GET /api/state` 的 `capabilities.mail` 只看 `config.smtp` 是否配全，UI 显示"邮件已配置"
  3. `/api/actions/test-email` 返回成功 → 前端提示"测试邮件已发送"，**实际什么都没发**
  4. `scripts/test_email.js`、`scripts/test_all_emails.js` 同样假阳性
  5. README 中整章 SMTP 配置说明**与现实不符**
- **证据【已验证】**：真实 config 下 `isConfigured()===true`；`curl` NapCat 端口 → HTTP 000；`send()` 返回 `true`；`data/notification_outbox.json` 不存在
- **恢复来源**：`lib/mailer.js.bak` 保留了完整可用的 SMTP 实现（`transport.sendMail`）
- **根因（原则2）**：不是"某行写错"，而是**通知通道被硬编码进业务对象**。`Mailer` 类名与职责（SMTP）已不一致，且没有任何"通道可插拔"的抽象，导致临时改动直接覆盖生产路径。修复必须同时解决"通道抽象"与"失败必须可见"两件事，否则同类问题会再次发生。

#### P0-2 学期硬编码 `semesterId=117`
- **位置**：`lib/config.js`（`gradeUrl` 默认值）、`lib/monitor.js` `initializeGrades()`
- **现象**：`EAMS_GRADE_URL` 缺省时写死 `semesterId=117`；`initializeGrades()` 调 `extractGrades()` 不传学期参数
- **影响**：学期轮换后**静默监控过期学期**，永远抓不到新成绩，且无任何告警
- **证据【已验证】**：`lib/email_commands.js` 中的 `currentSemesterId()` 是**死代码**，从未被调用
- **根因**：学期上下文没有成为一等公民。系统里"当前学期"只存在于一个 URL 字符串里。

#### P0-3 `/api/semesters` 恒返回 `[]`，学期相关功能全废
- **位置**：`lib/http_eams_client.js` `listSemesters()`
- **现象**：EAMS 学期日历由 JS 渲染，静态 cheerio 解析拿不到 → 返回 `[]`
- **连带影响**：控制台"查看所选学期"不可用；`query_grades.js` / `query_all_grades.js` 直接以"未能获取学期列表"退出
- **证据【已验证】**：`curl /api/semesters` → `[]`；两个 query 脚本实测退出
- **已找到的修复数据源【已验证】**：`person!historyCourseGrade.action?projectType=MAJOR` 端点可用，返回 32 门课程 / 2 学期，表头 `学年学期|课程代码|课程名称|课程类别|课程性质|学分|总评成绩|绩点`
- **根因**：与 P0-2 同源 —— 学期信息没有统一的数据来源，两个传输层各写各的，且都只做了"最省事"的静态解析。

#### P0-4 明文凭据文件未被 `.gitignore` 覆盖
- **位置**：`eams.env.bak-20260921`、`eams.env.bak-tju-auth`
- **现象**：`.gitignore` 只精确列出 `eams.env`，两个 `.bak` 文件**含完全相同的明文凭据**（教务密码、邮箱授权码、AUTH token）却未被忽略
- **影响**：一旦执行 `git add .` 即泄露；项目自身 `CONTRIBUTING.md` / `SECURITY.md` 明确禁止提交这些内容
- **证据【已验证】**：读取 `.gitignore` 与两个 `.bak` 文件确认
- **注意**：当前目录**不是 git 仓库**（无 `.git`），所以尚未实际泄露。但这是"迟早会踩"的雷。
- **处置约束**：本次任务中**不得**将任何凭据内容写入文档、日志或提交。

#### P0-5 发件箱保留策略导致重复通知
- **位置**：`lib/notification_outbox.js` `prune()`
- **现象**：`prune()` 删除超过保留期的 `sent` 条目 → 同一成绩变化在保留期后被**再次通知**
- **证据【已验证】**：构造最小用例复现
- **根因**：去重依赖"记录还在"，而记录会被清理。去重键应独立于发件记录的生命周期。

#### P0-6 EAMS 500 错误页被当作"没有成绩"
- **位置**：`lib/http_eams_client.js` `_getHtml()`
- **现象**：只检测 CAS 跳转，不检测 `出错了` / `Error happened` / `CannotCreateTransactionException`
- **影响**：EAMS 数据库瞬时故障 → 解析出 0 门课程 → 被记为普通失败 → 触发失败计数与告警邮件（而告警邮件又发不出去，见 P0-1）
- **证据【已验证】**：实测 EAMS 间歇性返回 500（含 `org.hibernate.TransactionException: JDBC begin transaction failed`），随后连续 60 次成功
- **根因**：错误分类缺失。系统没有区分"传输失败 / 认证失败 / 服务端故障 / 真的没数据"。

### P1（架构缺陷、高耦合、重复实现、缺测试、明显技术债）

| 编号 | 问题 | 位置 | 验证等级 |
|---|---|---|---|
| P1-7 | `diffGrades` 检测不到**学分**变化（`GRADE_CHANGE_FIELDS` 无学分） | `lib/grades.js` | 已验证（复现：仅学分变化 → 0 diff） |
| P1-8 | dashboard 与 monitor **共用 PID 文件**，互相覆盖 | `bin/dashboard.js` / `bin/monitor.js` | 已验证（复现覆盖） |
| P1-9 | 重启资源泄漏：IMAP socket 不关闭（最长存活 600s）、tesseract worker 单例永不终止、outbox 不关闭；`shuttingDown` 置位后永久为真 | `lib/monitor.js` `stop()` | 静态判断 |
| P1-10 | `MonitorController.start()` 同步返回快照，异步失败被吞 → API 恒报 `ok:true` | `lib/monitor_controller.js:34-50` | 已验证（读码确认） |
| P1-11 | 日志函数每行做 O(n) 同步全量读写（实测 1.47ms/次；30 天累计约 1.1 分钟阻塞 I/O） | `lib/monitor.js` `createLogger` | 已验证（实测计时） |
| P1-12 | `idleLoop()` 138 行死代码，缺 `commandToken` 校验且 `while(true)` 无退出 | `lib/email_commands.js` | 静态判断 |
| P1-13 | IMAP 每 60s 重连，无连接复用 | `lib/email_commands.js` | 静态判断 |
| P1-14 | 双传输层重复实现（登录/解析/学期列表各写一份） | `lib/eams.js` vs `lib/http_eams_client.js` | 已验证（对比读码） |
| P1-15 | 测试基础设施**完全缺失**：`npm test` 因 `test/` 不存在而失败；`npm run test:ui` 引用 3 个不存在的文件 | `package.json` | 已验证（实际运行失败） |
| P1-16 | `bin/elect_loop.js` 硬编码个人路径 `/opt/grade/tju-grade`、`TARGET_ID='153358'`，重复实现 `loadEnv()` 与 `sendEmail()` | `bin/elect_loop.js` | 静态判断 |
| P1-17 | `query_grades.js` / `query_all_grades.js` / `query_weighted.js` 全部失效：硬编码绝对路径 + 字段名中英不匹配（读 `g.name`/`g.score`/`g.credit`，实际是 `课程名称`/`总评成绩`/`学分`） | 根目录 3 个脚本 | 已验证 |
| P1-18 | `COMMAND_EMAIL` 配置陷阱：缺省回落到 `NOTIFY_EMAIL`，而 IMAP 登录的是 `QQ_EMAIL`，无任何校验 | `lib/config.js` | 静态判断 |
| P1-19 | README 大面积失准：运行文件表、16 个未文档化配置项、邮件指令表、验证码文档与 `eams.env.example` 矛盾；引用不存在的 `eams_grade_checker_v2.js` / `快速使用\查成绩.bat` / `安装HTML启动支持.bat` / `test/` | `README.md` | 已验证 |
| P1-20 | 重复 `parseNum` 定义；`lib/cookie_jar.js` 有不可达 `expires` 分支 | `lib/grades.js` / `lib/cookie_jar.js` | 静态判断 |
| P1-21 | `web/app.js` 774 行单文件，无模块化；`web/dashboard.html` 1774 行生成物入库 | `web/` | 静态判断 |

### P2（能力提升）

| 编号 | 能力 | 价值 |
|---|---|---|
| P2-1 | 错误分类体系（传输/认证/服务端/空数据） | 消除 P0-6 类误判，是所有告警可信度的前提 |
| P2-2 | 通知通道可插拔（SMTP / QQ / Webhook / 本地） | 消除 P0-1 根因，用户可自选通道 |
| P2-3 | 学期自动发现与轮换 | 消除 P0-2/P0-3 |
| P2-4 | 结构化日志 + 轮转（替换 O(n) 同步写） | 消除 P1-11，提升可观测性 |
| P2-5 | 健康检查端点 `/api/health`（含依赖可达性） | 让"配置了但不可用"可见 |
| P2-6 | 配置自检 `npm run doctor` | 把 P1-18 类陷阱变成启动期报错 |
| P2-7 | 成绩变化历史归档 | 支持"什么时候变的"追溯 |
| P2-8 | 通知投递状态可视化 | 发件箱状态进控制台 |

### P3（长期优化）

| 编号 | 内容 |
|---|---|
| P3-1 | `web/app.js` 模块化拆分 |
| P3-2 | 清理全部 `.bak*` 文件（需先确认无回滚依赖） |
| P3-3 | `bin/elect_loop.js` 通用化或移出主仓库 |
| P3-4 | 补充架构文档与配置项参考 |
| P3-5 | CI（当前无 `.github/`） |

---

## 6. 潜在风险

| 风险 | 触发条件 | 后果 | 当前是否有防护 |
|---|---|---|---|
| 学期轮换后静默失效 | 每学期开学 | 长期抓不到成绩，无告警 | ❌ 无 |
| 凭据泄露 | 执行 `git add .` | 教务密码/邮箱授权码外泄 | ❌ `.bak` 未忽略 |
| 通知静默丢失 | 任何成绩变化 | 用户以为会收到邮件，实际没有 | ❌ 失败被伪装为成功 |
| EAMS 故障被误判 | EAMS 数据库抖动 | 误报告警 + 失败计数污染 | ❌ 无错误分类 |
| 重启后状态丢失 | 进程重启 | 监控中断、`shuttingDown` 永久置位 | ⚠️ 部分 |
| 长期运行退化 | 连续运行 30 天 | 日志 I/O 阻塞累积、IMAP 连接泄漏 | ⚠️ 部分 |
| 依赖服务不可达 | tju-auth / NapCat 未部署 | 功能静默降级 | ❌ 无降级提示 |
| 单模块故障扩散 | IMAP 异常 | 可能影响主监控循环 | 【尚未验证】 |
| Node 版本不符 | 环境 Node 20.19.2，`engines` 要求 ≥22 | 潜在运行时差异 | ❌ 无启动校验 |

---

## 7. 可提升能力（按 价值 × 频率 × 风险 × 复杂度 排序）

| 排序 | 能力 | 价值 | 频率 | 风险 | 复杂度 | 结论 |
|---|---|---|---|---|---|---|
| 1 | 通知通道可插拔 + 失败可见 | 极高 | 高 | 低 | 中 | **做** |
| 2 | 错误分类体系 | 极高 | 高 | 低 | 低 | **做** |
| 3 | 学期自动发现 | 高 | 低（每学期） | 低 | 中 | **做** |
| 4 | 测试基础设施（先补核心纯函数） | 高 | 高 | 无 | 中 | **做** |
| 5 | 配置自检 `doctor` | 高 | 中 | 无 | 低 | **做** |
| 6 | 结构化日志 + 轮转 | 中 | 高 | 低 | 低 | **做** |
| 7 | 健康检查端点 | 中 | 中 | 无 | 低 | **做** |
| 8 | 成绩变化历史归档 | 中 | 低 | 低 | 中 | 可做 |
| 9 | 前端模块化 | 低 | — | 中 | 高 | 缓 |
| 10 | 引入框架/大型依赖 | — | — | 高 | 高 | **不做** |

**明确不做**：引入 TypeScript 重写、引入 ORM/数据库、引入消息队列、把双传输层合并为单一实现（会破坏 `EAMS_TRANSPORT` 兼容性）。

---

## 8. 建议的整体目标架构

**核心思路：不推倒重来，在现有骨架上补齐"缺失的抽象层"与"可信的失败路径"。**

```
┌─────────────────────────────────────────────────────────────┐
│ 入口层（保持 CLI/脚本兼容）                                   │
│  bin/dashboard.js  bin/monitor.js  bin/watchdog.js           │
│  + 独立 PID 文件命名空间（dashboard / monitor 分离）           │
├─────────────────────────────────────────────────────────────┤
│ 控制层                                                       │
│  dashboard_server.js  + /api/health  + 投递状态可视化         │
│  monitor_controller.js  → start() 改为可 await，失败可上报     │
├─────────────────────────────────────────────────────────────┤
│ 业务层                                                       │
│  monitor.js  → 拆出 logger / state / lock 到独立模块          │
│  grades.js   → 统一字段定义（含学分），单一 parseNum          │
│  semester.js 【新】→ 学期发现/缓存/轮换，唯一数据源            │
│  errors.js   【新】→ 错误分类（TRANSPORT/AUTH/SERVER/EMPTY）  │
├─────────────────────────────────────────────────────────────┤
│ 通知层【新抽象】                                              │
│  notifier/index.js  → 通道注册与选择                          │
│  notifier/smtp.js   → 恢复 .bak 中的 SMTP 实现                │
│  notifier/qq.js     → 现有 NapCat 逻辑，改为可选通道           │
│  notifier/local.js  → 落盘/控制台，离线可用                    │
│  统一契约：send() 必须真实反映结果，失败必须抛出或返回 false    │
│  outbox.js → 去重键独立于记录生命周期                          │
├─────────────────────────────────────────────────────────────┤
│ 传输层（保持两条并存，抽取共享解析）                           │
│  transport/http.js  transport/browser.js                     │
│  transport/parse.js 【新】→ 共享表格解析纯函数                 │
├─────────────────────────────────────────────────────────────┤
│ 基础设施层                                                   │
│  config.js  storage.js  cookie_jar.js  captcha_ocr.js        │
│  + logger.js【新】结构化 + 轮转                                │
│  + doctor.js【新】启动期配置自检                               │
├─────────────────────────────────────────────────────────────┤
│ 测试层【新】                                                  │
│  test/unit/  纯函数（grades/parse/config/outbox/errors）      │
│  test/integration/  本地 HTTP 夹具，不打真实 EAMS              │
│  test/fixtures/  EAMS 页面样本（脱敏）                         │
└─────────────────────────────────────────────────────────────┘
```

**兼容性承诺**：
- 所有 CLI 命令、`package.json` scripts 名称不变
- `eams.env` 所有现有配置项保持有效，新增项均有默认值
- 控制台 HTTP API 路径与鉴权方式不变（仅新增 `/api/health`）
- `data/` 下所有文件格式不变（`grades_latest.json`、`notification_outbox.json`）
- `EAMS_TRANSPORT=http|browser` 两种模式都保留

---

## 9. 分阶段改造路线

| 阶段 | 主题 | 目标 | 关键产出 |
|---|---|---|---|
| **Phase 1** | 止血 + 测试地基 | 让"通知真的能发出去"且"失败看得见"；建立可运行的测试 | 恢复 SMTP、通知通道抽象、错误分类、`test/` 骨架 + 核心纯函数测试 |
| **Phase 2** | 学期上下文 | 消除 `semesterId=117` 硬编码，`/api/semesters` 可用 | `semester.js`、学期自动发现、按学期查询打通 |
| **Phase 3** | 稳定性与资源 | 长期运行不退化 | logger 结构化+轮转、`stop()` 完整释放、PID 命名空间分离、`start()` 可 await |
| **Phase 4** | 可观测与自检 | 问题在发生前被发现 | `/api/health`、`npm run doctor`、投递状态可视化、配置校验 |
| **Phase 5** | 工程化收尾 | 文档与资产同步 | README 校正、ARCHITECTURE.md、清理 `.bak`、CI |

**每阶段固定流程**：明确目标 → 修改 → 补测试 → 运行验证 → 检查回归 → 更新文档 → 生成阶段报告。

---

## 10. 第一阶段具体实施内容（Phase 1 提案）

> 原则：小步、可验证、可回滚。**先修结构，再稳核心，再补测试**——但本阶段把"测试地基"提前，因为后续所有阶段都依赖它。

### 1.1 恢复邮件发送能力（P0-1）
- 从 `lib/mailer.js.bak` 恢复 SMTP `send()` 实现
- **不改** `Mailer` 的对外签名（`send(subject, body)` → `Promise<boolean>`），保证调用方零改动
- NapCat 逻辑**不删除**，迁移为独立可选通道（Phase 1 内以最小形式落地：`lib/notifier/qq.js`）
- `send()` 语义修正：真实失败必须 `return false` 或抛错，**禁止吞异常后返回 true**

### 1.2 通知通道抽象（P0-1 根因）
- 新增 `lib/notifier/index.js`：按配置选择通道，支持多通道并投
- 通道契约：`{ name, isConfigured(), send(subject, body) }`，`send` 失败必须抛出
- 默认通道 = SMTP（保持现有行为），NapCat 仅在显式配置时启用

### 1.3 错误分类体系（P0-6 根因）
- 新增 `lib/errors.js`：`TransportError` / `AuthError` / `ServerError` / `EmptyDataError`
- `HttpEamsClient._getHtml()` 检测 EAMS 500 页特征串 → 抛 `ServerError`
- 监控循环按错误类型决定：是否计入失败、是否告警、是否重试

### 1.4 测试地基（P1-15）
- 创建 `test/` 目录，使 `npm test` 可运行
- `test/unit/`：`grades.js`（diff/模板/转义）、`config.js`（env 解析）、`notification_outbox.js`（去重/重试/保留）、`errors.js`
- `test/fixtures/`：脱敏的 EAMS 页面样本（**不得含真实成绩单**）
- 修复 `npm run test:ui` 引用路径，或明确标注为暂不可用

### 1.5 安全止血（P0-4）
- `.gitignore` 增加 `eams.env.bak-*` 与 `*.bak-*` 模式
- 不删除 `.bak` 文件（原则5：不能仅凭"看起来没用"删除），但确保不被提交

### 1.6 发件箱去重修复（P0-5）
- 去重键与 `sent` 记录生命周期解耦（保留独立的已通知指纹集）

### 1.7 本阶段明确不做
- 不重构双传输层
- 不动前端
- 不改任何现有配置项语义
- 不删除任何 `.bak` 文件

### 1.8 验收标准
1. `npm test` 可运行且通过
2. `npm run check` / `npm run build:check` 继续通过
3. 用真实配置调用 `Mailer.send()`，返回 `true` 且**实际收到邮件**（需真实环境验证）
4. 断开网络/错误配置时 `send()` 返回 `false` 或抛错，outbox 条目标记为待重试
5. `curl /api/state` 的 `capabilities.mail` 反映**真实可达性**而非仅配置存在
6. `git status` 不再显示 `eams.env.bak-*`

---

## 附录 A：环境约束（实测）

| 项 | 实测值 | 影响 |
|---|---|---|
| Node.js | 20.19.2 | `engines` 要求 ≥22，存在差异 |
| git 仓库 | 无 `.git` | 无法用 git 做回归对比，回滚需手工备份 |
| CI | 无 `.github/` | 无自动化验证 |
| `tju-auth` 服务 | `127.0.0.1:8792` 不可达 | `_renewFromAuthService()` 路径不可用 |
| NapCat | `127.0.0.1:3002` 不可达（HTTP 000） | QQ 通知不可用 |
| EAMS | 间歇性 500 | 需错误分类 |
| QQ SMTP | 未实测发信 | **需真实环境验证** |

## 附录 B：已验证的正面结论（不应在重构中破坏）

1. `publicSettings()` **不泄露**密钥类配置
2. 未鉴权 POST 被正确拒绝
3. 控制台安全防护齐备：CSP + `timingSafeEqual` 令牌比对 + Origin 白名单 + Host 头校验（防 DNS rebinding）
4. 原子写（临时文件 + `renameSync`）实现正确
5. `updateEnvFile()` 保留注释与顺序，白名单校验有效
6. `buildWeightedEmail` 列映射与真实数据一致
7. CASTGC 静默续期可用
8. `npm run check` 与 `npm run build:check` 通过
9. 未发现循环依赖

## 附录 C：待确认事项（需用户决策）

1. **NapCat/QQ 通知**是保留为正式通道，还是仅作为个人环境附加能力？
2. **`bin/elect_loop.js`（选课捡漏）**是否属于本项目正式范围？是否应通用化？
3. **`tju-auth` 共享登录服务**是否仍是目标架构的一部分？当前不可达，相关代码路径是否保留？
4. **Node 版本**：是否将 `engines` 下调至 ≥20，还是要求升级运行环境？
5. **`.bak*` 文件**：确认无回滚依赖后是否清理？
