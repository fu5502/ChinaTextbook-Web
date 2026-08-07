/* ============================================================
   storage.js — localStorage 封装（免登录的全部个人数据）
   隐私模式下 localStorage 可能抛异常，一律 try/catch 兜底
   ============================================================ */

const K = {
  fav: 'tb:favorites',
  recent: 'tb:recent',
  progress: 'tb:progress',
  prefs: 'tb:prefs',
  probe: 'tb:probe',
};

const MAX_RECENT = 24;

let available = true;
try {
  const t = '__tb_test__';
  localStorage.setItem(t, '1');
  localStorage.removeItem(t);
} catch {
  available = false;
}

/** 内存兜底，保证功能在隐私模式下不崩（仅当次会话有效） */
const mem = new Map();

function read(key, fallback) {
  try {
    const raw = available ? localStorage.getItem(key) : mem.get(key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function write(key, val) {
  const raw = JSON.stringify(val);
  try {
    if (available) localStorage.setItem(key, raw);
    else mem.set(key, raw);
  } catch {
    // 配额满：先尝试清掉体积最大的进度记录再写一次
    try {
      localStorage.removeItem(K.progress);
      localStorage.setItem(key, raw);
    } catch {
      available = false;
      mem.set(key, raw);
    }
  }
}

/* ---------------- 收藏 ---------------- */

export const favorites = {
  all() {
    const v = read(K.fav, []);
    return Array.isArray(v) ? v : [];
  },
  has(id) {
    return this.all().includes(id);
  },
  toggle(id) {
    const list = this.all();
    const i = list.indexOf(id);
    if (i >= 0) list.splice(i, 1);
    else list.unshift(id);
    write(K.fav, list);
    emit();
    return i < 0; // true = 已加入
  },
  remove(id) {
    const list = this.all().filter((x) => x !== id);
    write(K.fav, list);
    emit();
  },
  clear() {
    write(K.fav, []);
    emit();
  },
};

/* ---------------- 最近在读 ---------------- */

export const recent = {
  all() {
    const v = read(K.recent, []);
    return Array.isArray(v) ? v.filter((x) => x && x.id) : [];
  },
  touch(id, page = 1, pages = 0) {
    const list = this.all().filter((x) => x.id !== id);
    list.unshift({ id, page, pages, at: Date.now() });
    write(K.recent, list.slice(0, MAX_RECENT));
    emit();
  },
  remove(id) {
    write(K.recent, this.all().filter((x) => x.id !== id));
    emit();
  },
  clear() {
    write(K.recent, []);
    emit();
  },
};

/* ---------------- 阅读进度 ---------------- */

export const progress = {
  all() {
    return read(K.progress, {}) || {};
  },
  get(id) {
    return this.all()[id] || null;
  },
  set(id, data) {
    const all = this.all();
    all[id] = { ...(all[id] || {}), ...data, at: Date.now() };
    // 上限保护：超过 300 条时按时间淘汰最旧的
    const keys = Object.keys(all);
    if (keys.length > 300) {
      keys
        .sort((a, b) => (all[a].at || 0) - (all[b].at || 0))
        .slice(0, keys.length - 300)
        .forEach((k) => delete all[k]);
    }
    write(K.progress, all);
  },
  clear() {
    write(K.progress, {});
  },
};

/* ---------------- 偏好 ---------------- */

const DEFAULT_PREFS = {
  source: 'auto',
  customSource: '',
  scrollMode: 0, // 0=竖向连续 1=横向 2=wrapped 3=单页
  spreadMode: 0,
  sidebarOpen: true,
  night: false,
  viewMode: 'grid',
  askResume: true,
};

export const prefs = {
  all() {
    return { ...DEFAULT_PREFS, ...(read(K.prefs, {}) || {}) };
  },
  get(k) {
    return this.all()[k];
  },
  set(k, v) {
    const p = this.all();
    p[k] = v;
    write(K.prefs, p);
    emit();
  },
  merge(obj) {
    write(K.prefs, { ...this.all(), ...obj });
    emit();
  },
};

/* ---------------- 线路测速缓存 ---------------- */

const PROBE_TTL = 24 * 3600 * 1000;

export const probeCache = {
  get() {
    const v = read(K.probe, null);
    if (!v || !v.ts || Date.now() - v.ts > PROBE_TTL) return null;
    return v.data || null;
  },
  set(data) {
    write(K.probe, { ts: Date.now(), data });
  },
  clear() {
    write(K.probe, { ts: 0, data: null });
  },
};

/* ---------------- 变更广播 ---------------- */

const listeners = new Set();
function emit() {
  for (const fn of listeners) {
    try {
      fn();
    } catch (e) {
      console.error(e);
    }
  }
}
export function onStorageChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 是否处于「不可持久化」状态（用于给用户提示） */
export const isPersistent = () => available;

/** 一键清空全部本地数据 */
export function clearAll() {
  for (const k of Object.values(K)) {
    try {
      localStorage.removeItem(k);
    } catch {}
    mem.delete(k);
  }
  emit();
}
