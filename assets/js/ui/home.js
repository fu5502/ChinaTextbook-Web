/* ============================================================
   home.js — 首页：Hero / 学段入口 / 最近在读 / 我的收藏
   ============================================================ */

import { h, icon, fmtNum, fmtSize, fmtTimeAgo } from '../util.js';
import { books, stageSummary, getBook, meta } from '../catalog.js';
import { recent, favorites } from '../storage.js';
import { build, go } from '../router.js';
import { bookCard } from './bookcard.js';

const IC_ARROW = '<path d="M5 12h14M13 6l6 6-6 6"/>';
const IC_BOOK = '<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v18H6.5A2.5 2.5 0 0 0 4 22.5v-18z"/><path d="M4 17.5A2.5 2.5 0 0 1 6.5 15H20"/>';
const IC_HEART = '<path d="M12 21s-7.5-4.7-9.3-9A5.3 5.3 0 0 1 12 6.6 5.3 5.3 0 0 1 21.3 12c-1.8 4.3-9.3 9-9.3 9z"/>';
const IC_CLOCK = '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 1.8"/>';
const IC_SEARCH = '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>';

const STAGE_COLOR = {
  小学: '#B8863B',
  初中: '#12457A',
  高中: '#0E6E7A',
  '小学（五•四学制）': '#A8407A',
  '初中（五•四学制）': '#6B3FA0',
  大学: '#1F7A4D',
  习题: '#8A5A2B',
};

const STAGE_DESC = {
  小学: '一至六年级全学科',
  初中: '七至九年级全学科',
  高中: '必修 / 选择性必修 / 选修',
  '小学（五•四学制）': '五四学制小学段',
  '初中（五•四学制）': '五四学制初中段',
  大学: '高数 · 线代 · 概率论 · 离散',
  习题: '中考数学真题与解析',
};

export function renderHome(app) {
  const all = books();
  const stages = stageSummary();
  const totalSize = all.reduce((a, b) => a + b.size, 0);

  const hero = h(
    'section.hero',
    h('div.hero-badge', '免登录 · 无广告 · 完全免费'),
    h('h1', '中国教材开放资源库'),
    h(
      'p.lede',
      '收录小学、初中、高中、五四学制及大学教材共 ',
      h('strong', fmtNum(all.length)),
      ' 册，浏览器内直接翻页阅读，无需下载、无需注册。'
    ),
    heroSearch(),
    h(
      'div.hero-stats',
      stat(fmtNum(all.length), '册教材'),
      stat(String(new Set(all.map((b) => b.subject).filter(Boolean)).size), '个学科'),
      stat(String(new Set(all.map((b) => b.edition).filter(Boolean)).size), '种版本'),
      stat(fmtSize(totalSize), '资源总量')
    )
  );

  const page = h('div.page');

  // ---- 学段入口 ----
  page.append(
    h(
      'section.section',
      { style: { marginTop: '0' } },
      h('div.section-head', h('h2', '按学段浏览'), h('span.hint', '选择学段后可继续按学科、版本、年级筛选')),
      h(
        'div.stage-grid',
        stages.map((s) =>
          h(
            'a.stage-card',
            {
              href: build('browse', { stage: s.stage }),
              style: { '--sc': STAGE_COLOR[s.stage] || 'var(--brand-600)' },
            },
            h('h3', s.stage),
            h('div.count', `${fmtNum(s.count)} 册`),
            h('div.subs', STAGE_DESC[s.stage] || s.subjects.slice(0, 4).join(' · '))
          )
        )
      )
    )
  );

  // ---- 最近在读 ----
  const recentSection = buildRecent();
  if (recentSection) page.append(recentSection);

  // ---- 我的收藏 ----
  const favSection = buildFavorites();
  if (favSection) page.append(favSection);

  // ---- 热门学科快捷入口 ----
  page.append(buildQuickSubjects());

  // ---- 说明 ----
  page.append(buildNotice());

  app.append(hero, page);
}

function stat(value, label) {
  return h('div.hero-stat', h('b', value), h('span', label));
}

