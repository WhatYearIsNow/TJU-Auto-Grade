/**
 * 极简 Cookie Jar：手动解析 Set-Cookie、按域存、按请求拼 Cookie 头。
 * Node 22 全局 fetch 不会跨请求自动管 cookie，也不会在手动跟随重定向时把我们存的 cookie 带上，
 * 所以这里自己实现。只覆盖 TJU 登录需要的子集。
 */
class CookieJar {
  constructor() {
    // store: Map<origin, Map<name, { value, path, expiresAt }>>
    this.store = new Map();
  }

  static originOf(url) {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  }

  /** 解析一个 Set-Cookie 头值，存入。 */
  setFromSetCookie(setCookieStr, requestUrl) {
    if (!setCookieStr) return;
    const u = new URL(requestUrl);
    const origin = `${u.protocol}//${u.host}`;
    // 第一条是 name=value，其余是属性
    const parts = setCookieStr.split(';').map(s => s.trim());
    const [name, value] = parts[0].split('=');
    if (!name) return;
    let path = '/';
    let expiresAt = Infinity;
    for (let i = 1; i < parts.length; i++) {
      const [k, v] = parts[i].split('=');
      const key = k.trim().toLowerCase();
      if (key === 'path') path = (v || '').trim() || '/';
      else if (key === 'expires') {
        const t = Date.parse((v || '').trim());
        if (!Number.isNaN(t)) expiresAt = t;
      } else if (key === 'max-age') {
        const sec = Number(v);
        if (Number.isFinite(sec)) expiresAt = Date.now() + sec * 1000;
      } else if (key === 'expires' && v === 'Thu, 01 Jan 1970') {
        expiresAt = 0;
      }
    }
    if (expiresAt <= Date.now()) {
      this.delete(origin, name, path);
      return;
    }
    if (!this.store.has(origin)) this.store.set(origin, new Map());
    this.store.get(origin).set(name, { value, path, expiresAt });
  }

  delete(origin, name, path) {
    const map = this.store.get(origin);
    if (!map) return;
    // 简单：直接按名删
    map.delete(name);
  }

  /** 给一个请求 URL 拼 Cookie 头。 */
  headersFor(requestUrl) {
    const u = new URL(requestUrl);
    const cookies = [];
    for (const [origin, map] of this.store) {
      const [op, ohost] = [origin.split('//')[0], origin.split('//')[1]];
      if (op !== u.protocol) continue;
      // 匹配 host 或父域（简单 endsWith）
      if (u.host !== ohost && !u.host.endsWith('.' + ohost.split(':')[0])) continue;
      for (const [name, entry] of map) {
        if (entry.expiresAt <= Date.now()) { map.delete(name); continue; }
        if (!u.pathname.startsWith(entry.path)) continue;
        cookies.push(`${name}=${entry.value}`);
      }
    }
    return cookies.length ? { Cookie: cookies.join('; ') } : {};
  }

  clear() { this.store.clear(); }

  /** 序列化为可落盘的数组 [{origin, name, value, path, expiresAt}] */
  toJSON() {
    const out = [];
    for (const [origin, map] of this.store) {
      for (const [name, entry] of map) {
        out.push({ origin, name, value: entry.value, path: entry.path, expiresAt: entry.expiresAt });
      }
    }
    return out;
  }

  /** 从持久化数组重建（跳过已过期条目） */
  load(data) {
    this.store.clear();
    if (!Array.isArray(data)) return;
    for (const item of data) {
      if (!item || !item.origin || !item.name) continue;
      if (Number.isFinite(item.expiresAt) && item.expiresAt <= Date.now()) continue;
      if (!this.store.has(item.origin)) this.store.set(item.origin, new Map());
      this.store.get(item.origin).set(item.name, {
        value: String(item.value ?? ''),
        path: item.path || '/',
        expiresAt: Number.isFinite(item.expiresAt) ? item.expiresAt : Infinity,
      });
    }
  }
}

module.exports = { CookieJar };
