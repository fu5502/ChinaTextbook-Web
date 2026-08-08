/* ============================================================
   preview.js — 教材「多页预览」与「全屏幻灯片」
   ------------------------------------------------------------
   · 两种形态，概念区分清楚：
     - 预览（compact）：详情页内联的教材预览，默认按 50% 比例缩放，
       仍是可自动/手动切换的轮播 + 可设为封面。
     - 全屏幻灯片（openPreviewFullscreen）：点击「全屏」弹出整屏大图轮播，
       详情页与阅读页共用，大图、自动/手动切换、可设为封面。
   · 复用 cover.js 的 renderPageDataUrl / getPageCount / coverPageOf / setCoverPage
   ============================================================ */

import { h, icon } from '../util.js';
import { renderPageDataUrl, getPageCount, coverPageOf, setCoverPage } from '../cover.js';
import { toast } from './toast.js';

const IC_PREV = '<path d="M15 6l-6 6 6 6"/>';
const IC_NEXT = '<path d="M9 6l6 6-6 6"/>';
const IC_PAUSE = '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/>';
const IC_PLAY = '<path d="M8 5v14l11-7z"/>';
const IC_COVER = '<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v18H6.5A2.5 2.5 0 0 0 4 22.5v-18z"/><path d="M4 17.5A2.5 2.5 0 0 1 6.5 15H20"/>';
const IC_FS = '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>';
const IC_X = '<path d="M6 6l12 12M18 6L6 18"/>';

const PREVIEW_MAX = 8; // 最多预览页数
const AUTOPLAY_MS = 4000; // 自动切换间隔

/** 所有存活的预览实例（含内联预览与全屏弹层），便于路由切换统一清理 */
const instances = new Set();

/** 路由切换时清理所有预览（计时器 / 监听 / 全屏弹层 DOM） */
export function destroyPreview() {
  for (const inst of [...instances]) {
    try {
      inst.destroy();
    } catch (e) {
      console.warn(e);
    }
  }
  instances.clear();
  // 兜底：清掉可能残留的全屏弹层 DOM
  document.querySelectorAll('.pv-fs').forEach((el) => el.remove());
  document.body.style.overflow = '';
}

/**
 * 构建教材预览幻灯片。
 * @param {object} book 书目对象
 * @param {object} [opts]
 *   - onSetCover(page)  设为封面后的回调（如刷新详情大封面）
 *   - compact(boolean)  内联紧凑模式，按 50% 比例缩放
 *   - inFullscreen(boolean) 已在全屏弹层内，不再渲染「全屏」按钮
 */
export function buildPreview(book, opts = {}) {
  const section = h('section.section.preview' + (opts.compact ? '.preview--compact' : ''));
  section.append(
    h('div.section-head', h('h2', '教材预览'), h('span.hint', '自动浏览 · 可手动切换 · 可设为封面'))
  );

  const track = h('div.pv-track');
  const viewport = h(
    'div.pv-viewport',
    track,
    h('button.pv-arrow.pv-prev', { type: 'button', 'aria-label': '上一页', title: '上一页' }, icon(IC_PREV, '', 18)),
    h('button.pv-arrow.pv-next', { type: 'button', 'aria-label': '下一页', title: '下一页' }, icon(IC_NEXT, '', 18))
  );
  section.append(viewport);

  const dotsWrap = h('div.pv-dots');
  const setCoverBtn = h(
    'button.btn.btn-sm.pv-setcover',
    { type: 'button' },
    icon(IC_COVER, '', 13),
    h('span.lbl', '设为封面')
  );
  const fsBtn = h(
    'button.btn.btn-sm.pv-fs-btn',
    { type: 'button', title: '全屏幻灯片' },
    icon(IC_FS, '', 13),
    h('span.lbl', '全屏')
  );
  const pauseBtn = h('button.pv-pause', { type: 'button', 'aria-label': '暂停自动播放', title: '暂停' }, icon(IC_PAUSE, '', 16));
  const bar = h('div.pv-bar', h('i'));
  section.append(h('div.pv-controls', dotsWrap, setCoverBtn, opts.inFullscreen ? null : fsBtn, pauseBtn), bar);

  const placeholder = h('div.pv-loading', '正在读取教材页数…');
  section.append(placeholder);

  const ctrl = createController(section, book, opts, { track, dotsWrap, setCoverBtn, fsBtn, pauseBtn, bar, placeholder });
  instances.add(ctrl);
  section._previewDestroy = () => {
    instances.delete(ctrl);
    ctrl.destroy();
  };
  ctrl.init();
  return section;
}

