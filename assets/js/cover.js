/* ============================================================
   cover.js — 书卡封面缩图引擎
   ------------------------------------------------------------
   思路：复用阅读器的 pdf.js 通道（loadPdfjs + createTransport）
   只渲染每本教材 PDF 的「第 1 页」作为封面缩图，缓存到 IndexedDB，
   避免一次性下载 1900+ 本整包。

   · 真实缩图：渲染 PDF 首页（按需 Range，只取首页所需字节）
   · CSS 兜底封面：加载中 / 失败时显示学科主题色封面，绝不空白
   · 懒加载：IntersectionObserver + 并发队列，仅渲染进入视口的卡
   · 缓存：会话内存 + IndexedDB（按 path@size 失效）
   · 关闭开关：window.__NO_COVER__ = true 时直接走兜底，不发网络
   ============================================================ */

import { loadPdfjs, docParams } from './reader/loader.js';
import { createTransport } from './reader/transport.js';

const COVER_W = 300; // 渲染逻辑宽度（px），再乘 DPR 提升清晰度
const MAX_DPR = 2;
const MAX_ACTIVE = 3; // 同时渲染的封面数
const IDB_NAME = 'tb-covers';
const IDB_STORE = 'covers';
const TTL = 30 * 24 * 3600 * 1000; // 30 天

/* ---------------- 开关 ---------------- */
export function coverEnabled() {
  return !window.__NO_COVER__ && localStorage.getItem('tb:covers') !== 'off';
}

/* ---------------- IndexedDB（可选） ---------------- */
let idbPromise = null;
function openDB() {
  if (idbPromise) return idbPromise;
  idbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return idbPromise;
}
async function idbGet(id) {
  const db = await openDB();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const r = tx.objectStore(IDB_STORE).get(id);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}
