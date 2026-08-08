/* ============================================================
   slideshow.js — 首页精选教材「封面轮播」
   ------------------------------------------------------------
   · 一行平铺多张真实封面缩图（桌面 5 张，平板 3、手机 2）
   · 自动横向滚动轮播，默认 5s，可选手动 3 / 5 / 10 / 15 秒，或暂停
   · 悬停 / 标签页切到后台时自动暂停；圆点 / 左右箭头 / 键盘导航
   · 封面按 PDF 首页「原比例」缩放（aspect-ratio: A4 + object-fit: contain），不裁切
   · 偏好（间隔、是否暂停）持久化到 localStorage
   ============================================================ */

import { h, icon } from '../util.js';
import { build } from '../router.js';
import { registerCover } from '../cover.js';

const IC_ARROW = '<path d="M5 12h14M13 6l6 6-6 6"/>';
const IC_PLAY = '<path d="M8 5v14l11-7z"/>';
const IC_PAUSE = '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/>';
const IC_PREV = '<path d="M15 6l-6 6 6 6"/>';
const IC_NEXT = '<path d="M9 6l6 6-6 6"/>';

const INTERVALS = [3, 5, 10, 15];
const VIS = 5; // 桌面同时可见的封面数（用于无缝克隆）
const STORE_INT = 'tb:slideInterval';
const STORE_PAUSE = 'tb:slidePaused';

let active = null;

/** 路由切换时清理定时器与监听（防止离开首页后仍在跑 rAF） */
export function destroySlideshow() {
  if (active) {
    active.destroy();
    active = null;
  }
}

/* ---------------- 精选书目 ---------------- */
function pickFeatured(all, n = 10) {
  // 优先覆盖主要学段 + 学科，且文件不要太大（封面首屏更快出图）
  const PRIORITY = [
    ['小学', '语文'],
    ['小学', '数学'],
    ['小学', '英语'],
    ['初中', '语文'],
    ['初中', '数学'],
    ['初中', '英语'],
    ['初中', '物理'],
    ['初中', '生物'],
    ['初中', '地理'],
    ['高中', '语文'],
    ['高中', '数学'],
    ['高中', '英语'],
    ['高中', '物理'],
    ['高中', '化学'],
    ['高中', '生物'],
    ['高中', '历史'],
    ['高中', '地理'],
    ['高中', '政治'],
  ];
  const seen = new Set();
  const out = [];
  const take = (pred) => {
    if (out.length >= n) return;
    const b = all.find((x) => pred(x) && !seen.has(x.id));
    if (b) {
      seen.add(b.id);
      out.push(b);
    }
  };
  for (const [stage, subject] of PRIORITY) {
    take((x) => x.stage === stage && x.subject === subject && x.size <= 40 * 1024 * 1024);
    if (out.length < n) take((x) => x.stage === stage && x.subject === subject);
  }
  if (out.length < n) {
    const subs = ['语文', '数学', '英语', '物理', '化学', '历史', '地理', '生物', '政治', '信息技术'];
    for (const s of subs) {
      take((x) => x.subject === s);
      if (out.length >= n) break;
    }
  }
  return out.slice(0, n);
}

/* ---------------- 单张封面 ---------------- */
function buildCover(book, i) {
  const coverEl = h(
    'div.bc-cover',
    h(
      'div.bc-cover-fallback',
      h('span.fb-spine'),
      h('div.fb-top', book.subject || book.stage || '教材'),
      h('div.fb-mid', h('span.fb-title', book.title)),
      h('div.fb-bot', [book.edition, book.grade, book.vol].filter(Boolean).join(' · '))
    ),
    h('img.bc-cover-img', {
      alt: '',
      loading: 'lazy',
      decoding: 'async',
      draggable: false,
      referrerpolicy: 'no-referrer',
    })
  );
  // 复用书卡封面引擎（真实首页缩图 + 学科兜底封面）
  registerCover(coverEl, book);

  return h(
    'a.ss-cover.slide',
    { href: build('book', {}, book.id), 'aria-label': book.title, dataset: { index: String(i) } },
    coverEl
  );
}