/**
 * 打开「全屏幻灯片」弹层（详情页 / 阅读页共用）。
 * 返回 { close, root }；若已存在则不再重复打开。
 * @param {object} book
 * @param {object} [opts] { onSetCover, onClose, night }
 */
export function openPreviewFullscreen(book, opts = {}) {
  const existing = document.querySelector('.pv-fs');
  if (existing) return null;

  const inner = buildPreview(book, { ...opts, compact: false, inFullscreen: true });

  const backdrop = h('div.pv-fs-backdrop', { onclick: () => close() });
  const x = h(
    'button.pv-fs-x',
    { type: 'button', 'aria-label': '关闭全屏幻灯片', title: '关闭 (Esc)' },
    icon(IC_X, 'ico', 22)
  );
  const card = h('div.pv-fs-card', backdrop, x, inner);
  const rootEl = h('div.pv-fs' + (opts.night || document.querySelector('.reader.night') ? '.night' : ''), card);
  document.body.append(rootEl);
  document.body.style.overflow = 'hidden';
  x.focus();

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    fsInstance.destroy();
    if (typeof opts.onClose === 'function') opts.onClose();
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowLeft') {
      inner.querySelector('.pv-prev')?.click();
    } else if (e.key === 'ArrowRight') {
      inner.querySelector('.pv-next')?.click();
    }
  }

  const fsInstance = {
    destroy() {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      inner._previewDestroy?.();
      rootEl.remove();
    },
  };
  document.addEventListener('keydown', onKey);
  instances.add(fsInstance);

  x.addEventListener('click', close);
  return { close, root: rootEl };
}

