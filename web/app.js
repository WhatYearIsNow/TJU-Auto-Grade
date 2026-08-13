function startDashboardClient() {
const token = document.querySelector('meta[name="dashboard-token"]').content;

const state = {
  status: null,
  grades: [],
  currentGrades: [],
  semesters: [],
  notifications: [],
  logs: [],
  settingsLoaded: false,
  settingsConfigured: {},
  supportedSettings: new Set(),
  setup: null,
  activeView: 'overview',
  polling: false,
  gradeMode: 'current',
  semestersLoaded: false,
  showOlderSemesters: false,
  semestersUpdatedAt: 0,
};

const DEFAULT_SEMESTER_LIMIT = 8;
const SEMESTER_REFRESH_INTERVAL = 6 * 60 * 60 * 1000;
const SETTINGS_EXPORT_FORMAT = 'tju-auto-grade-settings';
const SECRET_SETTING_NAMES = new Set([
  'EAMS_PASSWORD', 'QQ_SMTP_CODE', 'DASHSCOPE_API_KEY', 'COMMAND_TOKEN', 'SMTP_PASS', 'IMAP_PASS',
]);

const viewTitles = {
  overview: '运行概览',
  grades: '成绩中心',
  notifications: '通知记录',
  logs: '运行日志',
  settings: '系统设置',
};

const phaseLabels = {
  stopped: '监控已停止',
  stopping: '正在停止',
  starting: '正在启动监控',
  running: '监控运行正常',
  error: '监控需要处理',
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function api(path, options = {}) {
  const request = {
    method: options.method || 'GET',
    headers: { Accept: 'application/json' },
  };
  if (request.method !== 'GET') {
    request.headers['Content-Type'] = 'application/json';
    request.headers['X-TJU-Dashboard-Token'] = token;
    request.body = JSON.stringify(options.body || {});
  }
  const response = await fetch(path, request);
  const payload = await response.json().catch(() => ({ ok: false, error: '服务返回内容无法读取' }));
  if (!response.ok || !payload.ok) throw new Error(payload.error || `请求失败 (${response.status})`);
  return payload.data;
}

function formatDate(value, fallback = '暂无') {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toLocaleString('zh-CN', { hour12: false });
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours} 小时 ${minutes} 分`;
}

function showToast(title, message, isError = false) {
  const region = document.getElementById('toast-region');
  const toast = document.createElement('div');
  toast.className = `toast${isError ? ' is-error' : ''}`;
  const copy = document.createElement('div');
  const heading = document.createElement('b');
  heading.textContent = title;
  const body = document.createElement('span');
  body.textContent = message;
  copy.append(heading, body);
  const close = document.createElement('button');
  close.type = 'button';
  close.setAttribute('aria-label', '关闭提示');
  close.textContent = '×';
  close.addEventListener('click', () => toast.remove());
  toast.append(copy, close);
  region.append(toast);
  setTimeout(() => toast.remove(), 5200);
}

function setStatusDot(element, phase) {
  element.className = 'status-dot';
  if (phase === 'running') element.classList.add('is-running');
  else if (phase === 'starting' || phase === 'stopping') element.classList.add('is-starting');
  else if (phase === 'error') element.classList.add('is-error');
}

function switchView(view) {
  if (!viewTitles[view]) return;
  state.activeView = view;
  document.querySelectorAll('[data-view-panel]').forEach(panel => {
    const active = panel.dataset.viewPanel === view;
    panel.hidden = !active;
    panel.classList.toggle('is-active', active);
  });
  document.querySelectorAll('[data-view]').forEach(button => {
    button.classList.toggle('is-active', button.dataset.view === view);
  });
  document.getElementById('page-title').textContent = viewTitles[view];
  closeMobileMenu();
  if (view === 'logs') loadLogs();
  if (view === 'settings' && !state.settingsLoaded) loadSettings();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function openMobileMenu() {
  document.getElementById('sidebar').classList.add('is-open');
  document.getElementById('mobile-backdrop').hidden = false;
  document.getElementById('menu-button').setAttribute('aria-expanded', 'true');
}

function closeMobileMenu() {
  document.getElementById('sidebar').classList.remove('is-open');
  document.getElementById('mobile-backdrop').hidden = true;
  document.getElementById('menu-button').setAttribute('aria-expanded', 'false');
}

function renderStatus() {
  const payload = state.status;
  if (!payload) return;
  const phase = payload.phase || 'stopped';
  const monitor = payload.monitor;
  const monitorState = monitor?.state || {};
  const needsSetup = payload.setup && !payload.setup.complete;
  const label = needsSetup ? '等待首次配置' : phaseLabels[phase] || phase;

  for (const id of ['sidebar-status-dot', 'topbar-status-dot']) {
    setStatusDot(document.getElementById(id), phase);
  }
  document.getElementById('sidebar-status-text').textContent = label;
  document.getElementById('topbar-status-text').textContent = label;

  const hero = document.querySelector('.hero-card');
  hero.className = `hero-card status-${phase}`;
  document.getElementById('hero-kicker').textContent = phase === 'running' ? '实时监控已连接' : '监控服务';
  document.getElementById('overview-heading').textContent = label;
  let description = '控制台保持在线，你可以从这里启动监控。';
  if (needsSetup) description = '请先在系统设置中填写学号和教务密码，保存后监控会自动启动。';
  if (phase === 'starting') description = '正在打开 EAMS 并恢复登录。如果出现验证码，请在弹出的浏览器窗口中完成登录。';
  if (phase === 'running') description = monitor?.sessionRecovering
    ? 'EAMS 会话正在恢复，完成登录后会自动继续查分。'
    : '成绩检查、通知队列和邮件指令都在后台运行，无需盯着终端。';
  if (phase === 'error') description = payload.error || '监控启动失败，请查看日志或检查设置。';
  if (phase === 'stopping') description = '正在安全关闭浏览器并保存本机状态。';
  document.getElementById('hero-description').textContent = description;
  document.getElementById('hero-last-check').textContent = `最近检查：${formatDate(monitorState.lastCheck)}`;
  const resultText = {
    change: '发现成绩更新', nochange: '成绩无变化', fail: '最近检查失败', cas: '等待重新登录',
  }[monitorState.lastResult] || (phase === 'running' ? '等待下次检查' : '监控未就绪');
  document.getElementById('hero-next-step').textContent = resultText;

  document.getElementById('metric-grades').textContent = monitorState.gradeCount ?? state.grades.length ?? '—';
  document.getElementById('metric-grades-note').textContent = monitorState.lastChange
    ? `最近变化 ${monitorState.lastChange}` : '来自最新本机快照';
  document.getElementById('metric-uptime').textContent = formatDuration(payload.dashboard?.uptimeSeconds);
  document.getElementById('metric-pending').textContent = monitorState.outboxPending ?? 0;
  document.getElementById('metric-pending-note').textContent = monitorState.outboxRetrying
    ? `${monitorState.outboxRetrying} 条正在重试` : '自动重试已启用';
  document.getElementById('metric-failures').textContent = monitorState.failCount ?? 0;
  document.getElementById('metric-failures-note').textContent = monitorState.failCount ? '建议查看运行日志' : '暂无连续异常';

  const pending = Number(monitorState.outboxPending || 0);
  const navCount = document.getElementById('nav-pending-count');
  navCount.textContent = pending;
  navCount.hidden = pending === 0;

  const capabilities = payload.capabilities || {};
  state.setup = payload.setup || state.setup;
  renderSetupGuide(state.setup);
  const readiness = [
    ['监控浏览器', phase === 'running' ? '已连接' : phase === 'starting' ? '启动中' : '未连接', phase === 'running'],
    ['邮件通知', capabilities.mail ? '已配置' : '未配置', capabilities.mail],
    ['邮件指令', capabilities.imap ? '已启用' : '未启用', capabilities.imap],
    ['AI 验证码', capabilities.aiLogin ? '已配置' : '手动登录', capabilities.aiLogin],
  ];
  document.getElementById('readiness-list').innerHTML = readiness.map(([name, value, ready]) =>
    `<div class="readiness-row"><span>${name}</span><b class="${ready ? 'is-ready' : 'is-warning'}">${value}</b></div>`
  ).join('');

  document.querySelectorAll('[data-action="check"], [data-action="weighted"], [data-action="retry-notifications"]').forEach(button => {
    button.disabled = phase !== 'running';
  });
  document.getElementById('query-semester').disabled = phase !== 'running' || state.semesters.length === 0;
  document.querySelectorAll('[data-action="stop"]').forEach(button => {
    button.disabled = phase === 'stopped' || phase === 'stopping';
  });
  document.querySelectorAll('[data-action="restart"]').forEach(button => {
    button.textContent = phase === 'stopped' || phase === 'error' ? '启动监控' : '重启监控';
    button.disabled = Boolean(needsSetup);
  });
  document.querySelectorAll('[data-action="test-email"]').forEach(button => {
    button.disabled = !capabilities.mail;
  });
}

function renderSetupGuide(setup) {
  if (!setup) return;
  const guide = document.getElementById('setup-guide');
  if (!guide) return;
  guide.classList.toggle('is-complete', setup.complete);
  document.getElementById('setup-guide-title').textContent = setup.complete
    ? '基础配置已完成，可以正常启动监控'
    : '完成两个必填项即可开始使用';
  document.getElementById('setup-guide-description').textContent = setup.complete
    ? '配置已保存在本机 eams.env；可导出非敏感参数供其他电脑复用。'
    : '当前只启动本机控制台，不会提前打开教务浏览器。';
  for (const [name, step] of Object.entries(setup.steps || {})) {
    const element = document.querySelector(`[data-setup-step="${name}"]`);
    if (!element) continue;
    element.classList.toggle('is-ready', step.ready);
    element.querySelector('em').textContent = step.ready ? '已完成' : step.required ? '需要配置' : '可选';
  }
}

function gradeIdentity(grade) {
  return [grade['学年学期'], grade['课程代码'], grade['课程名称'], grade['教学班'], grade['教学班号']].join('|');
}

function sortedGrades() {
  return [...state.grades].sort((left, right) => {
    const semester = String(right['学年学期'] || '').localeCompare(String(left['学年学期'] || ''), 'zh-CN');
    if (semester !== 0) return semester;
    return String(left['课程名称'] || '').localeCompare(String(right['课程名称'] || ''), 'zh-CN');
  });
}

function renderRecentGrades() {
  const container = document.getElementById('recent-grades');
  const grades = sortedGrades().slice(0, 5);
  if (grades.length === 0) {
    container.innerHTML = '<div class="empty-state compact">尚未读取成绩快照</div>';
    return;
  }
  container.innerHTML = grades.map(grade => `
    <div class="compact-grade" data-grade-id="${escapeHtml(gradeIdentity(grade))}">
      <div class="compact-grade-name"><b>${escapeHtml(grade['课程名称'] || '未知课程')}</b><small>${escapeHtml(grade['课程代码'] || '无课程代码')}</small></div>
      <span>${escapeHtml(grade['学年学期'] || '-')}</span>
      <span>${escapeHtml(grade['学分'] || '-')} 学分</span>
      <span class="score-pill">${escapeHtml(grade['总评成绩'] ?? '-')}</span>
    </div>`).join('');
}

function updateSemesterOptions() {
  const select = document.getElementById('semester-filter');
  const current = select.value;
  const semesters = [...new Set(state.grades.map(grade => grade['学年学期']).filter(Boolean))]
    .sort((a, b) => String(b).localeCompare(String(a), 'zh-CN'));
  select.innerHTML = '<option value="">全部学期</option>' + semesters
    .map(semester => `<option value="${escapeHtml(semester)}">${escapeHtml(semester)}</option>`).join('');
  if (semesters.includes(current)) select.value = current;
}

function renderGrades() {
  const query = document.getElementById('grade-search').value.trim().toLowerCase();
  const semester = document.getElementById('semester-filter').value;
  const grades = sortedGrades().filter(grade => {
    const matchesSemester = !semester || grade['学年学期'] === semester;
    const haystack = `${grade['课程名称'] || ''} ${grade['课程代码'] || ''}`.toLowerCase();
    return matchesSemester && (!query || haystack.includes(query));
  });
  document.getElementById('grade-result-count').textContent = `${grades.length} 门课程`;
  document.getElementById('grades-empty').hidden = grades.length > 0;
  document.getElementById('grades-table-body').innerHTML = grades.map(grade => {
    const details = [
      ['平时', grade['平时成绩']], ['实验', grade['实验成绩']], ['期末', grade['期末成绩']],
    ].filter(([, value]) => value !== undefined && value !== '').map(([name, value]) => `${name} ${value}`).join(' · ');
    return `<tr>
      <td>${escapeHtml(grade['课程名称'] || '未知课程')}<small>${escapeHtml(grade['课程代码'] || '-')}</small></td>
      <td>${escapeHtml(grade['学年学期'] || '-')}</td>
      <td>${escapeHtml(grade['教学班'] || grade['教学班号'] || '-')}</td>
      <td>${escapeHtml(grade['学分'] || '-')}</td>
      <td class="score">${escapeHtml(grade['总评成绩'] ?? '-')}</td>
      <td>${escapeHtml(grade['绩点'] ?? '-')}</td>
      <td class="detail-text">${escapeHtml(details || '暂无明细')}</td>
    </tr>`;
  }).join('');
}

function renderNotifications() {
  const items = state.notifications;
  const pending = items.filter(item => item.status === 'pending');
  const sent = items.filter(item => item.status === 'sent');
  document.getElementById('notification-pending').textContent = pending.length;
  document.getElementById('notification-retrying').textContent = pending.filter(item => item.attempts > 0).length;
  document.getElementById('notification-sent').textContent = sent.length;
  const container = document.getElementById('notification-list');
  if (items.length === 0) {
    container.innerHTML = '<div class="empty-state">暂无通知记录</div>';
    return;
  }
  container.innerHTML = items.map(item => {
    const isSent = item.status === 'sent';
    const meta = item.meta || {};
    const detail = [meta.course, meta.semester, meta.change === 'new' ? '新成绩' : meta.change === 'updated' ? '成绩更新' : meta.change === 'removed' ? '成绩移除' : ''].filter(Boolean).join(' · ');
    return `<div class="notification-item ${isSent ? 'is-sent' : ''}">
      <span class="notification-marker"></span>
      <div class="notification-copy"><b>${escapeHtml(item.subject || '成绩通知')}<span class="status-badge ${isSent ? 'sent' : ''}">${isSent ? '已发送' : item.attempts ? '重试中' : '待发送'}</span></b><p>${escapeHtml(detail || '系统通知')}</p>${item.lastError ? `<small>${escapeHtml(item.lastError)}</small>` : ''}</div>
      <time class="notification-time">${escapeHtml(formatDate(item.sentAt || item.createdAt))}</time>
    </div>`;
  }).join('');
}

function renderLogs() {
  const container = document.getElementById('log-lines');
  if (state.logs.length === 0) {
    container.innerHTML = '<div class="log-empty">暂无日志</div>';
    return;
  }
  container.innerHTML = state.logs.map(line => {
    const match = line.match(/^\[([^\s]+)\s+([^\]]+)\]\s*(.*)$/);
    const time = match?.[1] || '';
    const tag = match?.[2] || 'LOG';
    const message = match?.[3] || line;
    const lower = `${tag} ${message}`.toLowerCase();
    const variant = /fail|fatal|error|异常|失败/.test(lower) ? ' is-error' : /成功|ready|sent|无变化/.test(lower) ? ' is-success' : '';
    return `<div class="log-line${variant}"><span class="log-time">${escapeHtml(time)}</span><span class="log-tag">${escapeHtml(tag)}</span><span class="log-message">${escapeHtml(message)}</span></div>`;
  }).join('');
  container.scrollTop = container.scrollHeight;
  document.getElementById('log-updated').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
}

function renderWeighted(data) {
  const container = document.getElementById('weighted-result');
  if (!data || (!data.summary?.length && !data.tableGrades?.length)) {
    container.innerHTML = '<div class="empty-state compact">没有读取到总加权数据</div>';
    return;
  }
  const summary = (data.summary || []).slice(0, 20).map(item => `<span>${escapeHtml(item)}</span>`).join('');
  const rows = (data.tableGrades || []).slice(0, 200).map((row, rowIndex) => `<tr>${row.map(cell => rowIndex === 0
    ? `<th>${escapeHtml(cell)}</th>` : `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('');
  container.innerHTML = `${summary ? `<div class="weighted-summary">${summary}</div>` : ''}${rows ? `<div class="weighted-table"><table class="data-table"><tbody>${rows}</tbody></table></div>` : ''}`;
}

async function loadStatus(showError = false) {
  try {
    state.status = await api('/api/status');
    renderStatus();
  } catch (error) {
    setConnectionLost();
    if (showError) showToast('无法连接控制台', error.message, true);
  }
}

async function loadGrades() {
  try {
    state.currentGrades = await api('/api/grades');
    if (state.gradeMode === 'current') {
      state.grades = state.currentGrades;
      updateSemesterOptions();
      renderGrades();
      renderRecentGrades();
    }
  } catch {}
}

async function loadSemesters(showError = false) {
  try {
    state.semesters = await api('/api/semesters');
    state.semestersLoaded = true;
    state.semestersUpdatedAt = Date.now();
    state.showOlderSemesters = false;
    renderSemesterQueryOptions();
    renderStatus();
  } catch (error) {
    if (showError) showToast('学期列表读取失败', error.message, true);
  }
}

function renderSemesterQueryOptions(preferredId = '') {
  const select = document.getElementById('semester-query-select');
  const toggle = document.getElementById('toggle-older-semesters');
  const olderCount = Math.max(0, state.semesters.length - DEFAULT_SEMESTER_LIMIT);
  const visibleSemesters = state.showOlderSemesters
    ? state.semesters
    : state.semesters.slice(0, DEFAULT_SEMESTER_LIMIT);
  select.innerHTML = visibleSemesters.length > 0
    ? visibleSemesters.map(semester => `<option value="${escapeHtml(semester.id)}">${escapeHtml(semester.label)}</option>`).join('')
    : '<option value="">没有读取到可用学期</option>';
  if (preferredId && visibleSemesters.some(semester => semester.id === preferredId)) select.value = preferredId;
  toggle.hidden = olderCount === 0;
  toggle.textContent = state.showOlderSemesters ? '收起更早学期' : `显示更早学期（${olderCount}）`;
  toggle.setAttribute('aria-expanded', String(state.showOlderSemesters));
}

function toggleOlderSemesters() {
  const selectedId = document.getElementById('semester-query-select').value;
  state.showOlderSemesters = !state.showOlderSemesters;
  renderSemesterQueryOptions(selectedId);
}

function showCurrentGrades() {
  state.gradeMode = 'current';
  state.grades = state.currentGrades;
  document.getElementById('grade-source-label').textContent = '监控成绩快照';
  document.getElementById('show-current-grades').hidden = true;
  updateSemesterOptions();
  renderGrades();
  renderRecentGrades();
}

async function querySemesterGrades() {
  const select = document.getElementById('semester-query-select');
  const semesterId = select.value;
  if (!semesterId) {
    showToast('请选择学期', '没有可查询的学期编号。', true);
    return;
  }
  const button = document.getElementById('query-semester');
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = '正在查询…';
  try {
    const data = await api('/api/actions/semester-grades', {
      method: 'POST',
      body: { semesterId },
    });
    const semester = state.semesters.find(item => item.id === semesterId);
    const label = semester?.label || `学期 ${semesterId}`;
    state.gradeMode = 'history';
    state.grades = (data.grades || []).map(grade => grade['学年学期']
      ? grade : { ...grade, '学年学期': label });
    document.getElementById('grade-source-label').textContent = `历史学期：${label}`;
    document.getElementById('show-current-grades').hidden = false;
    updateSemesterOptions();
    renderGrades();
    showToast('历史成绩已读取', `${label} 共 ${state.grades.length} 门课程。`);
  } catch (error) {
    showToast('历史学期查询失败', error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = originalText;
    renderStatus();
  }
}

async function loadNotifications() {
  try {
    state.notifications = await api('/api/notifications');
    renderNotifications();
  } catch {}
}

async function loadLogs() {
  try {
    state.logs = await api('/api/logs?limit=200');
    renderLogs();
  } catch {}
}

async function loadSettings() {
  try {
    const settings = await api('/api/settings');
    const form = document.getElementById('settings-form');
    state.supportedSettings = new Set(Object.keys(settings.values || {}));
    for (const [key, value] of Object.entries(settings.values)) {
      const field = form.elements.namedItem(key);
      if (!field) continue;
      if (field.type === 'checkbox') field.checked = String(value).toLowerCase() === 'true';
      else field.value = value;
    }
    for (const [key, configured] of Object.entries(settings.configured)) {
      const badge = document.getElementById(`configured-${key}`);
      if (badge) {
        badge.textContent = configured ? '已配置' : '未配置';
        badge.classList.toggle('is-missing', !configured);
      }
      const field = form.elements.namedItem(key);
      if (field?.type === 'password') field.placeholder = configured
        ? '已配置，留空不修改'
        : key === 'EAMS_PASSWORD' ? '首次使用请输入密码' : '未配置，填写后保存';
    }
    state.settingsConfigured = settings.configured || {};
    const visionModelField = form.elements.namedItem('VISION_MODEL');
    if (visionModelField) visionModelField.disabled = !state.supportedSettings.has('VISION_MODEL');
    state.setup = settings.setup || state.setup;
    renderSetupGuide(state.setup);
    state.settingsLoaded = true;
  } catch (error) {
    showToast('设置读取失败', error.message, true);
  }
}

function collectSettings(form) {
  const settings = {};
  for (const field of form.elements) {
    if (!field.name || field.disabled) continue;
    settings[field.name] = field.type === 'checkbox' ? String(field.checked) : field.value;
  }
  return settings;
}

function validateSettingsForm(form) {
  if (!form.checkValidity()) {
    form.reportValidity();
    throw new Error('请检查超出允许范围或格式不正确的配置项。');
  }
  const username = form.elements.namedItem('EAMS_USERNAME');
  if (!username.value.trim()) {
    username.focus();
    throw new Error('请填写教务系统学号。');
  }
  const password = form.elements.namedItem('EAMS_PASSWORD');
  if (!password.value && !state.settingsConfigured.EAMS_PASSWORD) {
    password.focus();
    throw new Error('首次使用必须填写教务系统密码。');
  }
}

async function exportSettings() {
  if (!state.settingsLoaded) await loadSettings();
  const form = document.getElementById('settings-form');
  const settings = collectSettings(form);
  for (const key of SECRET_SETTING_NAMES) delete settings[key];
  const payload = {
    format: SETTINGS_EXPORT_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    secretsExcluded: [...SECRET_SETTING_NAMES],
    settings,
  };
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `tju-auto-grade-settings-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
  showToast('配置已导出', '密码、授权码和 API Key 均未包含，请在新设备上重新填写。');
}

async function openSettingsImport() {
  if (!state.settingsLoaded) await loadSettings();
  document.getElementById('settings-import-file').click();
}

async function importSettings(event) {
  const input = event.currentTarget;
  const file = input.files?.[0];
  if (!file) return;
  try {
    if (file.size > 100 * 1024) throw new Error('配置文件不能超过 100 KB');
    const payload = JSON.parse(await file.text());
    if (payload?.format !== SETTINGS_EXPORT_FORMAT || payload.version !== 1 || !payload.settings || Array.isArray(payload.settings)) {
      throw new Error('不是受支持的 TJU Auto Grade 配置文件');
    }
    const form = document.getElementById('settings-form');
    let imported = 0;
    for (const [key, value] of Object.entries(payload.settings)) {
      if (SECRET_SETTING_NAMES.has(key)) continue;
      const field = form.elements.namedItem(key);
      if (!field || typeof value === 'object') continue;
      if (field.type === 'checkbox') field.checked = String(value).toLowerCase() === 'true';
      else field.value = String(value ?? '');
      imported++;
    }
    showToast('配置已导入', `已载入 ${imported} 项非敏感配置；检查后请点击保存。`);
  } catch (error) {
    showToast('配置导入失败', error.message, true);
  } finally {
    input.value = '';
  }
}

function setConnectionLost() {
  for (const id of ['sidebar-status-dot', 'topbar-status-dot']) setStatusDot(document.getElementById(id), 'error');
  document.getElementById('sidebar-status-text').textContent = '控制台已断开';
  document.getElementById('topbar-status-text').textContent = '连接已断开';
  document.getElementById('overview-heading').textContent = '无法连接本机服务';
  document.getElementById('hero-description').textContent = '控制台服务可能已退出，请重新运行启动脚本。';
}

async function refreshAll() {
  if (state.polling) return;
  state.polling = true;
  await Promise.all([loadStatus(), loadGrades(), loadNotifications(), state.activeView === 'logs' ? loadLogs() : Promise.resolve()]);
  if (state.status?.phase === 'running' && (!state.semestersLoaded
    || Date.now() - state.semestersUpdatedAt >= SEMESTER_REFRESH_INTERVAL)) await loadSemesters();
  state.polling = false;
}

const actionConfig = {
  check: { path: '/api/actions/check', pending: '正在查询…', done: '查分完成', detail: '成绩快照和状态已经刷新。' },
  start: { path: '/api/actions/start', pending: '正在启动…', done: '监控正在启动', detail: '如果需要验证码，请查看弹出的 EAMS 浏览器。' },
  stop: { path: '/api/actions/stop', pending: '正在停止…', done: '监控已停止', detail: '控制台仍保持在线，可随时重新启动。' },
  restart: { path: '/api/actions/restart', pending: '正在重启…', done: '监控正在重启', detail: '浏览器和定时任务正在重新初始化。' },
  'retry-notifications': { path: '/api/actions/retry-notifications', pending: '正在重试…', done: '通知队列已处理', detail: '发送结果已更新。' },
  'test-email': { path: '/api/actions/test-email', pending: '正在发送…', done: '测试邮件已发送', detail: '请检查通知接收邮箱。' },
  weighted: { path: '/api/actions/weighted', pending: '正在查询…', done: '总加权查询完成', detail: '结果已显示在成绩中心。' },
};

async function runAction(action, button) {
  const config = actionConfig[action];
  if (!config) return;
  const originalText = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = config.pending;
  }
  try {
    const data = await api(config.path, { method: 'POST' });
    if (action === 'weighted') {
      renderWeighted(data);
      switchView('grades');
    }
    showToast(config.done, config.detail);
    await refreshAll();
  } catch (error) {
    showToast('操作未完成', error.message, true);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
    renderStatus();
  }
}

async function saveSettings(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('button[type="submit"]');
  try {
    validateSettingsForm(form);
  } catch (error) {
    showToast('配置尚未完成', error.message, true);
    return;
  }
  const settings = collectSettings(form);
  submit.disabled = true;
  submit.textContent = '正在保存…';
  try {
    const result = await api('/api/settings', { method: 'POST', body: { settings } });
    form.querySelectorAll('input[type="password"]').forEach(input => { input.value = ''; });
    state.settingsLoaded = false;
    await loadSettings();
    await refreshAll();
    showToast('设置已保存', result.setup?.complete ? '监控正在使用新配置启动。' : '请继续补全必填配置。');
  } catch (error) {
    showToast('保存失败', error.message, true);
  } finally {
    submit.disabled = false;
    submit.textContent = '保存并启动监控';
  }
}

function bindEvents() {
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => switchView(button.dataset.view)));
  document.querySelectorAll('[data-go-view]').forEach(button => button.addEventListener('click', () => switchView(button.dataset.goView)));
  document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => runAction(button.dataset.action, button)));
  document.getElementById('menu-button').addEventListener('click', openMobileMenu);
  document.getElementById('mobile-backdrop').addEventListener('click', closeMobileMenu);
  document.getElementById('grade-search').addEventListener('input', renderGrades);
  document.getElementById('semester-filter').addEventListener('change', renderGrades);
  document.getElementById('toggle-older-semesters').addEventListener('click', toggleOlderSemesters);
  document.getElementById('query-semester').addEventListener('click', querySemesterGrades);
  document.getElementById('show-current-grades').addEventListener('click', showCurrentGrades);
  document.getElementById('refresh-logs').addEventListener('click', loadLogs);
  document.getElementById('settings-form').addEventListener('submit', saveSettings);
  document.getElementById('export-settings').addEventListener('click', exportSettings);
  document.getElementById('import-settings').addEventListener('click', openSettingsImport);
  document.getElementById('settings-import-file').addEventListener('change', importSettings);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMobileMenu(); });
}