function heroSearch() {
  const input = h('input.input', {
    type: 'search',
    placeholder: '搜索：人教版 数学 五年级 上册',
    'aria-label': '搜索教材',
    enterkeyhint: 'search',
    autocomplete: 'off',
  });
  const box = h(
    'div.hero-search.searchbox',
    icon(IC_SEARCH, 'ico-search'),
    input,
    h(
      'button.clear',
      {
        type: 'button',
        'aria-label': '清空',
        onclick: () => {
          input.value = '';
          box.classList.remove('has-value');
          input.focus();
        },
      },
      icon('<path d="M6 6l12 12M18 6L6 18"/>', '', 14)
    )
  );
  input.addEventListener('input', () => box.classList.toggle('has-value', !!input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && input.value.trim()) go(build('search', { q: input.value.trim() }));
  });
  return box;
}

function buildRecent() {
  const list = recent
    .all()
    .map((r) => ({ r, b: getBook(r.id) }))
    .filter((x) => x.b)
    .slice(0, 8);
  if (!list.length) return null;

  return h(
    'section.section',
    h(
      'div.section-head',
      h('h2', '继续阅读'),
      h(
        'button.more',
        {
          type: 'button',
          onclick: () => {
            recent.clear();
            go('#/', true);
            location.reload();
          },
        },
        '清空记录'
      )
    ),
    h(
      'div.hscroll',
      list.map(({ r, b }) => {
        const card = bookCard(b, { showStage: true });
        card.href = build('read', r.page > 1 ? { p: r.page } : {}, b.id);
        const foot = card.querySelector('.bc-foot');
        if (foot) {
          foot.prepend(
            h(
              'span',
              { style: { color: 'var(--accent-700)', display: 'inline-flex', alignItems: 'center', gap: '3px' } },
              icon(IC_CLOCK, '', 10),
              r.pages > 1 ? `第 ${r.page}/${r.pages} 页` : `第 ${r.page} 页`
            ),
            h('span.dot-sep', { style: { color: 'var(--ink-300)' } }, fmtTimeAgo(r.at))
          );
          const sizeEl = foot.querySelector('.bc-size');
          sizeEl?.remove();
        }
        return card;
      })
    )
  );
}

function buildFavorites() {
  const list = favorites.all().map(getBook).filter(Boolean);
  if (!list.length) return null;
  const show = list.slice(0, 8);
  return h(
    'section.section',
    h(
      'div.section-head',
      h('h2', '我的收藏'),
      h('span.hint', `${list.length} 册`),
      list.length > show.length ? h('a.more', { href: '#/favorites' }, '查看全部') : null
    ),
    h('div.book-grid', show.map((b) => bookCard(b, { showStage: true })))
  );
}

function buildQuickSubjects() {
  const all = books();
  const primary = ['语文', '数学', '英语', '物理', '化学', '生物学', '历史', '地理', '道德与法治', '科学', '信息技术', '音乐'];
  const counts = new Map();
  for (const b of all) if (b.subject) counts.set(b.subject, (counts.get(b.subject) || 0) + 1);

  return h(
    'section.section',
    h('div.section-head', h('h2', '常用学科'), h('span.hint', '跨学段查看该学科全部教材')),
    h(
      'div.stage-grid',
      { style: { gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' } },
      primary
        .filter((s) => counts.has(s))
        .map((s) =>
          h(
            'a.stage-card',
            {
              href: build('browse', { subject: s }),
              dataset: { subject: s },
              style: { '--sc': 'var(--sc, var(--brand-600))', padding: 'var(--sp-4)' },
            },
            h('h3', { style: { fontSize: 'var(--fs-md)' } }, s),
            h('div.count', `${counts.get(s)} 册`)
          )
        )
    )
  );
}

function buildNotice() {
  const m = meta();
  const when = m?.generatedAt ? new Date(m.generatedAt).toLocaleDateString('zh-CN') : '';
  return h(
    'section.section',
    h(
      'div.card',
      { style: { padding: 'var(--sp-5)', display: 'flex', gap: 'var(--sp-4)', alignItems: 'flex-start' } },
      icon(IC_BOOK, '', 22),
      h(
        'div',
        h('h3', { style: { fontSize: 'var(--fs-md)', marginBottom: '6px' } }, '关于阅读体验'),
        h(
          'p',
          { style: { fontSize: 'var(--fs-sm)', color: 'var(--ink-500)', lineHeight: '1.8' } },
          '教材文件托管在 GitHub，本站通过多条镜像线路按需分段读取，因此大部分书能在几秒内翻开第一页，无需等待整本下载。',
          h('br'),
          '若某本书加载缓慢或失败，可在右上角「线路」中切换镜像，或填入你自己的加速前缀。',
          when ? h('span.dot-sep', `索引更新于 ${when}`) : null
        )
      )
    )
  );
}