function createController(section, book, opts, refs) {
  const { track, dotsWrap, setCoverBtn, fsBtn, pauseBtn, bar, placeholder } = refs;
  const barFill = bar.querySelector('i');

  let pages = []; // 预览页号数组 [1,2,...]
  let index = 0;
  let playing = true;
  let elapsed = 0;
  let timer = null;
  let hovering = false;
  let hidden = document.hidden;
  let mounted = true;
  const offs = [];

  function stepPx() {
    const f = track.children[0];
    if (!f) return 0;
    const cs = getComputedStyle(track);
    const gap = parseFloat(cs.columnGap || cs.gap || '0') || 0;
    return f.getBoundingClientRect().width + gap;
  }
  function apply(animate) {
    track.style.transition = animate ? '' : 'none';
    track.style.transform = `translateX(${-index * stepPx()}px)`;
    if (!animate) {
      void track.offsetHeight;
      track.style.transition = '';
    }
    const dots = dotsWrap.children;
    for (let k = 0; k < dots.length; k++) dots[k].classList.toggle('on', k === index);
    updateSetCoverBtn();
  }
  function updateSetCoverBtn() {
    const cur = pages[index];
    const cov = coverPageOf(book);
    const isCov = cur != null && cur === cov;
    setCoverBtn.classList.toggle('on', isCov);
    setCoverBtn.title = isCov ? `当前已是封面（第 ${cur} 页）` : `将第 ${cur} 页设为封面`;
  }
  function go(i) {
    if (!pages.length) return;
    index = ((i % pages.length) + pages.length) % pages.length;
    apply(true);
    resetBar();
  }
  function next() {
    go(index + 1);
  }
  function prev() {
    go(index - 1);
  }
  function resetBar() {
    elapsed = 0;
    if (barFill) barFill.style.transform = 'scaleX(0)';
  }

  function tick() {
    if (!mounted) return;
    if (playing && !hovering && !hidden) {
      elapsed += 250;
      if (barFill) barFill.style.transform = `scaleX(${Math.min(1, elapsed / AUTOPLAY_MS)})`;
      if (elapsed >= AUTOPLAY_MS) next();
    }
  }
  function startTimer() {
    if (timer) return;
    timer = setInterval(tick, 250);
  }
  function stopTimer() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function render() {
    pauseBtn.classList.toggle('on', !playing);
    pauseBtn.innerHTML = '';
    pauseBtn.append(icon(playing ? IC_PAUSE : IC_PLAY, '', 16));
    pauseBtn.setAttribute('aria-label', playing ? '暂停自动播放' : '继续自动播放');
    pauseBtn.title = playing ? '暂停' : '继续';
  }

  async function init() {
    const total = await getPageCount(book);
    if (!mounted) return;
    placeholder.remove();

    const n = Math.max(1, Math.min(total || 1, PREVIEW_MAX));
    pages = Array.from({ length: n }, (_, i) => i + 1);

    pages.forEach((pg, i) => {
      const img = h('img.pv-img', {
        alt: `第 ${pg} 页`,
        loading: 'lazy',
        decoding: 'async',
        draggable: false,
        referrerpolicy: 'no-referrer',
      });
      const slide = h('div.pv-slide', { dataset: { pg: String(pg) } }, img);
      track.append(slide);
      renderPageDataUrl(book, pg).then((url) => {
        if (!mounted) return;
        if (url) {
          img.onload = () => slide.classList.add('loaded');
          img.onerror = () => slide.classList.add('failed');
          img.src = url;
        } else {
          slide.classList.add('failed');
        }
      });
      dotsWrap.append(h('button.pv-dot', { type: 'button', 'aria-label': `第 ${pg} 页`, dataset: { i: String(i) } }));
    });

    // ---- 事件 ----
    const prevBtn = section.querySelector('.pv-prev');
    const nextBtn = section.querySelector('.pv-next');
    prevBtn.addEventListener('click', prev);
    nextBtn.addEventListener('click', next);
    Array.from(dotsWrap.children).forEach((d, k) => d.addEventListener('click', () => go(k)));
    pauseBtn.addEventListener('click', () => {
      playing = !playing;
      render();
    });
    setCoverBtn.addEventListener('click', () => {
      const pg = pages[index];
      setCoverPage(book, pg);
      updateSetCoverBtn();
      if (opts.onSetCover) opts.onSetCover(pg);
      toast(`已将第 ${pg} 页设为封面`, 'ok', 1800);
    });
    if (!opts.inFullscreen && fsBtn) {
      fsBtn.addEventListener('click', () => {
        openPreviewFullscreen(book, { onSetCover: opts.onSetCover, night: section.closest('.reader')?.classList.contains('night') });
      });
    }

    const onEnter = () => {
      hovering = true;
      section.classList.add('paused');
    };
    const onLeave = () => {
      hovering = false;
      section.classList.toggle('paused', !playing);
    };
    section.addEventListener('mouseenter', onEnter);
    section.addEventListener('mouseleave', onLeave);
    const onVis = () => {
      hidden = document.hidden;
    };
    document.addEventListener('visibilitychange', onVis);
    const onKey = (e) => {
      if (e.key === 'ArrowLeft') prev();
      else if (e.key === 'ArrowRight') next();
    };
    section.addEventListener('keydown', onKey);
    const onResize = () => apply(false);
    window.addEventListener('resize', onResize);

    offs.push(() => prevBtn.removeEventListener('click', prev));
    offs.push(() => nextBtn.removeEventListener('click', next));
    offs.push(() => section.removeEventListener('mouseenter', onEnter));
    offs.push(() => section.removeEventListener('mouseleave', onLeave));
    offs.push(() => document.removeEventListener('visibilitychange', onVis));
    offs.push(() => section.removeEventListener('keydown', onKey));
    offs.push(() => window.removeEventListener('resize', onResize));

    index = 0;
    apply(true);
    updateSetCoverBtn();
    render();
    startTimer();
  }

  return {
    init,
    destroy() {
      mounted = false;
      stopTimer();
      offs.forEach((f) => f());
    },
  };
}
