/* ============================================================
   router.js — hash 路由
   #/                                首页
   #/browse?stage=小学&subject=数学     浏览
   #/search?q=xxx                    搜索
   #/book/<id>                       详情
   #/read/<id>?p=25                  阅读器
   #/favorites                       收藏
   ============================================================ */

const routes = new Map();
let notFoundHandler = null;
let current = null;
let beforeEach = null;

export function register(name, handler) {
  routes.set(name, handler);
}
export function setNotFound(fn) {
  notFoundHandler = fn;
}
export function onBeforeEach(fn) {
  beforeEach = fn;
}

/** 解析 hash → { name, parts, query, raw } */
export function parse(hash = location.hash) {
  let s = hash.replace(/^#/, '');
  if (!s || s === '/') return { name: 'home', parts: [], query: {}, raw: '#/' };
  if (s[0] !== '/') s = `/${s}`;

  const qi = s.indexOf('?');
  const pathPart = qi < 0 ? s : s.slice(0, qi);
  const queryPart = qi < 0 ? '' : s.slice(qi + 1);

  const parts = pathPart.split('/').filter(Boolean).map(safeDecode);
  const query = {};
  if (queryPart) {
    for (const [k, v] of new URLSearchParams(queryPart)) query[k] = v;
  }
  return { name: parts[0] || 'home', parts: parts.slice(1), query, raw: hash };
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 生成 hash：build('browse', {stage:'小学'}) → '#/browse?stage=%E5%B0%8F%E5%AD%A6' */
export function build(name, query = {}, ...parts) {
  let s = `#/${name}`;
  for (const p of parts) if (p != null && p !== '') s += `/${encodeURIComponent(p)}`;
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v == null || v === '' || v === false) continue;
    usp.set(k, v);
  }
  const q = usp.toString();
  return q ? `${s}?${q}` : s;
}

export function go(hash, replace = false) {
  if (location.hash === hash) return;
  if (replace) history.replaceState(null, '', hash || '#/');
  else location.hash = hash;
  if (replace) dispatch();
}

/** 只改 query 不产生新历史记录（筛选器高频变更用） */
export function replaceQuery(name, query, ...parts) {
  const hash = build(name, query, ...parts);
  if (location.hash === hash) return;
  history.replaceState(null, '', hash);
  current = parse(hash);
}

export function getCurrent() {
  return current;
}

let dispatching = false;

export function dispatch() {
  if (dispatching) return;
  dispatching = true;
  try {
    const route = parse();
    const prev = current;
    current = route;
    if (beforeEach) beforeEach(route, prev);
    const handler = routes.get(route.name);
    if (handler) handler(route, prev);
    else if (notFoundHandler) notFoundHandler(route, prev);
  } catch (e) {
    console.error('[router]', e);
    if (notFoundHandler) notFoundHandler(parse(), current, e);
  } finally {
    dispatching = false;
  }
}

export function start() {
  window.addEventListener('hashchange', dispatch);
  if (!location.hash) history.replaceState(null, '', '#/');
  dispatch();
}
