/* ============================================================
   detail.js — 书籍详情页：元信息 / 阅读 / 下载 / 线路 / 相关推荐
   ============================================================ */

import { h, icon, fmtSize, fmtNum } from '../util.js';
import { getBook, isVolume, segments, filterBooks } from '../catalog.js';
import { favorites, progress } from '../storage.js';
import { build } from '../router.js';
import { sourcesFor, cachedSpeeds } from '../sources.js';
import { downloadBook } from '../download.js';
import { bookCard } from './bookcard.js';
import { emptyState } from './browse.js';
import { toast } from './toast.js';
import { registerCover } from '../cover.js';

const IC_READ = '<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v18H6.5A2.5 2.5 0 0 0 4 22.5v-18z"/><path d="M4 17.5A2.5 2.5 0 0 1 6.5 15H20"/>';
const IC_DOWN = '<path d="M12 3v13"/><path d="M7 11.5l5 5 5-5"/><path d="M4 21h16"/>';
const IC_HEART = '<path d="M12 21s-7.5-4.7-9.3-9A5.3 5.3 0 0 1 12 6.6 5.3 5.3 0 0 1 21.3 12c-1.8 4.3-9.3 9-9.3 9z"/>';
const IC_LAYERS = '<path d="M12 2.5l9 4.7-9 4.7-9-4.7 9-4.7z"/><path d="M3 12.2l9 4.7 9-4.7"/><path d="M3 17l9 4.7 9-4.7"/>';
const IC_LINK = '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>';

export function renderDetail(app, route) {
  const id = route.parts[0];
  const b = getBook(id);

  if (!b) {
    app.append(
      h(
        'div.page',
        emptyState('未找到这本教材', '链接可能已失效，或索引已更新。', true),
        h('div', { style: { textAlign: 'center', marginTop: 'calc(-1 * var(--sp-5))' } }, h('a.btn.btn-primary', { href: '#/' }, '返回首页'))
      )
    );
    return;
  }

  const vol = isVolume(b);
  const prog = progress.get(b.id);
  const srcList = sourcesFor(b.size);
  const speeds = cachedSpeeds();

  const page = h('div.page');

  // ---- 面包屑 ----
  page.append(
    h(
      'nav.crumbs',
      { 'aria-label': '面包屑' },
      h('a', { href: '#/' }, '首页'),
      h('span.sep', '/'),
      h('a', { href: build('browse', { stage: b.stage }) }, b.stage),
      b.subject ? [h('span.sep', '/'), h('a', { href: build('browse', { stage: b.stage, subject: b.subject }) }, b.subject)] : null,
      b.edition ? [h('span.sep', '/'), h('a', { href: build('browse', { stage: b.stage, subject: b.subject, edition: b.edition }) }, b.edition)] : null
    )
  );

  // ---- 主卡 ----
  const favBtn = favButton(b);

  const coverEl = h(
    'div.detail-cover',
    h(
      'div.bc-cover-fallback',
      h('span.fb-spine'),
      h('div.fb-top', b.subject || b.stage || '教材'),
      h('div.fb-mid', h('span.fb-title', b.title)),
      h('div.fb-bot', [b.edition, b.grade, b.vol].filter(Boolean).join(' · '))
    ),
    h('img.bc-cover-img', { alt: '', loading: 'lazy', decoding: 'async', draggable: false, referrerpolicy: 'no-referrer' })
  );
  registerCover(coverEl, b);

  page.append(
    h(
      'div.card',
      { style: { padding: 'var(--sp-6)', display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr) auto', gap: 'var(--sp-5)', alignItems: 'start' } },
      coverEl,
      h(
        'div',
        { style: { minWidth: 0 } },
        h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: 'var(--sp-3)' } },
          b.subject ? h('span.tag.tag-brand', b.subject) : null,
          b.grade ? h('span.tag', b.grade) : null,
          b.vol ? h('span.tag', b.vol) : null,
          vol ? h('span.tag.tag-accent', icon(IC_LAYERS, '', 10), `${b.parts.length} 卷合并`) : null
        ),
        h('h1', { style: { fontFamily: 'var(--font-serif)', fontSize: 'var(--fs-2xl)', lineHeight: '1.4', wordBreak: 'break-word' } }, b.title),
        h(
          'p',
          { style: { marginTop: 'var(--sp-3)', color: 'var(--ink-500)', fontSize: 'var(--fs-md)' } },
          [b.stage, b.edition, b.publisher].filter(Boolean).join(' · ')
        ),
        prog && prog.page > 1
          ? h(
              'p',
              { style: { marginTop: 'var(--sp-2)', color: 'var(--accent-700)', fontSize: 'var(--fs-sm)' } },
              `上次读到第 ${prog.page} 页${prog.pages ? ` / 共 ${prog.pages} 页` : ''}`
            )
          : null,
        h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-3)', marginTop: 'var(--sp-5)' } },
          h('a.btn.btn-primary.btn-lg', { href: build('read', prog?.page > 1 ? { p: prog.page } : {}, b.id) }, icon(IC_READ), prog?.page > 1 ? '继续阅读' : '在线阅读'),
          downloadButton(b),
          favBtn
        )
      ),
      infoTable(b, vol, srcList, speeds)
    )
  );

  // ---- 分卷说明 ----
  if (vol) {
    page.append(
      h(
        'div.card',
        { style: { padding: 'var(--sp-5)', marginTop: 'var(--sp-4)', display: 'flex', gap: 'var(--sp-4)' } },
        icon(IC_LAYERS, '', 20),
        h(
          'div',
          h('h3', { style: { fontSize: 'var(--fs-md)', marginBottom: '6px' } }, '这本书在源仓库中被切分为 ' + b.parts.length + ' 个分卷'),
          h(
            'p',
            { style: { fontSize: 'var(--fs-sm)', color: 'var(--ink-500)', lineHeight: '1.8' } },
            '在线阅读时本站会把分卷拼接成一个连续文件按需读取，',
            h('strong', '无需先下载完整的 ' + fmtSize(b.size)),
            '；选择「下载」则会依次取回全部分卷并在浏览器内合并成单个 PDF。'
          ),
          h(
            'details',
            { style: { marginTop: 'var(--sp-3)', fontSize: 'var(--fs-sm)', color: 'var(--ink-500)' } },
            h('summary', { style: { cursor: 'pointer', color: 'var(--brand-600)' } }, '查看分卷明细'),
            h(
              'ul',
              { style: { marginTop: 'var(--sp-2)', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)' } },
              segments(b).map((s, i) =>
                h('li', { style: { padding: '2px 0', color: 'var(--ink-400)' } }, `#${i + 1}  ${fmtSize(s.size).padStart(8)}   字节 ${fmtNum(s.start)} – ${fmtNum(s.end - 1)}`)
              )
            )
          )
        )
      )
    );
  }

  // ---- 相关教材 ----
  const related = findRelated(b);
  if (related.length) {
    page.append(
      h(
        'section.section',
        h('div.section-head', h('h2', '同系列教材'), h('span.hint', `${b.edition || b.subject || ''} · 共 ${related.length} 册`)),
        h('div.book-grid', related.slice(0, 12).map((x) => bookCard(x)))
      )
    );
  }

  app.append(page);
}

