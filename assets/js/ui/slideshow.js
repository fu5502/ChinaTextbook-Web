/* ============================================================
   slideshow.js — 首页精选教材轮播
   ------------------------------------------------------------
   · 精选若干本教材作为幻灯片，复用封面引擎 registerCover 渲染真实首页缩图
   · 自动切换：默认 5s，可选手动 3 / 5 / 10 / 15 秒，或暂停
   · 悬停 / 标签页切到后台时自动暂停；圆点 / 左右箭头 / 键盘左右键导航
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
function pickFeatured(all, n = 6) {
  // 优先覆盖主要学段 + 学科，且文件不要太大（封面首屏更快出图）
  const PRIORITY = [
    ['小学', '语文'],
    ['小学', '数学'],
    ['初中', '数学'],
    ['初中', '英语'],
    ['高中', '物理'],
    ['高中', '历史'],
    ['小学', '英语'],
    ['高中', '化学'],
    ['初中', '生物'],
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

/* ---------------- 单张幻灯片 ---------------- */
function buildSlide(book, i) {
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

  const card = h(
    'a.ss-card',
    { href: build('book', {}, book.id), 'aria-label': book.title },
    h('div.ss-cover', coverEl),
    h(
      'div.ss-info',
      h('span.ss-kicker', (book.stage || '') + (book.subject ? ' · ' + book.subject : '')),
      h('h3.ss-title', book.title),
      h('div.ss-meta', [book.edition, book.grade, book.vol].filter(Boolean).join(' · ')),
      h('span.ss-cta', icon(IC_ARROW, '', 16), '去阅读')
    )
  );
  return h('div.slide', { dataset: { index: String(i) } }, card);
}

/* ---------------- 对外：构建轮播 ---------------- */
export function buildSlideshow(all) {
  const items = pickFeatured(all, 6);
  if (!items.length) return null;

  const track = h('div.ss-track', ...items.map((b, i) => buildSlide(b, i)));
  const dots = items.map((_, i) =>
    h('button.ss-dot', { type: 'button', 'aria-label': `第 ${i + 1} 张`, dataset: { i: String(i) } })
  );
  const intervalBtns = INTERVALS.map((s) =>
    h('button.ss-int', { type: 'button', dataset: { s: String(s) }, 'aria-label': `${s} 秒切换` }, `${s}s`)
  );
  const pauseBtn = h('button.ss-pause', { type: 'button', 'aria-label': '暂停自动播放', title: '暂停' }, icon(IC_PAUSE, '', 16));

  const root = h(
    'section.slideshow',
    h('div.ss-viewport', track),
    h('button.ss-arrow.ss-prev', { type: 'button', 'aria-label': '上一张', title: '上一张' }, icon(IC_PREV, '', 18)),
    h('button.ss-arrow.ss-next', { type: 'button', 'aria-label': '下一张', title: '下一张' }, icon(IC_NEXT, '', 18)),
    h('div.ss-dots', ...dots),
    h(
      'div.ss-bar',
      h('div.ss-progress', h('i')),
      h(
        'div.ss-controls',
        h('span.ss-label', '自动切换'),
        h('div.ss-intervals', ...intervalBtns),
        pauseBtn
      )
    )
  );

  active = createController(root, items.length);
  return root;
}

/* ---------------- 控制器（计时 / 交互） ---------------- */
function clampInt(v) {
  return INTERVALS.includes(v) ? v : 5;
}

function createController(root, count) {
  const track = root.querySelector('.ss-track');
  const dots = [...root.querySelectorAll('.ss-dot')];
  const intBtns = [...root.querySelectorAll('.ss-int')];
  const pauseBtn = root.querySelector('.ss-pause');
  const prevBtn = root.querySelector('.ss-prev');
  const nextBtn = root.querySelector('.ss-next');
  const bar = root.querySelector('.ss-progress > i');

  let index = 0;
  let interval = clampInt(Number(localStorage.getItem(STORE_INT)));
  let userPaused = localStorage.getItem(STORE_PAUSE) === '1';
  let hovering = false;
  let hidden = document.hidden;
  let elapsed = 0;
  let last = 0;
  let raf = null;
  let mounted = true;
  const offs = [];

  const effectivePaused = () => userPaused || hovering || hidden;

  function render() {
    track.style.transform = `translateX(${-index * 100}%)`;
    dots.forEach((d, k) => d.classList.toggle('on', k === index));
    bar.style.transform = 'scaleX(0)';
    elapsed = 0;
    intBtns.forEach((b) => b.classList.toggle('on', !userPaused && Number(b.dataset.s) === interval));
    pauseBtn.classList.toggle('on', userPaused);
    pauseBtn.innerHTML = '';
    pauseBtn.append(icon(userPaused ? IC_PLAY : IC_PAUSE, '', 16));
    pauseBtn.setAttribute('aria-label', userPaused ? '继续自动播放' : '暂停自动播放');
    pauseBtn.title = userPaused ? '继续' : '暂停';
    root.classList.toggle('paused', effectivePaused());
  }

  function goTo(i) {
    index = ((i % count) + count) % count;
    render();
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
      if (elapsed >= interval * 1000) goTo(index + 1);
    }
    raf = requestAnimationFrame(loop);
  }

  // ---- 事件 ----
  const onPrev = () => goTo(index - 1);
  const onNext = () => goTo(index + 1);
  prevBtn.addEventListener('click', onPrev);
  nextBtn.addEventListener('click', onNext);
  dots.forEach((d, k) => d.addEventListener('click', () => goTo(k)));
  intBtns.forEach((b) =>
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
    root.classList.toggle('paused', effectivePaused());
  };
  document.addEventListener('visibilitychange', onVis);
  const onKey = (e) => {
    if (e.key === 'ArrowLeft') goTo(index - 1);
    else if (e.key === 'ArrowRight') goTo(index + 1);
  };
  root.addEventListener('keydown', onKey);

  offs.push(() => prevBtn.removeEventListener('click', onPrev));
  offs.push(() => nextBtn.removeEventListener('click', onNext));
  offs.push(() => root.removeEventListener('mouseenter', onEnter));
  offs.push(() => root.removeEventListener('mouseleave', onLeave));
  offs.push(() => document.removeEventListener('visibilitychange', onVis));
  offs.push(() => root.removeEventListener('keydown', onKey));

  render();
  raf = requestAnimationFrame(loop);

  return {
    destroy() {
      mounted = false;
      if (raf) cancelAnimationFrame(raf);
      offs.forEach((f) => f());
    },
  };
}
