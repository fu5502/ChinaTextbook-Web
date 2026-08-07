/* ============================================================
   sources.js — 线路表、URL 构造、探测测速、failover
   ------------------------------------------------------------
   实测结论（决定了这里的设计）：
   · jsDelivr 三条线暴露 CORS 头，但 >20MB 硬性 403 —— 538 本书用不了
   · ghproxy / ghfast / gh-proxy 支持 206 但不暴露 Accept-Ranges
     → 因此不能依赖 pdf.js 默认的 PDFFetchStream，必须用自定义传输层
       （只读响应体，不读响应头）。见 reader/transport.js
   ============================================================ */

import { encPath } from './util.js';
import { prefs, probeCache } from './storage.js';

export const REPO = 'TapXWorld/ChinaTextbook';
export const REF = 'master';

const JSDELIVR_MAX = 20 * 1024 * 1024;

const rawUrl = (p) => `https://raw.githubusercontent.com/${REPO}/${REF}/${encPath(p)}`;

export const SOURCES = [
  {
    id: 'jsdelivr',
    name: 'jsDelivr',
    note: '全球 CDN · 限 20MB',
    maxSize: JSDELIVR_MAX,
    build: (p) => `https://cdn.jsdelivr.net/gh/${REPO}@${REF}/${encPath(p)}`,
  },
  {
    id: 'fastly',
    name: 'jsDelivr · Fastly',
    note: '备用 CDN · 限 20MB',
    maxSize: JSDELIVR_MAX,
    build: (p) => `https://fastly.jsdelivr.net/gh/${REPO}@${REF}/${encPath(p)}`,
  },
  {
    id: 'gcore',
    name: 'jsDelivr · Gcore',
    note: '备用 CDN · 限 20MB',
    maxSize: JSDELIVR_MAX,
    build: (p) => `https://gcore.jsdelivr.net/gh/${REPO}@${REF}/${encPath(p)}`,
  },
  {
    id: 'ghproxy',
    name: 'ghproxy.net',
    note: '代理 · 支持大文件',
    maxSize: Infinity,
    build: (p) => `https://ghproxy.net/${rawUrl(p)}`,
  },
  {
    id: 'ghfast',
    name: 'ghfast.top',
    note: '代理 · 支持大文件',
    maxSize: Infinity,
    build: (p) => `https://ghfast.top/${rawUrl(p)}`,
  },
  {
    id: 'ghproxycom',
    name: 'gh-proxy.com',
    note: '代理 · 支持大文件',
    maxSize: Infinity,
    build: (p) => `https://gh-proxy.com/${rawUrl(p)}`,
  },
  {
    id: 'raw',
    name: 'GitHub 源站',
    note: '境内多数网络不可达',
    maxSize: Infinity,
    build: rawUrl,
  },
];

export const CUSTOM_ID = 'custom';

/** 自定义线路：用户填写前缀，如 https://my.proxy/https://raw.githubusercontent.com/ */
export function customSource() {
  const prefix = (prefs.get('customSource') || '').trim();
  if (!prefix) return null;
  return {
    id: CUSTOM_ID,
    name: '自定义线路',
    note: prefix.length > 40 ? `${prefix.slice(0, 40)}…` : prefix,
    maxSize: Infinity,
    custom: true,
    build: (p) => {
      const base = prefix.endsWith('/') ? prefix : `${prefix}/`;
      // 前缀里若已含 raw.githubusercontent.com，视作「代理 + 完整 URL」模式
      return /raw\.githubusercontent\.com|\/gh\//i.test(base)
        ? base + encPath(p)
        : base + rawUrl(p);
    },
  };
}

export function allSources() {
  const c = customSource();
  return c ? [...SOURCES, c] : SOURCES;
}

export const getSource = (id) => allSources().find((s) => s.id === id) || null;

/* ------------------------------------------------------------------ *
 * 线路排序：体积过滤 + 测速结果 + 用户偏好
 * ------------------------------------------------------------------ */

/**
 * 为某个体积的文件返回可用线路（已按优先级排序）
 * @param {number} size 字节数；0 表示不限制
 */
export function sourcesFor(size = 0) {
  const pinned = prefs.get('source');
  const speeds = probeCache.get() || {};

  let list = allSources().filter((s) => !size || size <= s.maxSize);
  if (!list.length) list = allSources().filter((s) => s.maxSize === Infinity);

  list = [...list].sort((a, b) => {
    const sa = speeds[a.id];
    const sb = speeds[b.id];
    // 测过速的排前面，按耗时升序；未测的按声明顺序
    if (sa != null && sb != null) return sa - sb;
    if (sa != null) return -1;
    if (sb != null) return 1;
    return SOURCES.findIndex((s) => s.id === a.id) - SOURCES.findIndex((s) => s.id === b.id);
  });

  // 用户手动锁定的线路提到最前（若体积允许）
  if (pinned && pinned !== 'auto') {
    const i = list.findIndex((s) => s.id === pinned);
    if (i > 0) list.unshift(list.splice(i, 1)[0]);
  }
  return list;
}

/** 单个文件在指定线路上的 URL */
export function urlFor(path, sourceId, size = 0) {
  const s = getSource(sourceId) || sourcesFor(size)[0];
  return s ? s.build(path) : rawUrl(path);
}

/* ------------------------------------------------------------------ *
 * 测速探测
 * ------------------------------------------------------------------ */

// 一个小文件（README），各线路都能取到，用于比较 TTFB
const PROBE_PATH = 'README.md';
const PROBE_TIMEOUT = 6000;

async function probeOne(src) {
  const url = src.build(PROBE_PATH);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT);
  const t0 = performance.now();
  try {
    const r = await fetch(url, {
      headers: { Range: 'bytes=0-0' },
      signal: ctrl.signal,
      cache: 'no-store',
    });
    if (!r.ok && r.status !== 206) throw new Error(String(r.status));
    await r.arrayBuffer();
    return Math.round(performance.now() - t0);
  } finally {
    clearTimeout(timer);
  }
}

let probing = null;

/**
 * 并发探测全部线路，结果写入缓存（24h）
 * @returns {Promise<Object<string, number>>} { sourceId: ms }
 */
export function probeAll(force = false) {
  if (!force) {
    const cached = probeCache.get();
    if (cached) return Promise.resolve(cached);
  }
  if (probing) return probing;

  probing = Promise.all(
    allSources().map((s) =>
      probeOne(s)
        .then((ms) => [s.id, ms])
        .catch(() => [s.id, null])
    )
  )
    .then((pairs) => {
      const out = {};
      for (const [id, ms] of pairs) if (ms != null) out[id] = ms;
      probeCache.set(out);
      notify(out);
      return out;
    })
    .finally(() => {
      probing = null;
    });

  return probing;
}

export function cachedSpeeds() {
  return probeCache.get() || {};
}

/** 当前自动模式下的首选线路名（用于顶栏展示） */
export function currentSourceLabel() {
  const pinned = prefs.get('source');
  if (pinned && pinned !== 'auto') {
    const s = getSource(pinned);
    if (s) return s.name;
  }
  const speeds = probeCache.get();
  if (speeds) {
    const best = Object.entries(speeds).sort((a, b) => a[1] - b[1])[0];
    if (best) {
      const s = getSource(best[0]);
      if (s) return `自动 · ${s.name}`;
    }
  }
  return '自动选路';
}

const listeners = new Set();
export function onSourcesChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function notify(data) {
  for (const fn of listeners) {
    try {
      fn(data);
    } catch (e) {
      console.error(e);
    }
  }
}
export const notifySourcesChanged = () => notify(probeCache.get() || {});
