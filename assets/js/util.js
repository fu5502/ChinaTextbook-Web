/* ============================================================
   util.js — DOM 助手 / 格式化 / 路径编码 / 节流防抖
   ============================================================ */

/** 创建元素：h('div.cls#id', {attr}, children) */
export function h(sel, props, ...children) {
  const [tagPart, ...idParts] = sel.split('#');
  const [tag, ...classes] = tagPart.split('.');
  const el = document.createElement(tag || 'div');
  if (idParts.length) el.id = idParts[0];
  if (classes.length) el.className = classes.join(' ');

  if (props && (typeof props !== 'object' || Array.isArray(props) || props instanceof Node)) {
    children.unshift(props);
    props = null;
  }
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = el.className ? `${el.className} ${v}` : v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k in el && k !== 'list' && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** 内联 SVG 图标（24x24 stroke 风格） */
export function icon(paths, cls = 'ico', size) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  if (size) {
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
  }
  svg.innerHTML = paths;
  return svg;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/* ---------------- 格式化 ---------------- */

export function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

export function fmtNum(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function fmtTimeAgo(ts) {
  const d = Date.now() - ts;
  if (d < 60e3) return '刚刚';
  if (d < 3600e3) return `${Math.floor(d / 60e3)} 分钟前`;
  if (d < 86400e3) return `${Math.floor(d / 3600e3)} 小时前`;
  if (d < 7 * 86400e3) return `${Math.floor(d / 86400e3)} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

/* ---------------- 路径 / URL ---------------- */

/** 中文路径逐段编码：'小学/语文/a b.pdf' → '%E5%B0%8F.../a%20b.pdf' */
export function encPath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

/** HTML 转义 */
export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 高亮关键词，返回 HTML 字符串（已转义） */
export function highlight(text, terms) {
  const s = esc(text);
  if (!terms || !terms.length) return s;
  const safe = terms
    .filter(Boolean)
    .map((t) => esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length);
  if (!safe.length) return s;
  return s.replace(new RegExp(`(${safe.join('|')})`, 'gi'), '<mark>$1</mark>');
}

/* ---------------- 时序 ---------------- */

export function debounce(fn, ms = 150) {
  let t;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  wrapped.flush = (...args) => {
    clearTimeout(t);
    fn(...args);
  };
  return wrapped;
}

export function throttle(fn, ms = 100) {
  let last = 0;
  let timer = null;
  return (...args) => {
    const now = Date.now();
    const wait = ms - (now - last);
    if (wait <= 0) {
      clearTimeout(timer);
      timer = null;
      last = now;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        last = Date.now();
        timer = null;
        fn(...args);
      }, wait);
    }
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 带超时的 fetch */
export async function fetchWithTimeout(url, opts = {}, ms = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), ms);
  const signal = opts.signal
    ? AbortSignal.any
      ? AbortSignal.any([opts.signal, ctrl.signal])
      : ctrl.signal
    : ctrl.signal;
  try {
    return await fetch(url, { ...opts, signal });
  } finally {
    clearTimeout(t);
  }
}

/* ---------------- 顶栏进度 ---------------- */

let progEl = null;
let progVal = 0;
let progTimer = null;

export const topProgress = {
  start() {
    progEl ||= document.querySelector('#top-progress > i');
    if (!progEl) return;
    progVal = 8;
    progEl.style.opacity = '1';
    progEl.style.width = '8%';
    clearInterval(progTimer);
    progTimer = setInterval(() => {
      progVal += Math.max(0.4, (88 - progVal) * 0.06);
      progEl.style.width = `${Math.min(progVal, 88)}%`;
    }, 180);
  },
  set(pct) {
    progEl ||= document.querySelector('#top-progress > i');
    if (!progEl) return;
    clearInterval(progTimer);
    progVal = pct;
    progEl.style.opacity = '1';
    progEl.style.width = `${pct}%`;
  },
  done() {
    if (!progEl) return;
    clearInterval(progTimer);
    progEl.style.width = '100%';
    setTimeout(() => {
      progEl.style.opacity = '0';
      setTimeout(() => {
        if (progEl.style.opacity === '0') progEl.style.width = '0';
      }, 320);
    }, 160);
  },
};

/* ---------------- 杂项 ---------------- */

/** 在滚动容器内定位并可见 */
export function scrollIntoViewIfNeeded(el, container) {
  if (!el || !container) return;
  const er = el.getBoundingClientRect();
  const cr = container.getBoundingClientRect();
  if (er.top < cr.top) container.scrollTop -= cr.top - er.top + 8;
  else if (er.bottom > cr.bottom) container.scrollTop += er.bottom - cr.bottom + 8;
}

export function onClickOutside(el, cb) {
  const handler = (e) => {
    if (!el.contains(e.target)) cb(e);
  };
  document.addEventListener('pointerdown', handler, true);
  return () => document.removeEventListener('pointerdown', handler, true);
}

/** 触发浏览器下载 */
export function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  if (filename) a.download = filename;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
}
