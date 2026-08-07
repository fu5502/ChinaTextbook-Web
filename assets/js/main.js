/* ============================================================
   main.js — 应用入口
   1. 加载索引（catalog.json）
   2. 注册路由
   3. 挂载顶栏搜索 / 线路切换 / 移动端交互
   ============================================================ */

import { h, icon, $, clear, fmtNum, fmtSize, debounce, onClickOutside, topProgress } from './util.js';
import { loadCatalog, books, meta } from './catalog.js';
import * as router from './router.js';
import { renderHome } from './ui/home.js';
import { renderBrowse, renderSearch, renderFavorites, emptyState } from './ui/browse.js';
import { renderDetail } from './ui/detail.js';
import { skeletonGrid } from './ui/bookcard.js';
import { toast } from './ui/toast.js';
import { prefs, isPersistent } from './storage.js';
import {
  allSources,
  probeAll,
  cachedSpeeds,
  currentSourceLabel,
  onSourcesChange,
  notifySourcesChanged,
  CUSTOM_ID,
} from './sources.js';

const app = $('#app');

const IC_CHECK = '<path d="M20 6.5L9.5 17 4 11.5"/>';
const IC_REFRESH = '<path d="M20 11a8 8 0 1 0-.6 4"/><path d="M20 5v6h-6"/>';
const IC_WARN = '<path d="M12 3.5l9 16H3l9-16z"/><path d="M12 9.5v4.5M12 17v.01"/>';

/* ================================================================
   启动
   ================================================================ */

boot();

async function boot() {
  renderBootSkeleton();
  topProgress.start();

  try {
    await loadCatalog();
  } catch (err) {
    topProgress.done();
    renderBootError(err);
    return;
  }
  topProgress.done();

  setupRoutes();
  setupHeaderSearch();
  setupSourceDropdown();
  setupFooter();
  setupResponsive();

  router.start();

  // 后台静默测速，不阻塞首屏
  setTimeout(() => {
    probeAll().catch(() => {});
  }, 1200);

  if (!isPersistent()) {
    setTimeout(
      () => toast('浏览器禁用了本地存储，收藏与阅读进度仅在本次会话有效', 'warn', 5200),
      2400
    );
  }
}

function renderBootSkeleton() {
  clear(app);
  app.append(
    h(
      'div.page',
      h('div.skeleton', { style: 'height:34px;width:220px;margin-bottom:22px;border-radius:8px' }),
      skeletonGrid(12)
    )
  );
}

function renderBootError(err) {
  clear(app);
  console.error('[boot]', err);
  const retry = h(
    'button.btn.btn-primary',
    { type: 'button', style: 'margin-top:18px', onclick: () => location.reload() },
    '重新加载'
  );
  const box = emptyState(
    '教材索引加载失败',
    '请检查网络连接后重试。若你是通过 file:// 直接打开本页，请改用本地静态服务器（浏览器安全策略禁止 file 协议下的数据请求）。',
    true
  );
  box.append(h('p', { style: 'margin-top:6px;font-size:13px;color:var(--ink-400)' }, String(err && err.message ? err.message : err)), retry);
  app.append(h('div.page', box));
}

/* ================================================================
   路由
   ================================================================ */

const TITLE = '中国教材开放资源库';
let disposeReader = null;

function setupRoutes() {
  router.onBeforeEach((route, prev) => {
    // 离开阅读器 → 释放 PDF 资源
    if (prev && prev.name === 'read' && route.name !== 'read') {
      try {
        disposeReader?.();
      } catch (e) {
        console.error(e);
      }
      disposeReader = null;
    }

    // 切换页面时清空主容器；阅读器内部会自行接管并先渲染 loading
    clear(app);

    document.body.classList.toggle('reading', route.name === 'read');
    closeMobileSearch();
    closeDropdown();
    syncSearchInput(route);
    setTitle(route);

    // 仅在「页面」变化时回到顶部；同页改筛选参数不打断阅读位置
    const samePage =
      prev && prev.name === route.name && prev.parts.join('/') === route.parts.join('/');
    if (!samePage) window.scrollTo({ top: 0, behavior: 'instant' in document.body.style ? 'instant' : 'auto' });
  });

  router.register('home', () => renderHome(app));
  router.register('browse', (route) => renderBrowse(app, route));
  router.register('search', (route) => renderSearch(app, route));
  router.register('favorites', () => renderFavorites(app));
  router.register('book', (route) => renderDetail(app, route));
  router.register('read', (route) => openReader(route));

  router.setNotFound((route) => {
    clear(app);
    const back = h(
      'a.btn.btn-primary',
      { href: '#/', style: 'margin-top:18px' },
      '返回首页'
    );
    const box = emptyState('页面不存在', `找不到路径 ${route.raw || location.hash}`, true);
    box.append(back);
    app.append(h('div.page', box));
  });
}

