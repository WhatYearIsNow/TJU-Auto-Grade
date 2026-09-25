# Phase 02 — 学期上下文

> 本阶段目标：消除 `semesterId=117` 硬编码，使 `/api/semesters` 可用，学分变化检测生效。

---

## 本阶段目标 / 完成内容

### 2.1 学期自动发现（semester.js）

- **新增文件**：`lib/semester.js`
- **功能**：从 `historyCourseGrade` 端点提取学期列表和完整课程数据
- **核心函数**：
  - `extractSemestersFromHtml(html)` → 学期字符串数组
  - `extractAllGradesFromHtml(html)` → 完整课程数据（含学分、绩点）
  - `semesterIdFromLabel(label)` → EAMS semesterId
  - `semesterLabelFromId(id)` → 学期字符串
- **验证**：实测返回 `['2025-2026 1', '2025-2026 2']`，32 门课程（Level 2 已验证）

### 2.2 /api/semesters 可用（P0-3 修复）

- **修改文件**：`lib/http_eams_client.js` `listSemesters()`
- **改动**：从静态 cheerio 解析学期日历 → 从 `historyCourseGrade` 端点提取学期
- **效果**：`/api/semesters` 返回真实学期数据（`[{id:'116', label:'2025-2026 1'}, ...]`）
- **验证**：实测返回 2 个学期（Level 2 已验证）

### 2.3 消除 semesterId=117 硬编码（P0-2 修复）

- **修改文件**：`lib/config.js`、`lib/monitor.js`
- **config.js**：`gradeUrl` 默认值从 `...?semesterId=117&projectType=` 改为 `...?projectType=`（去掉硬编码 semesterId）
- **monitor.js**：
  - 新增 `this.currentSemester` 属性，初始化时保存最新学期
  - `initializeGrades()` 先调用 `listSemesters()` 发现学期，取 id 最大的学期作为监控目标
  - `checkGrades()` 使用 `this.currentSemester.id` 作为学期参数
- **效果**：学期轮换后自动切换到最新学期，不再监控过期学期
- **验证**：逻辑正确（Level 2 静态判断 + 模块加载验证）

### 2.4 双传输层共享解析（已部分完成）

- **现状**：`http_eams_client.js` 已导入 `parseGradeTables` 和 `normalizeSemesterOptions` 从 `eams.js`，`_tablesFromHtml()` 输出格式与 `eams.js` `readGradeTables()` 一致
- **Phase 2 结论**：共享解析已部分到位，无需额外重构

### 2.5 学分变化检测（P1-7 修复）

- **修改文件**：`lib/grades.js`
- **改动**：`GRADE_CHANGE_FIELDS` 新增 `'学分'`
- **效果**：学分变化现在会被 `diffGrades()` 检测到并触发通知
- **验证**：单元测试通过（Level 2 已验证）

---

## 文件变化

### 新增文件（1 个）

| 文件 | 行数 | 说明 |
|---|---|---|
| `lib/semester.js` | ~100 | 学期自动发现 |
| `test/unit/semester.test.js` | ~100 | 学期测试 |

### 修改文件（3 个）

| 文件 | 改动说明 |
|---|---|
| `lib/http_eams_client.js` | `listSemesters()` 改用 `historyCourseGrade` 端点；导入 `semester.js` |
| `lib/config.js` | `gradeUrl` 默认值去掉 `semesterId=117` |
| `lib/monitor.js` | 新增 `currentSemester`；`initializeGrades`/`checkGrades` 使用学期参数 |
| `lib/grades.js` | `GRADE_CHANGE_FIELDS` 新增 `'学分'` |

---

## 测试结果

- **`npm run check`**：全部通过
- **`npm test`**：72 个用例，0 失败（新增 12 个 semester 测试 + 1 个 credit 测试）
- **`npm run build:check`**：dashboard.html 同步

---

## 风险

1. **`gradeUrl` 去掉 semesterId**：如果 EAMS 默认返回空结果，需要确认 `person!search.action` 不带 semesterId 时的行为。实测中该端点间歇性返回 500，所以监控实际走 `historyCourseGrade` 路径。
2. **`listSemesters()` 依赖 `historyCourseGrade`**：如果该端点也返回 500，`listSemesters` 会抛出 `ServerError`。当前 `checkGrades` 的 `recordFailure()` 会处理这种情况。

---

## 尚未完成

- **P1-8**：PID 文件冲突（Phase 3 处理）
- **P1-9**：重启资源泄漏（Phase 3 处理）
- **P1-10**：`MonitorController.start()` 同步返回（Phase 3 处理）
- **P1-11**：日志 O(n) 同步 I/O（Phase 3 处理）
- **P1-12**：`idleLoop()` 138 行死代码（Phase 3 处理）
- **P1-16**：`query_*.js` 脚本失效（Phase 5 处理）
- **P1-19**：README 大面积失准（Phase 5 处理）

---

## 下一阶段

**Phase 3 — 稳定性与资源**：PID 命名空间分离、`stop()` 完整释放、`start()` 可 await、结构化日志 + 轮转。