async function idbPut(id, val) {
  const db = await openDB();
  if (!db) return;
  try {
    await new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(val, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    /* 配额满则忽略 */
  }
}

/* ---------------- 缓存 ---------------- */
const mem = new Map(); // id -> dataURL（会话内，避免重复渲染）

function etagOf(book) {
  return `${book.path}@${book.size}`;
}
function cacheKeyOf(book, page = 1) {
  return `${book.id}@p${page}`;
}

/* ---------------- 渲染单本首页 ---------------- */
async function renderCover(book, page = 1) {
  const { lib } = await loadPdfjs();
  let transport = null;
  let pdf = null;
  try {
    transport = await createTransport(book, {});
    const loadingTask = lib.getDocument(docParams({ range: transport }));
    pdf = await loadingTask.promise;
    const pg = await pdf.getPage(page);
    const base = pg.getViewport({ scale: 1 });
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const scale = Math.max(0.2, (COVER_W * dpr) / base.width);
    const vp = pg.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(vp.width));
    canvas.height = Math.max(1, Math.round(vp.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await pg.render({ canvasContext: ctx, viewport: vp, intent: 'default' }).promise;

    const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
    try {
      await pdf.destroy();
    } catch {
      /* noop */
    }
    transport.abort();
    return { dataUrl, w: canvas.width, h: canvas.height };
  } catch (err) {
    try {
      transport?.abort();
    } catch {
      /* noop */
    }
    try {
      pdf?.destroy();
    } catch {
      /* noop */
    }
    console.warn('[cover] 渲染失败', book.id, err?.message || err);
    return null;
  }
}

/* ---------------- 调度（按 book 去重 + 并发） ---------------- */
const byId = new Map(); // id -> entry { book, els:Set, status, url }
const elEntry = new Map(); // element -> entry
let active = 0;
const queue = [];

function entryFor(book, page = 1) {
  const key = book.id + '#p' + page;
  let e = byId.get(key);
  if (!e) {
    e = { book, page, els: new Set(), status: 'idle', url: null };
    byId.set(key, e);
  }
  return e;
}

const io =
  typeof IntersectionObserver !== 'undefined'
    ? new IntersectionObserver(
        (entries) => {
          for (const en of entries) {
            if (!en.isIntersecting) continue;
            const e = elEntry.get(en.target);
            if (e) {
              io.unobserve(en.target);
              start(e);
            }
          }
        },
        { rootMargin: '300px' }
      )
    : null;

function start(e) {
  if (e.status !== 'idle') return;
  e.status = 'loading';
  queue.push(e);
  pump();
}

function pump() {
  while (active < MAX_ACTIVE && queue.length) {
    const e = queue.shift();
    active++;
    runOne(e).finally(() => {
      active--;
      pump();
    });
  }
}

async function runOne(e) {
  if (!coverEnabled()) {
    failAll(e);
    return;
  }
  const key = cacheKeyOf(e.book, e.page);
  // 会话内存命中
  const cached = mem.get(key);
  if (cached) {
    e.url = cached;
    e.status = 'done';
    paintAll(e, cached);
    return;
  }
  // IDB 命中（校验失效标记）
  const rec = await idbGet(key);
  if (rec && rec.etag === etagOf(e.book) && Date.now() - (rec.at || 0) < TTL && rec.dataUrl) {
    mem.set(key, rec.dataUrl);
    e.url = rec.dataUrl;
    e.status = 'done';
    paintAll(e, rec.dataUrl);
    return;
  }
  const res = await renderCover(e.book, e.page);
  if (!coverEnabled()) {
    failAll(e);
    return;
  }
  if (res) {
    mem.set(key, res.dataUrl);
    e.url = res.dataUrl;
    e.status = 'done';
    idbPut(key, { etag: etagOf(e.book), at: Date.now(), w: res.w, h: res.h, dataUrl: res.dataUrl });
    paintAll(e, res.dataUrl);
  } else {
    e.status = 'fail';
    failAll(e);
  }
}

function paintAll(e, dataUrl) {
  for (const el of e.els) paint(el, dataUrl);
}
function failAll(e) {
  for (const el of e.els) markFailed(el);
}

function paint(el, dataUrl) {
  const img = el.querySelector('.bc-cover-img');
  if (!img) return;
  img.onload = () => {
    el.classList.add('loaded');
    img.classList.add('loaded');
  };
  img.onerror = () => markFailed(el);
  img.src = dataUrl;
  el.classList.remove('loading', 'failed');
}

function markFailed(el) {
  el.classList.remove('loading');
  el.classList.add('failed');
}

/* ---------------- 对外 API ---------------- */

/**
 * 为书卡封面区登记懒加载。
 * @param {HTMLElement} el 带 .bc-cover 的容器（class 为 .bc-cover）
 * @param {object} book 书目对象
 */
export function registerCover(el, book) {
  if (!el) return;
  const page = coverPageOf(book);
  if (!coverEnabled()) {
    markFailed(el);
    return;
  }
  const e = entryFor(book, page);
  e.els.add(el);
  elEntry.set(el, e);

  // 本会话已渲染过 → 立即补上，不走观察
  if (e.status === 'done' && e.url) {
    paint(el, e.url);
    return;
  }
  if (e.status === 'fail') {
    markFailed(el);
    return;
  }
  if (io) io.observe(el);
  else start(e); // 无 IO 支持则直接渲染
}

/** 路由切换时清理观察器与元素登记（保留会话缓存） */
export function coverReset() {
  if (io) io.disconnect();
  elEntry.clear();
  for (const e of byId.values()) {
    e.els.clear();
    // 已完成的保留缓存；进行中的回到 idle 以便下次重新触发
    if (e.status === 'loading') e.status = 'idle';
  }
  queue.length = 0;
  active = 0;
}

/* ---------------- 封面页覆盖（指定某页当封面） ---------------- */
const coverPageKey = (id) => `tb:coverPage:${id}`;

/** 该教材当前用作封面的页码（默认第 1 页） */
export function coverPageOf(book) {
  try {
    const v = Number(localStorage.getItem(coverPageKey(book.id)));
    return v >= 1 ? v : 1;
  } catch {
    return 1;
  }
}

/** 把某页设为该教材封面（持久化到 localStorage） */
export function setCoverPage(book, page) {
  try {
    localStorage.setItem(coverPageKey(book.id), String(page));
  } catch {
    /* 隐私模式忽略 */
  }
}

/**
 * 渲染任意页为 JPEG dataURL（带会话内存 + IndexedDB 缓存，key 含页码）。
 * 供详情页「教材预览」幻灯片复用，避免重复下载渲染。
 */
export async function renderPageDataUrl(book, page = 1) {
  if (!coverEnabled()) return null;
  const key = cacheKeyOf(book, page);
  if (mem.has(key)) return mem.get(key);
  const rec = await idbGet(key);
  if (rec && rec.etag === etagOf(book) && Date.now() - (rec.at || 0) < TTL && rec.dataUrl) {
    mem.set(key, rec.dataUrl);
    return rec.dataUrl;
  }
  const res = await renderCover(book, page);
  if (res) {
    mem.set(key, res.dataUrl);
    idbPut(key, { etag: etagOf(book), at: Date.now(), w: res.w, h: res.h, dataUrl: res.dataUrl });
    return res.dataUrl;
  }
  return null;
}

/** 取 PDF 总页数（供预览决定幻灯片张数） */
export async function getPageCount(book) {
  const { lib } = await loadPdfjs();
  let transport = null;
  let pdf = null;
  try {
    transport = await createTransport(book, {});
    pdf = await lib.getDocument(docParams({ range: transport })).promise;
    return pdf.numPages || 0;
  } catch (e) {
    console.warn('[cover] getPageCount 失败', book.id, e?.message || e);
    return 0;
  } finally {
    try {
      pdf?.destroy();
    } catch {}
    try {
      transport?.abort();
    } catch {}
  }
}

/** 用当前封面页刷新某个封面元素（「设为封面」后调用） */
export async function refreshCover(el, book) {
  if (!el) return;
  const url = await renderPageDataUrl(book, coverPageOf(book));
  if (url) paint(el, url);
  else markFailed(el);
}