function setTitle(route) {
  const q = route.query || {};
  let t = TITLE;
  switch (route.name) {
    case 'browse':
      t = [q.grade, q.edition, q.subject, q.stage].filter(Boolean).join(' · ') || '全部教材';
      t = `${t} · ${TITLE}`;
      break;
    case 'search':
      t = q.q ? `搜索「${q.q}」· ${TITLE}` : `搜索 · ${TITLE}`;
      break;
    case 'favorites':
      t = `我的收藏 · ${TITLE}`;
      break;
    case 'book':
    case 'read': {
      const b = books().find((x) => x.id === route.parts[0]);
      t = b ? `${b.title} · ${TITLE}` : TITLE;
      break;
    }
    default:
      t = `${TITLE} · 免费公益 · 免登录在线阅读`;
  }
  document.title = t;
}

/** 阅读器按需加载，首屏不为 pdf.js 付费 */
async function openReader(route) {
  clear(app);
  app.append(
    h(
      'div.reader-boot',
      h('div.spinner', { 'aria-hidden': 'true' }),
      h('p', '正在启动阅读器…')
    )
  );
  topProgress.start();
  try {
    const mod = await import('./reader/reader.js');
    topProgress.done();
    if (router.getCurrent()?.name !== 'read') return; // 已经跳走了
    disposeReader = await mod.renderReader(app, route);
  } catch (err) {
    topProgress.done();
    console.error('[reader]', err);
    clear(app);
    const back = h(
      'a.btn.btn-primary',
      { href: `#/book/${route.parts[0] || ''}`, style: 'margin-top:18px' },
      '返回详情页'
    );
    const box = emptyState('阅读器加载失败', String(err && err.message ? err.message : err), true);
    box.append(back);
    app.append(h('div.page', box));
  }
}

/* ================================================================
   顶栏搜索
   ================================================================ */

function setupHeaderSearch() {
  const box = $('#header-search');
  const input = $('#q');
  const clearBtn = box?.querySelector('.clear');
  if (!input) return;

  const syncClear = () => {
    if (clearBtn) clearBtn.style.display = input.value ? '' : 'none';
  };
  syncClear();

  const submit = () => {
    const v = input.value.trim();
    if (!v) {
      input.focus();
      return;
    }
    input.blur();
    router.go(router.build('search', { q: v }));
  };

  // 在搜索页时输入即时过滤（不产生历史记录）
  const live = debounce(() => {
    const cur = router.getCurrent();
    if (!cur || cur.name !== 'search') return;
    const v = input.value.trim();
    router.replaceQuery('search', { q: v });
    renderSearch(app, router.getCurrent());
  }, 260);

  input.addEventListener('input', () => {
    syncClear();
    live();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      input.value = '';
      syncClear();
      input.blur();
      closeMobileSearch();
    }
  });

  clearBtn?.addEventListener('click', () => {
    input.value = '';
    syncClear();
    input.focus();
    live();
  });

  // 移动端搜索开关
  $('#btn-mobile-search')?.addEventListener('click', () => {
    const open = box.classList.toggle('mobile-open');
    if (open) input.focus();
  });

  // 全局快捷键： / 或 Ctrl/⌘+K 聚焦搜索
  document.addEventListener('keydown', (e) => {
    const tag = (e.target?.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || e.target?.isContentEditable;
    if ((e.key === '/' && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) {
      e.preventDefault();
      box?.classList.add('mobile-open');
      input.focus();
      input.select();
    }
  });
}

function syncSearchInput(route) {
  const input = $('#q');
  if (!input) return;
  const want = route.name === 'search' ? route.query.q || '' : '';
  if (document.activeElement === input) return; // 别打断用户正在输入
  if (input.value !== want) {
    input.value = want;
    const btn = $('#header-search')?.querySelector('.clear');
    if (btn) btn.style.display = want ? '' : 'none';
  }
}

function closeMobileSearch() {
  $('#header-search')?.classList.remove('mobile-open');
}

/* ================================================================
   线路切换下拉
   ================================================================ */

let ddCleanup = null;

function setupSourceDropdown() {
  const dd = $('#source-dd');
  const btn = $('#source-btn');
  const panel = $('#source-panel');
  if (!dd || !btn || !panel) return;

  const refreshLabel = () => {
    const el = $('#source-name');
    if (el) el.textContent = currentSourceLabel();
  };
  refreshLabel();
  onSourcesChange(() => {
    refreshLabel();
    if (dd.classList.contains('open')) renderSourcePanel(panel);
  });

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = !dd.classList.contains('open');
    dd.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', String(open));
    if (open) {
      renderSourcePanel(panel);
      ddCleanup = onClickOutside(dd, closeDropdown);
      // 打开即测速（有缓存则直接用）
      probeAll().then(() => {
        if (dd.classList.contains('open')) renderSourcePanel(panel);
      });
    } else {
      closeDropdown();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDropdown();
  });
}

