/* ============================================================
   preview.js — 教材详情页「多页预览」幻灯片
   ------------------------------------------------------------
   · 展示该教材前若干页（最多 PREVIEW_MAX）缩图，A4 原比例完整显示
   · 自动播放（默认 4s）+ 手动切换：左右箭头 / 圆点 / 悬停暂停 / 键盘 / 切后台暂停
   · 「设为封面」：把当前显示的页设为该教材封面（持久化，列表/详情封面同步生效）
   · 复用 cover.js 的 renderPageDataUrl / getPageCount / setCoverPage
   ============================================================ */

import { h, icon } from '../util.js';
import { renderPageDataUrl, getPageCount, coverPageOf, setCoverPage } from '../cover.js';
import { toast } from './toast.js';

const IC_PREV = '<path d="M15 6l-6 6 6 6"/>';
const IC_NEXT = '<path d="M9 6l6 6-6 6"/>';
const IC_PAUSE = '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/>';
const IC_PLAY = '<path d="M8 5v14l11-7z"/>';
const IC_COVER = '<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v18H6.5A2.5 2.5 0 0 0 4 22.5v-18z"/><path d="M4 17.5A2.5 2.5 0 0 1 6.5 15H20"/>';

const PREVIEW_MAX = 8; // 最多预览页数
const AUTOPLAY_MS = 4000; // 自动切换间隔

let active = null;

/** 路由切换时清理计时器与监听（防止离开详情页后仍在跑 setInterval） */
export function destroyPreview() {
  if (active) {
    active.destroy();
    active = null;
  }
}

/**
 * 构建教材预览幻灯片。
 * @param {object} book 书目对象
 * @param {object} [opts] { onSetCover(page) } 设为封面后的回调（如刷新详情大封面）
 */
export function buildPreview(book, opts = {}) {
  const section = h('section.section.preview');
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
  const pauseBtn = h('button.pv-pause', { type: 'button', 'aria-label': '暂停自动播放', title: '暂停' }, icon(IC_PAUSE, '', 16));
  const bar = h('div.pv-bar', h('i'));
  section.append(h('div.pv-controls', dotsWrap, setCoverBtn, pauseBtn), bar);

  const placeholder = h('div.pv-loading', '正在读取教材页数…');
  section.append(placeholder);

  const ctrl = createController(section, book, opts, { track, dotsWrap, setCoverBtn, pauseBtn, bar, placeholder });
  active = ctrl;
  ctrl.init();
  return section;
}

function createController(section, book, opts, refs) {
  const { track, dotsWrap, setCoverBtn, pauseBtn, bar, placeholder } = refs;
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