/* ---------------- 对外：构建轮播 ---------------- */
export function buildSlideshow(all) {
  const items = pickFeatured(all, 18);
  if (!items.length) return null;

  const covers = items.map((b, i) => buildCover(b, i));
  // 末尾追加「可见数量」的克隆，实现向前无缝循环
  const clones = items.slice(0, Math.min(VIS, items.length)).map((b, i) => buildCover(b, i + items.length));
  const track = h('div.ss-track', ...covers, ...clones);

  const dots = items.map((_, i) =>
    h('button.ss-dot', { type: 'button', 'aria-label': `第 ${i + 1} 张`, dataset: { i: String(i) } })
  );
  const intervalBtns = INTERVALS.map((s) =>
    h('button.ss-int', { type: 'button', dataset: { s: String(s) }, 'aria-label': `${s} 秒切换` }, `${s}s`)
  );
  const pauseBtn = h('button.ss-pause', { type: 'button', 'aria-label': '暂停自动播放', title: '暂停' }, icon(IC_PAUSE, '', 16));

  const root = h(
    'section.slideshow',
    h('div.ss-progress', h('i')),
    h(
      'div.ss-head',
      h('h2.ss-title', '精选教材'),
      h('p.ss-sub', '公益开放 · 免登录在线阅读')
    ),
    h(
      'div.ss-viewport',
      track,
      h('button.ss-arrow.ss-prev', { type: 'button', 'aria-label': '上一组', title: '上一组' }, icon(IC_PREV, '', 18)),
      h('button.ss-arrow.ss-next', { type: 'button', 'aria-label': '下一组', title: '下一组' }, icon(IC_NEXT, '', 18))
    ),
    h(
      'div.ss-bar',
      h('div.ss-dots', ...dots),
      h(
        'div.ss-controls',
        h('span.ss-label', '自动切换'),
        h('div.ss-intervals', ...intervalBtns),
        pauseBtn
      )
    )
  );

  active = createController(root, items.length, { track, dots, intervalBtns, pauseBtn });
  return root;
}

/* ---------------- 控制器（计时 / 交互） ---------------- */
function clampInt(v) {
  return INTERVALS.includes(v) ? v : 5;
}

