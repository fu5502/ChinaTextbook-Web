/* ============================================================
   browse.js — 浏览 / 筛选 / 搜索结果 / 收藏夹
   学段感知的动态维度：未选学段只给学段入口，选定后逐级展开
   ============================================================ */

import { h, icon, fmtNum, clear, debounce } from '../util.js';
import {
  books,
  facet,
  filterBooks,
  sortBooks,
  DIMENSIONS,
  DIM_LABEL,
  getBook,
} from '../catalog.js';
import { search } from '../search.js';
import { favorites, prefs, onStorageChange } from '../storage.js';
import { build, replaceQuery, go } from '../router.js';
import { bookCard } from './bookcard.js';

const IC_FILTER = '<path d="M3 5h18M6.5 12h11M10.5 19h3"/>';
const IC_GRID = '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>';
const IC_LIST = '<path d="M4 6h16M4 12h16M4 18h16"/>';
const IC_EMPTY = '<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4H19v16H6.5A2.5 2.5 0 0 0 4 22.5v-16z"/><path d="M9 10h6M9 14h4"/>';
const IC_X = '<path d="M6 6l12 12M18 6L6 18"/>';
const IC_HEART = '<path d="M12 21s-7.5-4.7-9.3-9A5.3 5.3 0 0 1 12 6.6 5.3 5.3 0 0 1 21.3 12c-1.8 4.3-9.3 9-9.3 9z"/>';

const DIM_KEYS = ['stage', 'subject', 'edition', 'grade', 'module', 'vol'];
const PAGE_SIZE = 60;
const COLLAPSE_AT = 8;

let unsubscribe = null;

/* ================= 入口：浏览页 ================= */

