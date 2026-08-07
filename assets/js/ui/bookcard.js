/* ============================================================
   bookcard.js — 书卡组件
   ============================================================ */

import { h, icon, fmtSize, highlight } from '../util.js';
import { isVolume } from '../catalog.js';
import { favorites, progress } from '../storage.js';
import { build } from '../router.js';
import { toast } from './toast.js';

const IC_HEART = '<path d="M12 21s-7.5-4.7-9.3-9A5.3 5.3 0 0 1 12 6.6 5.3 5.3 0 0 1 21.3 12c-1.8 4.3-9.3 9-9.3 9z"/>';
const IC_BOLT = '<path d="M13 2L4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5z"/>';
const IC_LAYERS = '<path d="M12 2.5l9 4.7-9 4.7-9-4.7 9-4.7z"/><path d="M3 12.2l9 4.7 9-4.7"/><path d="M3 17l9 4.7 9-4.7"/>';
const IC_CLOCK = '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 1.8"/>';

const SMALL = 20 * 1024 * 1024;
const BIG = 60 * 1024 * 1024;

function speedBadge(size) {
  if (size <= SMALL) return { lv: 'fast', text: '秒开', ico: IC_BOLT };
  if (size <= BIG) return { lv: 'mid', text: '按需加载', ico: IC_BOLT };
  return { lv: 'big', text: '大文件', ico: IC_CLOCK };
}

/**
 * @param {object} book
 * @param {object} opts { terms:string[], showStage:boolean, onFav:fn }
 */
export function bookCard(book, opts = {}) {
  const { terms = [], showStage = false } = opts;

  const metaBits = [];
  if (showStage && book.stage) metaBits.push(book.stage);
  if (book.edition) metaBits.push(book.edition);
  if (book.publisher && book.publisher !== book.edition) metaBits.push(book.publisher);

  const tags = [];
  if (book.subject) tags.push(h('span.tag.tag-brand', book.subject));
  if (book.grade) tags.push(h('span.tag', book.grade));
  if (book.vol) tags.push(h('span.tag', book.vol));

  const sp = speedBadge(book.size);
  const prog = progress.get(book.id);
  const isFav = favorites.has(book.id);

  const favBtn = h(
    `button.bc-fav${isFav ? '.on' : ''}`,
    {
      type: 'button',
      title: isFav ? '取消收藏' : '收藏',
      'aria-label': isFav ? '取消收藏' : '收藏',
      'aria-pressed': String(isFav),
      onclick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        const added = favorites.toggle(book.id);
        favBtn.classList.toggle('on', added);
        favBtn.setAttribute('aria-pressed', String(added));
        favBtn.title = added ? '取消收藏' : '收藏';
        toast(added ? '已加入收藏' : '已取消收藏', added ? 'ok' : 'info', 1600);
        opts.onFav?.(book.id, added);
      },
    },
    icon(IC_HEART)
  );

  const card = h(
    'a.book-card',
    {
      href: build('book', {}, book.id),
      dataset: { subject: book.subject || '', id: book.id },
      'aria-label': `${book.title}${book.edition ? ` ${book.edition}` : ''}`,
    },
    h(
      'div.bc-main',
      h('div.bc-title', { html: highlight(book.title, terms) }),
      metaBits.length ? h('div.bc-meta', metaBits.join(' · ')) : null
    ),
    tags.length ? h('div.bc-tags', tags) : null,
    h(
      'div.bc-foot',
      h('span.bc-size', fmtSize(book.size)),
      isVolume(book) ? h('span.bc-vol-mark', icon(IC_LAYERS, '', 10), `${book.parts.length} 卷`) : null,
      h('span', { style: { marginLeft: 'auto' } }),
      h('span.bc-speed', { dataset: { lv: sp.lv } }, icon(sp.ico, '', 10), sp.text)
    ),
    favBtn,
    prog && prog.pages > 1
      ? h('div.bc-progress', h('i', { style: { width: `${Math.min(100, (prog.page / prog.pages) * 100)}%` } }))
      : null
  );

  return card;
}

/** 骨架卡 */
export function bookCardSkeleton() {
  return h(
    'div.bc-skeleton',
    h('div.skeleton.sk-line', { style: { width: '85%', height: '14px' } }),
    h('div.skeleton.sk-line', { style: { width: '55%', height: '14px' } }),
    h('div.skeleton.sk-line', { style: { width: '70%', height: '10px', marginTop: '14px' } }),
    h('div.skeleton.sk-line', { style: { width: '40%', height: '10px' } })
  );
}

/** 一批骨架 */
export function skeletonGrid(n = 12) {
  return h('div.book-grid', Array.from({ length: n }, () => bookCardSkeleton()));
}
