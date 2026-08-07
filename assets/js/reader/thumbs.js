/* ============================================================
   thumbs.js — 页面缩略图侧栏
   ------------------------------------------------------------
   自己实现而不用 PDFThumbnailViewer：后者没有在 pdf_viewer.mjs 里导出。
   IntersectionObserver 懒渲染，滚出视野即释放 canvas，避免上千页爆内存。
   ============================================================ */

import { h } from '../util.js';

const THUMB_W = 116;
const KEEP = 40; // 最多保留多少张已渲染的缩略图

export function createThumbs(host, pdf, { onJump }) {
  host.replaceChildren();

  const total = pdf.numPages;
  const items = [];
  const rendered = []; // 渲染顺序，用于 LRU 释放
  const tasks = new Map();
  let current = 1;
  let destroyed = false;

  const list = h('div.th-list');

  for (let i = 1; i <= total; i++) {
    const box = h('div.th-box', { style: { aspectRatio: '1 / 1.414' } });
    const item = h(
      'button.th-item',
      { type: 'button', 'data-page': String(i), title: `第 ${i} 页` },
      box,
      h('span.th-num', String(i))
    );
    item.addEventListener('click', () => onJump?.(i));
    list.append(item);
    items.push({ el: item, box, page: i, done: false });
  }
  host.append(list);

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const idx = Number(e.target.dataset.page) - 1;
        const it = items[idx];
        if (!it) continue;
        if (e.isIntersecting) draw(it);
      }
    },
    { root: host, rootMargin: '320px 0px' }
  );
  for (const it of items) io.observe(it.el);

  async function draw(it) {
    if (destroyed || it.done || tasks.has(it.page)) return;
    tasks.set(it.page, true);
    try {
      const page = await pdf.getPage(it.page);
      if (destroyed) return;
      const base = page.getViewport({ scale: 1 });
      const scale = (THUMB_W * (window.devicePixelRatio || 1)) / base.width;
      const vp = page.getViewport({ scale });

      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(vp.width));
      canvas.height = Math.max(1, Math.round(vp.height));
      canvas.className = 'th-canvas';

      const task = page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport: vp });
      await task.promise;
      if (destroyed) return;

      it.box.replaceChildren(canvas);
      it.box.style.aspectRatio = `${vp.width} / ${vp.height}`;
      it.done = true;
      rendered.push(it);
      page.cleanup();
      evict();
    } catch (e) {
      if (!destroyed) console.warn('[thumbs] 第', it.page, '页渲染失败', e);
    } finally {
      tasks.delete(it.page);
    }
  }

  function evict() {
    while (rendered.length > KEEP) {
      const old = rendered.shift();
      if (!old || old.page === current) continue;
      // 仍在视野内的不回收
      const r = old.el.getBoundingClientRect();
      const hr = host.getBoundingClientRect();
      if (r.bottom > hr.top - 400 && r.top < hr.bottom + 400) {
        rendered.push(old);
        if (rendered.length > KEEP * 2) break;
        continue;
      }
      old.box.replaceChildren();
      old.done = false;
    }
  }

  function setCurrent(n) {
    if (n === current) return;
    items[current - 1]?.el.classList.remove('active');
    current = n;
    const it = items[n - 1];
    if (!it) return;
    it.el.classList.add('active');
    draw(it);
    // 只在缩略图栏可见时才滚动，避免隐藏时白费力气
    if (host.offsetParent !== null) {
      const r = it.el.getBoundingClientRect();
      const hr = host.getBoundingClientRect();
      if (r.top < hr.top || r.bottom > hr.bottom) {
        it.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  }

  function destroy() {
    destroyed = true;
    io.disconnect();
    for (const it of items) it.box.replaceChildren();
    items.length = 0;
    rendered.length = 0;
    host.replaceChildren();
  }

  items[0]?.el.classList.add('active');
  return { setCurrent, destroy };
}