export function renderBrowse(app, route) {
  cleanup();
  const cond = readCond(route.query);
  const sort = route.query.sort || 'default';

  const state = {
    cond,
    sort,
    expanded: new Set(),
    shown: PAGE_SIZE,
    viewMode: prefs.get('viewMode') || 'grid',
  };

  const panel = h('aside.filter-panel', { id: 'filter-panel' });
  const results = h('div');
  const backdrop = h('div.drawer-backdrop', {
    onclick: () => {
      panel.classList.remove('open');
      backdrop.classList.remove('show');
    },
  });

  const page = h(
    'div.page',
    breadcrumbs(state.cond),
    h('div.browse-layout', panel, results)
  );
  app.append(page, backdrop);

  const rerender = () => {
    renderFilters(panel, state, apply);
    renderResults(results, state, apply, { panel, backdrop });
  };

  function apply(patch, opts = {}) {
    Object.assign(state, patch);
    if (patch.cond) {
      state.shown = PAGE_SIZE;
      replaceQuery('browse', { ...state.cond, sort: state.sort === 'default' ? '' : state.sort });
      const crumb = page.querySelector('.crumbs');
      crumb?.replaceWith(breadcrumbs(state.cond));
    } else if (patch.sort !== undefined) {
      state.shown = PAGE_SIZE;
      replaceQuery('browse', { ...state.cond, sort: state.sort === 'default' ? '' : state.sort });
    }
    if (opts.resultsOnly) renderResults(results, state, apply, { panel, backdrop });
    else rerender();
    if (opts.scrollTop) window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  rerender();
  unsubscribe = onStorageChange(
    debounce(() => {
      /* 收藏态由卡片自身维护，无需整页重绘 */
    }, 300)
  );
}

/* ================= 搜索结果页 ================= */

export function renderSearch(app, route) {
  cleanup();
  const q = route.query.q || '';
  const { list, total, terms } = search(q, books());

  const page = h(
    'div.page',
    h(
      'div.page-head',
      h('h1.page-title', '搜索结果'),
      h(
        'p.page-desc',
        q ? ['关键词 ', h('strong', q), ` · 命中 ${fmtNum(total || 0)} 册`] : '请输入关键词'
      )
    )
  );

  if (!q) {
    page.append(emptyState('输入关键词开始搜索', '可以搜书名、学科、版本、年级，例如「北师大版 数学 八年级」'));
  } else if (!list.length) {
    page.append(
      emptyState(
        '没有找到相关教材',
        '试试减少关键词，或换个说法。例如把「人民教育出版社」简写为「人教版」。'
      ),
      h(
        'div',
        { style: { textAlign: 'center', marginTop: 'calc(-1 * var(--sp-5))' } },
        h('a.btn', { href: '#/browse' }, '按学段浏览全部教材')
      )
    );
  } else {
    if (total > list.length) {
      page.append(
        h(
          'p.result-count',
          { style: { marginBottom: 'var(--sp-4)' } },
          `显示相关度最高的 ${list.length} 条，共 ${fmtNum(total)} 条匹配`
        )
      );
    }
    page.append(h('div.book-grid', list.map((b) => bookCard(b, { terms, showStage: true }))));
  }

  app.append(page);
}

/* ================= 收藏夹页 ================= */

export function renderFavorites(app) {
  cleanup();
  const render = () => {
    const list = favorites.all().map(getBook).filter(Boolean);
    const page = h(
      'div.page',
      h(
        'div.page-head',
        h('h1.page-title', '我的收藏'),
        h('p.page-desc', list.length ? `共 ${list.length} 册 · 保存在本机浏览器中` : '')
      )
    );
    if (!list.length) {
      page.append(
        emptyState('还没有收藏任何教材', '在书卡右上角点击 ♡ 即可收藏，数据保存在本机，不上传服务器。'),
        h('div', { style: { textAlign: 'center', marginTop: 'calc(-1 * var(--sp-5))' } }, h('a.btn.btn-primary', { href: '#/browse' }, '去挑几本'))
      );
    } else {
      page.append(
        h(
          'div.result-head',
          h('span.result-count', h('b', String(list.length)), ' 册'),
          h(
            'div.result-tools',
            h(
              'button.btn.btn-sm',
              {
                type: 'button',
                onclick: () => {
                  if (confirm('确定清空全部收藏吗？此操作不可撤销。')) {
                    favorites.clear();
                    clear(app);
                    render();
                  }
                },
              },
              '清空收藏'
            )
          )
        ),
        h('div.book-grid', list.map((b) => bookCard(b, { showStage: true, onFav: () => setTimeout(() => { clear(app); render(); }, 260) })))
      );
    }
    app.append(page);
  };
  render();
}

/* ================= 筛选栏 ================= */

function renderFilters(panel, state, apply) {
  clear(panel);
  const { cond } = state;

  panel.append(
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', marginBottom: 'var(--sp-3)' } },
      h('h4', { style: { margin: 0, fontSize: 'var(--fs-xs)', letterSpacing: '.08em', color: 'var(--ink-400)' } }, '筛选'),
      h(
        'button.btn.btn-ghost.btn-icon.btn-sm',
        {
          type: 'button',
          'aria-label': '关闭筛选',
          style: { marginLeft: 'auto' },
          onclick: () => {
            panel.classList.remove('open');
            document.querySelector('.drawer-backdrop')?.classList.remove('show');
          },
        },
        icon(IC_X)
      )
    )
  );

  // 学段永远第一维
  panel.append(dimGroup('stage', cond, state, apply));

  // 选定学段后展开该学段的维度链
  const dims = cond.stage ? DIMENSIONS[cond.stage] ?? ['subject', 'edition', 'grade', 'vol'] : null;

  if (!dims) {
    panel.append(
      h(
        'div.filter-group',
        h(
          'p',
          { style: { fontSize: 'var(--fs-sm)', color: 'var(--ink-400)', lineHeight: '1.7' } },
          '先选择一个学段，再按学科、版本、年级逐级筛选。'
        ),
        cond.subject
          ? h(
              'div',
              { style: { marginTop: 'var(--sp-3)' } },
              h('h4', '当前学科'),
              h('div.filter-options', h('div.chip', cond.subject, h('button.x', { type: 'button', 'aria-label': '移除', onclick: () => apply({ cond: { ...cond, subject: null } }) }, icon(IC_X, '', 12))))
            )
          : null
      )
    );
  } else {
    for (const d of dims) panel.append(dimGroup(d, cond, state, apply));
  }
}