async function boot() {
  bindEvents();
  await loadStatus(true);
  await Promise.all([loadGrades(), loadNotifications()]);
  if (state.status?.setup && !state.status.setup.complete) {
    await loadSettings();
    switchView('settings');
    showToast('欢迎使用', '请先完成教务登录配置，保存后监控会自动启动。');
  }
  if (state.status?.phase === 'running') await loadSemesters();
  setInterval(refreshAll, 5000);
}

boot();
}

function startFileLauncher() {
  const target = 'http://127.0.0.1:3765/';
  document.body.innerHTML = `
    <main class="file-launcher">
      <section class="launcher-card" aria-labelledby="launcher-title">
        <div class="launcher-brand"><span>T</span>TJU Auto Grade</div>
        <div class="launcher-spinner" aria-hidden="true"></div>
        <p class="launcher-kicker">本机控制台</p>
        <h1 id="launcher-title">正在启动查分服务</h1>
        <p id="launcher-status">正在连接本机后台，请稍候…</p>
        <button class="button button-primary" id="launcher-retry" type="button">启动或重试</button>
        <small>首次使用时，Windows 可能询问是否打开 TJU Auto Grade，请选择允许。</small>
      </section>
    </main>`;

  const status = document.getElementById('launcher-status');
  const retry = document.getElementById('launcher-retry');
  let launching = false;

  async function isReady() {
    try {
      const response = await fetch(`${target}launcher-ready`, { cache: 'no-store' });
      if (response.ok) return true;
    } catch {}
    try {
      await fetch(target, { cache: 'no-store', mode: 'no-cors' });
      return true;
    } catch {
      return false;
    }
  }

  function invokeProtocol() {
    location.href = `tju-auto-grade://start?time=${Date.now()}`;
  }

  async function launch() {
    if (launching) return;
    launching = true;
    retry.disabled = true;
    if (await isReady()) {
      location.replace(target);
      return;
    }

    status.textContent = '正在唤起本机服务…';
    invokeProtocol();
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
      if (await isReady()) {
        status.textContent = '启动成功，正在进入控制台…';
        location.replace(target);
        return;
      }
    }

    status.textContent = '尚未连接成功。请先运行“安装HTML启动支持.bat”，然后点击重试。';
    retry.disabled = false;
    launching = false;
  }

  retry.addEventListener('click', launch);
  launch();
}

if (location.protocol === 'file:') startFileLauncher();
else startDashboardClient();