function infoTable(b, vol, srcList, speeds) {
  const rows = [
    ['文件体积', fmtSize(b.size)],
    ['文件形式', vol ? `${b.parts.length} 个分卷` : '单个 PDF'],
    ['首选线路', srcList[0] ? srcList[0].name : '—'],
    ['可用线路', `${srcList.length} 条${b.size > 20 * 1024 * 1024 ? '（超 20MB，已排除 jsDelivr）' : ''}`],
  ];

  return h(
    'div',
    {
      style: {
        minWidth: '230px',
        padding: 'var(--sp-4)',
        background: 'var(--brand-050)',
        border: '1px solid var(--brand-100)',
        borderRadius: 'var(--r-md)',
        fontSize: 'var(--fs-sm)',
      },
    },
    h('h4', { style: { fontSize: 'var(--fs-xs)', letterSpacing: '.08em', color: 'var(--ink-400)', marginBottom: 'var(--sp-3)' } }, '资源信息'),
    rows.map(([k, v]) =>
      h(
        'div',
        { style: { display: 'flex', justifyContent: 'space-between', gap: 'var(--sp-3)', padding: '4px 0' } },
        h('span', { style: { color: 'var(--ink-400)' } }, k),
        h('span', { style: { color: 'var(--ink-800)', fontWeight: '500', textAlign: 'right' } }, v)
      )
    ),
    h('div', { style: { height: '1px', background: 'var(--brand-100)', margin: 'var(--sp-3) 0' } }),
    h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
      srcList.slice(0, 4).map((s) =>
        h(
          'div',
          { style: { display: 'flex', justifyContent: 'space-between', gap: 'var(--sp-2)', fontSize: 'var(--fs-xs)', color: 'var(--ink-500)' } },
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, s.name),
          h('span', { style: { color: speeds[s.id] ? 'var(--ok)' : 'var(--ink-300)', fontVariantNumeric: 'tabular-nums' } }, speeds[s.id] ? `${speeds[s.id]} ms` : '未测速')
        )
      )
    )
  );
}

function favButton(b) {
  const update = (btn, on) => {
    btn.classList.toggle('btn-primary', false);
    btn.setAttribute('aria-pressed', String(on));
    btn.title = on ? '取消收藏' : '收藏';
    const lbl = btn.querySelector('.lbl');
    if (lbl) lbl.textContent = on ? '已收藏' : '收藏';
    const svg = btn.querySelector('svg');
    if (svg) svg.style.fill = on ? 'currentColor' : 'none';
    btn.style.color = on ? 'var(--accent-700)' : '';
    btn.style.borderColor = on ? 'var(--accent-500)' : '';
  };
  const btn = h(
    'button.btn.btn-lg',
    {
      type: 'button',
      onclick: () => {
        const on = favorites.toggle(b.id);
        update(btn, on);
        toast(on ? '已加入收藏' : '已取消收藏', on ? 'ok' : 'info', 1600);
      },
    },
    icon(IC_HEART),
    h('span.lbl', '收藏')
  );
  update(btn, favorites.has(b.id));
  return btn;
}

function downloadButton(b) {
  const vol = isVolume(b);
  const idle = vol ? `下载并合并（${fmtSize(b.size)}）` : `下载（${fmtSize(b.size)}）`;
  const btn = h(
    'button.btn.btn-lg',
    {
      type: 'button',
      onclick: async () => {
        if (btn.disabled) return;
        btn.disabled = vol;
        await downloadBook(b, (text) => {
          const lbl = btn.querySelector('.lbl');
          if (lbl) lbl.textContent = text || idle;
        });
        btn.disabled = false;
      },
    },
    icon(IC_DOWN),
    h('span.lbl', idle)
  );
  return btn;
}

function findRelated(b) {
  const cond = { stage: b.stage, subject: b.subject };
  if (b.edition) cond.edition = b.edition;
  return filterBooks(cond).filter((x) => x.id !== b.id);
}