function dimGroup(dim, cond, state, apply) {
  const options = facet(cond, dim);
  if (!options.length) return h('div', { hidden: true });

  const selected = cond[dim];
  const key = `dim:${dim}`;
  const expanded = state.expanded.has(key);
  const overflow = options.length > COLLAPSE_AT + 2;
  const visible = overflow && !expanded ? options.slice(0, COLLAPSE_AT) : options;

  // 被选中项若在折叠区之外，强制显示
  if (selected && !visible.some((o) => o.value === selected)) {
    const sel = options.find((o) => o.value === selected);
    if (sel) visible.unshift(sel);
  }

  const note =
    dim === 'module' ? h('span.note', '（高中按模块划分）') : dim === 'vol' && cond.stage === '高中' ? null : null;

  return h(
    'div.filter-group',
    h(
      'h4',
      DIM_LABEL[dim] || dim,
      note,
      selected
        ? h(
            'button',
            {
              type: 'button',
              style: { marginLeft: 'auto', fontSize: 'var(--fs-xs)', color: 'var(--brand-600)', fontWeight: '400', letterSpacing: '0' },
              onclick: () => apply({ cond: clearFrom(cond, dim) }),
            },
            '重置'
          )
        : null
    ),
    h(
      'div.filter-options',
      visible.map((o) =>
        h(
          'button.filter-opt',
          {
            type: 'button',
            'aria-pressed': String(selected === o.value),
            disabled: o.count === 0,
            onclick: () =>
              apply({
                cond: selected === o.value ? clearFrom(cond, dim) : { ...cond, [dim]: o.value },
              }),
          },
          h('span.label', { title: o.value }, o.value),
          h('span.n', fmtNum(o.count))
        )
      )
    ),
    overflow
      ? h(
          'button.filter-more',
          {
            type: 'button',
            onclick: () => {
              if (expanded) state.expanded.delete(key);
              else state.expanded.add(key);
              apply({});
            },
          },
          expanded ? '收起' : `展开全部 ${options.length} 项`
        )
      : null
  );
}

/** 清除某维度及其下游维度（选了新学段就不该保留旧年级） */
function clearFrom(cond, dim) {
  const next = { ...cond, [dim]: null };
  if (dim === 'stage') return { stage: null };
  const order = DIM_KEYS;
  const i = order.indexOf(dim);
  for (let j = i + 1; j < order.length; j++) next[order[j]] = null;
  return next;
}

/* ================= 结果区 ================= */

function renderResults(container, state, apply, refs) {
  clear(container);
  const { cond, sort } = state;
  const filtered = filterBooks(cond);
  const sorted = sortBooks(filtered, sort);
  const shown = sorted.slice(0, state.shown);

  // 已选条件 chips
  const activeDims = DIM_KEYS.filter((d) => cond[d]);
  if (activeDims.length) {
    container.append(
      h(
        'div.active-filters',
        activeDims.map((d) =>
          h(
            'span.chip',
            `${DIM_LABEL[d]}：${cond[d]}`,
            h(
              'button.x',
              { type: 'button', 'aria-label': `移除 ${cond[d]}`, onclick: () => apply({ cond: clearFrom(cond, d) }) },
              icon(IC_X, '', 12)
            )
          )
        ),
        activeDims.length > 1
          ? h('button.clear-all', { type: 'button', onclick: () => apply({ cond: {} }) }, '清空全部')
          : null
      )
    );
  }

  // 结果头
  container.append(
    h(
      'div.result-head',
      h(
        'button.btn.btn-sm.filter-toggle',
        {
          type: 'button',
          onclick: () => {
            refs.panel.classList.add('open');
            refs.backdrop.classList.add('show');
          },
        },
        icon(IC_FILTER),
        '筛选'
      ),
      h('span.result-count', h('b', fmtNum(filtered.length)), ' 册教材'),
      h(
        'div.result-tools',
        sortSelect(sort, (v) => apply({ sort: v }, { resultsOnly: true })),
        viewToggle(state, apply)
      )
    )
  );

  if (!filtered.length) {
    container.append(
      emptyState('该条件下暂无教材', '试试放宽筛选条件，或从左侧重新选择学段。'),
      h(
        'div',
        { style: { textAlign: 'center', marginTop: 'calc(-1 * var(--sp-5))' } },
        h('button.btn', { type: 'button', onclick: () => apply({ cond: {} }) }, '清空筛选条件')
      )
    );
    return;
  }

  const grid = h(
    `div.book-grid${state.viewMode === 'list' ? '.list-mode' : ''}`,
    shown.map((b) => bookCard(b, { showStage: !cond.stage }))
  );
  container.append(grid);

  // 加载更多
  if (sorted.length > state.shown) {
    const remain = sorted.length - state.shown;
    const btn = h(
      'button.btn.btn-lg',
      {
        type: 'button',
        style: { display: 'block', margin: 'var(--sp-6) auto 0' },
        onclick: () => {
          state.shown += PAGE_SIZE;
          renderResults(container, state, apply, refs);
        },
      },
      `加载更多（还有 ${fmtNum(remain)} 册）`
    );
    container.append(btn);

    // 滚动到底自动加载
    const sentinel = h('div', { style: { height: '1px' } });
    container.append(sentinel);
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          io.disconnect();
          state.shown += PAGE_SIZE;
          renderResults(container, state, apply, refs);
        }
      },
      { rootMargin: '600px' }
    );
    io.observe(sentinel);
  }
}