function closeDropdown() {
  const dd = $('#source-dd');
  if (!dd) return;
  dd.classList.remove('open');
  $('#source-btn')?.setAttribute('aria-expanded', 'false');
  ddCleanup?.();
  ddCleanup = null;
}

function speedBadge(ms) {
  if (ms == null) return h('span.dd-speed.bad', '不可用');
  const cls = ms < 400 ? 'good' : ms < 1200 ? 'mid' : 'slow';
  return h(`span.dd-speed.${cls}`, `${ms}ms`);
}

function renderSourcePanel(panel) {
  const cur = prefs.get('source') || 'auto';
  const speeds = cachedSpeeds();
  clear(panel);

  const pick = (id) => {
    prefs.set('source', id);
    notifySourcesChanged();
    renderSourcePanel(panel);
    toast(
      id === 'auto' ? '已切换为自动选路' : `已锁定线路：${allSources().find((s) => s.id === id)?.name || id}`,
      'ok'
    );
  };

  panel.append(h('div.dropdown-label', '阅读 / 下载线路'));

  panel.append(
    h(
      'button.dropdown-item',
      {
        type: 'button',
        role: 'option',
        'aria-selected': String(cur === 'auto'),
        onclick: () => pick('auto'),
      },
      h('span.dd-main', h('b', '自动选路'), h('small', '按实测延迟与文件大小挑选')),
      cur === 'auto' ? icon(IC_CHECK, 'ico dd-check', 16) : null
    )
  );

  panel.append(h('div.dropdown-sep'));

  for (const s of allSources()) {
    const ms = speeds[s.id];
    panel.append(
      h(
        'button.dropdown-item',
        {
          type: 'button',
          role: 'option',
          'aria-selected': String(cur === s.id),
          onclick: () => pick(s.id),
        },
        h('span.dd-main', h('b', s.name), h('small', s.note)),
        h('span.dd-right', speedBadge(ms), cur === s.id ? icon(IC_CHECK, 'ico dd-check', 16) : null)
      )
    );
  }

  panel.append(h('div.dropdown-sep'));

  panel.append(
    h(
      'button.dropdown-item.dd-action',
      {
        type: 'button',
        onclick: async (e) => {
          const b = e.currentTarget;
          b.disabled = true;
          b.querySelector('b').textContent = '测速中…';
          try {
            await probeAll(true);
          } catch {
            /* ignore */
          }
          renderSourcePanel(panel);
        },
      },
      h('span.dd-main', h('b', '重新测速')),
      icon(IC_REFRESH, 'ico', 16)
    )
  );

  // 自定义线路
  const inp = h('input.input.input-sm', {
    type: 'text',
    placeholder: '自定义代理前缀，如 https://my.proxy/',
    value: prefs.get('customSource') || '',
    onkeydown: (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        save();
      }
      e.stopPropagation();
    },
  });
  const save = () => {
    const v = inp.value.trim();
    prefs.set('customSource', v);
    if (v && prefs.get('source') !== CUSTOM_ID) prefs.set('source', CUSTOM_ID);
    if (!v && prefs.get('source') === CUSTOM_ID) prefs.set('source', 'auto');
    notifySourcesChanged();
    renderSourcePanel(panel);
    toast(v ? '自定义线路已保存' : '已清除自定义线路', 'ok');
  };

  panel.append(
    h(
      'div.dd-custom',
      h('div.dropdown-label', { style: 'padding-left:0' }, '自定义线路（可选）'),
      inp,
      h(
        'div.dd-custom-row',
        h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: save }, '保存'),
        h(
          'small',
          '前缀 + 文件 raw 地址。留空则关闭。'
        )
      )
    )
  );

  panel.append(
    h(
      'div.dd-tip',
      icon(IC_WARN, 'ico', 14),
      h('span', 'jsDelivr 系线路不支持 20MB 以上文件，大部头教材会自动改走代理线路。')
    )
  );
}

/* ================================================================
   页脚 / 响应式
   ================================================================ */

function setupFooter() {
  const el = $('#footer-stat');
  if (!el) return;
  const all = books();
  const m = meta() || {};
  const total = all.reduce((a, b) => a + b.size, 0);
  const date = m.generatedAt ? String(m.generatedAt).slice(0, 10) : '';
  el.textContent = `收录 ${fmtNum(all.length)} 册 · ${fmtSize(total)}${date ? ` · 索引更新于 ${date}` : ''}`;
}

function setupResponsive() {
  const mq = window.matchMedia('(max-width: 520px)');
  const btn = $('#btn-mobile-search');
  const apply = () => {
    if (btn) btn.hidden = !mq.matches;
    if (!mq.matches) closeMobileSearch();
  };
  apply();
  mq.addEventListener('change', apply);
}

/* 全局错误兜底：避免白屏静默 */
window.addEventListener('unhandledrejection', (e) => {
  console.error('[unhandled]', e.reason);
});