function createController(root, count, refs) {
  const { track, dots, intervalBtns, pauseBtn } = refs;
  const N = count;

  let index = 0;
  let interval = clampInt(Number(localStorage.getItem(STORE_INT)));
  let userPaused = localStorage.getItem(STORE_PAUSE) === '1';
  let hovering = false;
  let hidden = document.hidden;
  let elapsed = 0;
  let last = 0;
  let raf = null;
  let mounted = true;
  let jumpTimer = null;
  const offs = [];

  const effectivePaused = () => userPaused || hovering || hidden;

  function stepPx() {
    const first = track.children[0];
    if (!first) return 0;
    const cs = getComputedStyle(track);
    const gap = parseFloat(cs.columnGap || cs.gap || '0') || 0;
    return first.getBoundingClientRect().width + gap;
  }

  function apply(animate) {
    track.style.transition = animate ? '' : 'none';
    track.style.transform = `translateX(${-index * stepPx()}px)`;
    if (!animate) {
      // 强制回流后恢复过渡，避免瞬移被动画化
      void track.offsetHeight;
      track.style.transition = '';
    }
    // 当前封面位高亮（含克隆卡，index 进入克隆区时高亮对应克隆）
    Array.from(track.children).forEach((c, k) => c.classList.toggle('on', k === index));
    dots.forEach((d, k) => d.classList.toggle('on', k === (index % N)));
  }

  function go(i) {
    index = i;
    apply(true);
    if (index >= N) {
      // 进入克隆区（视觉等同起点）→ 过渡结束后无感跳回
      clearTimeout(jumpTimer);
      jumpTimer = setTimeout(() => {
        index -= N;
        apply(false);
        resetProgress();
      }, 620);
    }
  }
  function next() {
    go(index + 1);
    resetProgress(); // 前进后归零计时，否则 loop 会每帧继续触发 next，导致一次性滚飞
  }
  function prev() {
    if (index === 0) {
      index = N - 1;
      apply(false);
    } else {
      go(index - 1);
    }
    resetProgress();
  }

  function resetProgress() {
    bar.style.transform = 'scaleX(0)';
    elapsed = 0;
  }

  const bar = root.querySelector('.ss-progress > i');
  const prevBtn = root.querySelector('.ss-prev');
  const nextBtn = root.querySelector('.ss-next');

  function render() {
    intervalBtns.forEach((b) => b.classList.toggle('on', !userPaused && Number(b.dataset.s) === interval));
    pauseBtn.classList.toggle('on', userPaused);
    pauseBtn.innerHTML = '';
    pauseBtn.append(icon(userPaused ? IC_PLAY : IC_PAUSE, '', 16));
    pauseBtn.setAttribute('aria-label', userPaused ? '继续自动播放' : '暂停自动播放');
    pauseBtn.title = userPaused ? '继续' : '暂停';
    root.classList.toggle('paused', effectivePaused());
    apply(true);
    resetProgress();
  }

  function loop(ts) {
    if (!mounted) return;
    if (!last) last = ts;
    const dt = ts - last;
    last = ts;
    if (!effectivePaused()) {
      elapsed += dt;
      const frac = Math.min(1, elapsed / (interval * 1000));
      bar.style.transform = `scaleX(${frac})`;
      if (elapsed >= interval * 1000) next();
    }
    raf = requestAnimationFrame(loop);
  }

  // ---- 事件 ----
  prevBtn.addEventListener('click', prev);
  nextBtn.addEventListener('click', next);
  dots.forEach((d, k) =>
    d.addEventListener('click', () => {
      go(k);
      resetProgress();
    })
  );
  intervalBtns.forEach((b) =>
    b.addEventListener('click', () => {
      interval = Number(b.dataset.s);
      localStorage.setItem(STORE_INT, String(interval));
      userPaused = false;
      localStorage.setItem(STORE_PAUSE, '0');
      render();
    })
  );
  pauseBtn.addEventListener('click', () => {
    userPaused = !userPaused;
    localStorage.setItem(STORE_PAUSE, userPaused ? '1' : '0');
    render();
  });
  const onEnter = () => {
    hovering = true;
    root.classList.add('paused');
  };
  const onLeave = () => {
    hovering = false;
    root.classList.toggle('paused', effectivePaused());
  };
  root.addEventListener('mouseenter', onEnter);
  root.addEventListener('mouseleave', onLeave);
  const onVis = () => {
    hidden = document.hidden;
    if (!hidden) last = 0; // 切回前台时重置计时基准，避免 dt 暴增一次性跳多张
    root.classList.toggle('paused', effectivePaused());
  };
  document.addEventListener('visibilitychange', onVis);
  const onKey = (e) => {
    if (e.key === 'ArrowLeft') prev();
    else if (e.key === 'ArrowRight') next();
  };
  root.addEventListener('keydown', onKey);
  const onResize = () => apply(false);
  window.addEventListener('resize', onResize);

  offs.push(() => prevBtn.removeEventListener('click', prev));
  offs.push(() => nextBtn.removeEventListener('click', next));
  offs.push(() => root.removeEventListener('mouseenter', onEnter));
  offs.push(() => root.removeEventListener('mouseleave', onLeave));
  offs.push(() => document.removeEventListener('visibilitychange', onVis));
  offs.push(() => root.removeEventListener('keydown', onKey));
  offs.push(() => window.removeEventListener('resize', onResize));

  render();
  raf = requestAnimationFrame(loop);

  return {
    destroy() {
      mounted = false;
      if (raf) cancelAnimationFrame(raf);
      clearTimeout(jumpTimer);
      offs.forEach((f) => f());
    },
  };
}