function sortSelect(current, onChange) {
  const opts = [
    ['default', '默认排序'],
    ['title', '按书名'],
    ['size-asc', '体积从小到大'],
    ['size-desc', '体积从大到小'],
  ];
  const sel = h(
    'select.input',
    {
      style: { width: 'auto', height: '30px', fontSize: 'var(--fs-sm)', paddingRight: 'var(--sp-2)' },
      'aria-label': '排序方式',
      onchange: (e) => onChange(e.target.value),
    },
    opts.map(([v, t]) => h('option', { value: v, selected: v === current }, t))
  );
  return sel;
}

function viewToggle(state, apply) {
  const set = (mode) => {
    if (state.viewMode === mode) return;
    prefs.set('viewMode', mode);
    apply({ viewMode: mode }, { resultsOnly: true });
  };
  return h(
    'div.segmented',
    { role: 'group', 'aria-label': '视图切换' },
    h('button', { type: 'button', 'aria-pressed': String(state.viewMode === 'grid'), 'aria-label': '网格视图', title: '网格', onclick: () => set('grid') }, icon(IC_GRID, 'ico', 14)),
    h('button', { type: 'button', 'aria-pressed': String(state.viewMode === 'list'), 'aria-label': '列表视图', title: '列表', onclick: () => set('list') }, icon(IC_LIST, 'ico', 14))
  );
}

/* ================= 公共片段 ================= */

function breadcrumbs(cond) {
  const items = [h('a', { href: '#/' }, '首页')];
  const push = (label, condPatch) => {
    items.push(h('span.sep', '/'));
    items.push(condPatch ? h('a', { href: build('browse', condPatch) }, label) : h('span', label));
  };
  if (cond.stage) push(cond.stage, { stage: cond.stage });
  else push('全部教材', null);
  if (cond.subject) push(cond.subject, { stage: cond.stage, subject: cond.subject });
  if (cond.edition) push(cond.edition, { stage: cond.stage, subject: cond.subject, edition: cond.edition });
  if (cond.grade) push(cond.grade, null);
  return h('nav.crumbs', { 'aria-label': '面包屑' }, items);
}

export function emptyState(title, desc, isError = false) {
  return h(
    `div.state${isError ? '.state-error' : ''}`,
    icon(isError ? '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/>' : IC_EMPTY, '', 56),
    h('h3', title),
    desc ? h('p', desc) : null
  );
}

function readCond(query) {
  const cond = {};
  for (const k of DIM_KEYS) if (query[k]) cond[k] = query[k];
  return cond;
}

function cleanup() {
  unsubscribe?.();
  unsubscribe = null;
}
