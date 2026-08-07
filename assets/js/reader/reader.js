/* ============================================================
   reader.js — PDF 阅读器
   PDFViewer + 自定义 Range 传输层，按需拉取，不整包下载
   ============================================================ */

import { h, icon, $, fmtSize, debounce, clear } from '../util.js';
import { getBook, isVolume } from '../catalog.js';
import { favorites, progress, recent, prefs } from '../storage.js';
import { build, go } from '../router.js';
import { downloadBook } from '../download.js';
import { toast, toastError } from '../ui/toast.js';
import { loadPdfjs, docParams } from './loader.js';
import { createTransport } from './transport.js';
import { createThumbs } from './thumbs.js';
import { renderOutline } from './outline.js';

/* ---------------- 图标 ---------------- */
const IC_BACK = '<path d="M19 12H5M11 6l-6 6 6 6"/>';
const IC_SIDE = '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M9.5 4.5v15"/>';
const IC_UP = '<path d="M6 15l6-6 6 6"/>';
const IC_DOWN_C = '<path d="M6 9l6 6 6-6"/>';
const IC_MINUS = '<path d="M5 12h14"/>';
const IC_PLUS = '<path d="M12 5v14M5 12h14"/>';
const IC_ROTATE = '<path d="M20 11a8 8 0 1 0-.6 4"/><path d="M20 5v6h-6"/>';
const IC_SCROLL = '<rect x="4.5" y="3.5" width="15" height="7" rx="1.5"/><rect x="4.5" y="13.5" width="15" height="7" rx="1.5"/>';
const IC_SPREAD = '<rect x="3.5" y="4.5" width="7.5" height="15" rx="1.5"/><rect x="13" y="4.5" width="7.5" height="15" rx="1.5"/>';
const IC_MOON = '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>';
const IC_FULL = '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>';
const IC_DL = '<path d="M12 3v13"/><path d="M7 11.5l5 5 5-5"/><path d="M4 21h16"/>';
const IC_HEART = '<path d="M12 21s-7.5-4.7-9.3-9A5.3 5.3 0 0 1 12 6.6 5.3 5.3 0 0 1 21.3 12c-1.8 4.3-9.3 9-9.3 9z"/>';
const IC_THUMB = '<rect x="3.5" y="3.5" width="7" height="7" rx="1"/><rect x="13.5" y="3.5" width="7" height="7" rx="1"/><rect x="3.5" y="13.5" width="7" height="7" rx="1"/><rect x="13.5" y="13.5" width="7" height="7" rx="1"/>';
const IC_LIST = '<path d="M4 6h16M4 12h16M4 18h10"/>';
const IC_X = '<path d="M6 6l12 12M18 6L6 18"/>';

const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

/**
 * @returns {Promise<Function>} dispose
 */
export async function renderReader(app, route) {
  const id = route.parts[0];
  const book = getBook(id);

  if (!book) {
    clear(app);
    app.append(
      h(
        'div.page',
        h(
          'div.state.state-error',
          h('h3', '未找到这本教材'),
          h('p', '链接可能已失效'),
          h('a.btn.btn-primary', { href: '#/', style: 'margin-top:18px' }, '返回首页')
        )
      )
    );
    return () => {};
  }

  /* ============ DOM 骨架 ============ */

  const ui = buildShell(book);
  clear(app);
  app.append(ui.root);

  /* ============ 状态 ============ */

  const state = {
    night: !!prefs.get('night'),
    sidebar: prefs.get('sidebarOpen') !== false,
    tab: 'thumbs',
    pages: 0,
    page: 1,
    disposed: false,
  };
  applyNight(ui, state.night);
  applySidebar(ui, state.sidebar);

  let transport = null;
  let loadingTask = null;
  let pdf = null;
  let pdfViewer = null;
  let thumbs = null;
  let outlineLoaded = false;
  const abort = new AbortController();

  const dispose = () => {
    if (state.disposed) return;
    state.disposed = true;
    abort.abort();
    try {
      thumbs?.destroy();
    } catch (e) {
      console.warn(e);
    }
    try {
      transport?.abort();
    } catch (e) {
      console.warn(e);
    }
    try {
      loadingTask?.destroy();
    } catch (e) {
      console.warn(e);
    }
    try {
      pdfViewer?.setDocument(null);
    } catch (e) {
      console.warn(e);
    }
    pdf = null;
    pdfViewer = null;
    document.removeEventListener('keydown', onKey);
  };

  /* ============ 加载 ============ */

  ui.setStatus(`正在建立连接… ${fmtSize(book.size)}${isVolume(book) ? ` · ${book.parts.length} 个分卷` : ''}`);

  let lib;
  let viewerNs;
  try {
    ({ lib, viewer: viewerNs } = await loadPdfjs());
  } catch (err) {
    ui.fail('阅读器内核加载失败', err.message, book);
    return dispose;
  }
  if (state.disposed) return dispose;

  try {
    transport = await createTransport(book, {
      onStatus: ({ loaded, requests, source }) => {
        ui.setNet(`${source ? source.name : ''} · 已读取 ${fmtSize(loaded)} / ${requests} 段`);
      },
      onFatal: (err) => {
        if (!state.disposed) toastError(`读取中断：${err.message}`);
      },
    });
  } catch (err) {
    ui.fail('无法初始化数据通道', err.message, book);
    return dispose;
  }
  if (state.disposed) return dispose;

  const { EventBus, PDFLinkService, PDFViewer, ScrollMode, SpreadMode } = viewerNs;

  const eventBus = new EventBus();
  const linkService = new PDFLinkService({ eventBus, externalLinkTarget: 2 });

  pdfViewer = new PDFViewer({
    container: ui.container,
    viewer: ui.viewer,
    eventBus,
    linkService,
    textLayerMode: 1,
    annotationMode: 0, // 教材是扫描件，关掉表单/注释层省内存
    removePageBorders: false,
    maxCanvasPixels: 16 * 1024 * 1024,
  });
  linkService.setViewer(pdfViewer);

  ui.setStatus('正在解析文档结构…');

  try {
    loadingTask = lib.getDocument(docParams({ range: transport }));
    loadingTask.onPassword = () => {
      throw new Error('该文件被密码保护');
    };
    pdf = await loadingTask.promise;
  } catch (err) {
    if (state.disposed) return dispose;
    console.error('[reader] getDocument', err);
    ui.fail(
      '文档打开失败',
      `${err.message || err}。可尝试在右上角切换线路后重试，或直接下载后用本地阅读器打开。`,
      book
    );
    return dispose;
  }
  if (state.disposed) {
    pdf.destroy?.();
    return dispose;
  }

  state.pages = pdf.numPages;
  ui.total.textContent = String(state.pages);
  ui.pageInput.max = String(state.pages);

  pdfViewer.setDocument(pdf);
  linkService.setDocument(pdf, null);

  /* ============ 事件 ============ */

  const saveProgress = debounce(() => {
    if (state.disposed || !state.pages) return;
    progress.set(book.id, { page: state.page, pages: state.pages });
    recent.touch(book.id, state.page, state.pages);
  }, 900);

  eventBus.on('pagesinit', () => {
    ui.hideOverlay();

    // 视图模式沿用上次
    const sm = Number(prefs.get('scrollMode'));
    const sp = Number(prefs.get('spreadMode'));
    if (Number.isInteger(sm) && sm >= 0) pdfViewer.scrollMode = sm;
    if (Number.isInteger(sp) && sp >= 0) pdfViewer.spreadMode = sp;
    pdfViewer.currentScaleValue = 'page-width';

    const want = initialPage(route, book, state.pages);
    if (want > 1) {
      pdfViewer.currentPageNumber = want;
      toast(`已跳到第 ${want} 页`, 'info', 1800);
    }
    syncScrollBtn(ui, pdfViewer, ScrollMode, SpreadMode);

    // 缩略图：文档就绪后再建，避免和首屏渲染抢资源
    setTimeout(() => {
      if (state.disposed || thumbs) return;
      thumbs = createThumbs(ui.thumbHost, pdf, {
        onJump: (n) => {
          pdfViewer.currentPageNumber = n;
        },
      });
      thumbs.setCurrent(pdfViewer.currentPageNumber);
    }, 300);
  });

  eventBus.on('pagechanging', (e) => {
    state.page = e.pageNumber;
    if (document.activeElement !== ui.pageInput) ui.pageInput.value = String(e.pageNumber);
    thumbs?.setCurrent(e.pageNumber);
    saveProgress();
  });

  eventBus.on('scalechanging', () => {
    ui.zoomLabel.textContent = `${Math.round(pdfViewer.currentScale * 100)}%`;
  });

  eventBus.on('pagerendered', () => {
    ui.hideOverlay();
  });

  /* ---- 工具栏行为 ---- */

  ui.btnPrev.onclick = () => pdfViewer.previousPage();
  ui.btnNext.onclick = () => pdfViewer.nextPage();

  ui.pageInput.addEventListener('change', () => {
    const n = Math.min(Math.max(1, Number(ui.pageInput.value) || 1), state.pages);
    ui.pageInput.value = String(n);
    pdfViewer.currentPageNumber = n;
  });
  ui.pageInput.addEventListener('focus', () => ui.pageInput.select());

  const setZoom = (delta) => {
    const cur = pdfViewer.currentScale;
    const list = delta > 0 ? ZOOMS : [...ZOOMS].reverse();
    const next = list.find((z) => (delta > 0 ? z > cur + 0.001 : z < cur - 0.001));
    pdfViewer.currentScaleValue = String(next ?? cur);
  };
  ui.btnZoomOut.onclick = () => setZoom(-1);
  ui.btnZoomIn.onclick = () => setZoom(1);
  ui.zoomLabel.onclick = () => {
    pdfViewer.currentScaleValue = pdfViewer.currentScaleValue === 'page-width' ? 'page-fit' : 'page-width';
    toast(pdfViewer.currentScaleValue === 'page-fit' ? '适合整页' : '适合宽度', 'info', 1200);
  };

  ui.btnRotate.onclick = () => {
    pdfViewer.pagesRotation = (pdfViewer.pagesRotation + 90) % 360;
  };

  ui.btnScroll.onclick = () => {
    const order = [ScrollMode.VERTICAL, ScrollMode.HORIZONTAL, ScrollMode.WRAPPED, ScrollMode.PAGE];
    const i = order.indexOf(pdfViewer.scrollMode);
    const next = order[(i + 1) % order.length];
    pdfViewer.scrollMode = next;
    prefs.set('scrollMode', next);
    syncScrollBtn(ui, pdfViewer, ScrollMode, SpreadMode);
    toast(`翻页方式：${SCROLL_LABEL[next]}`, 'info', 1400);
  };

  ui.btnSpread.onclick = () => {
    const order = [SpreadMode.NONE, SpreadMode.ODD, SpreadMode.EVEN];
    const i = order.indexOf(pdfViewer.spreadMode);
    const next = order[(i + 1) % order.length];
    pdfViewer.spreadMode = next;
    prefs.set('spreadMode', next);
    syncScrollBtn(ui, pdfViewer, ScrollMode, SpreadMode);
    toast(`版式：${SPREAD_LABEL[next]}`, 'info', 1400);
  };

  ui.btnNight.onclick = () => {
    state.night = !state.night;
    prefs.set('night', state.night);
    applyNight(ui, state.night);
  };

  ui.btnFull.onclick = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await ui.root.requestFullscreen();
    } catch (e) {
      toastError('当前浏览器不支持全屏');
    }
  };

  ui.btnSide.onclick = () => {
    state.sidebar = !state.sidebar;
    prefs.set('sidebarOpen', state.sidebar);
    applySidebar(ui, state.sidebar);
    if (state.sidebar) thumbs?.setCurrent(state.page);
  };

  ui.btnDownload.onclick = async () => {
    ui.btnDownload.disabled = true;
    await downloadBook(book, (text) => {
      ui.btnDownload.title = text || '下载';
    });
    ui.btnDownload.disabled = false;
  };

  ui.btnFav.onclick = () => {
    const on = favorites.toggle(book.id);
    setFav(ui, on);
    toast(on ? '已加入收藏' : '已取消收藏', on ? 'ok' : 'info', 1500);
  };
  setFav(ui, favorites.has(book.id));

  /* ---- 侧栏标签页 ---- */

  ui.tabThumbs.onclick = () => switchTab('thumbs');
  ui.tabOutline.onclick = () => switchTab('outline');

  async function switchTab(name) {
    state.tab = name;
    ui.tabThumbs.setAttribute('aria-pressed', String(name === 'thumbs'));
    ui.tabOutline.setAttribute('aria-pressed', String(name === 'outline'));
    ui.thumbPanel.hidden = name !== 'thumbs';
    ui.outlinePanel.hidden = name !== 'outline';
    if (name === 'outline' && !outlineLoaded) {
      outlineLoaded = true;
      await renderOutline(ui.outlineHost, pdf, linkService);
    }
  }

  /* ---- 键盘 ---- */

  function onKey(e) {
    if (state.disposed) return;
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (typing) return;

    switch (e.key) {
      case 'ArrowRight':
      case 'PageDown':
      case ' ':
        if (pdfViewer.scrollMode === ScrollMode.PAGE || e.key !== ' ') {
          e.preventDefault();
          pdfViewer.nextPage();
        }
        break;
      case 'ArrowLeft':
      case 'PageUp':
        e.preventDefault();
        pdfViewer.previousPage();
        break;
      case 'Home':
        e.preventDefault();
        pdfViewer.currentPageNumber = 1;
        break;
      case 'End':
        e.preventDefault();
        pdfViewer.currentPageNumber = state.pages;
        break;
      case '+':
      case '=':
        e.preventDefault();
        setZoom(1);
        break;
      case '-':
        e.preventDefault();
        setZoom(-1);
        break;
      case '0':
        e.preventDefault();
        pdfViewer.currentScaleValue = 'page-width';
        break;
      default:
        break;
    }
  }
  document.addEventListener('keydown', onKey);

  // 离开时补一次进度落盘（debounce 可能还没触发）
  const onLeave = () => {
    if (!state.disposed && state.pages && state.page > 1) {
      progress.set(book.id, { page: state.page, pages: state.pages });
      recent.touch(book.id, state.page, state.pages);
    }
  };
  window.addEventListener('pagehide', onLeave, { signal: abort.signal });
  const origDispose = dispose;
  const wrapped = () => {
    onLeave();
    origDispose();
  };

  return wrapped;
}

/* ================================================================
   骨架构建
   ================================================================ */

const SCROLL_LABEL = { 0: '竖向连续', 1: '横向', 2: '网格', 3: '单页' };
const SPREAD_LABEL = { 0: '单页', 1: '双页（奇数起）', 2: '双页（偶数起）' };

function buildShell(book) {
  const pageInput = h('input.rd-page-input', {
    type: 'number',
    min: '1',
    value: '1',
    'aria-label': '页码',
    inputmode: 'numeric',
  });
  const total = h('span.rd-total', '–');

  const btn = (ic, title, cls = '') =>
    h(`button.rd-btn${cls}`, { type: 'button', title, 'aria-label': title }, icon(ic, 'ico', 18));

  const btnSide = btn(IC_SIDE, '侧栏');
  const btnPrev = btn(IC_UP, '上一页');
  const btnNext = btn(IC_DOWN_C, '下一页');
  const btnZoomOut = btn(IC_MINUS, '缩小');
  const btnZoomIn = btn(IC_PLUS, '放大');
  const zoomLabel = h('button.rd-zoom', { type: 'button', title: '适合宽度 / 适合整页' }, '100%');
  const btnRotate = btn(IC_ROTATE, '旋转 90°', '.opt');
  const btnScroll = btn(IC_SCROLL, '翻页方式', '.opt');
  const btnSpread = btn(IC_SPREAD, '单页 / 双页', '.opt');
  const btnNight = btn(IC_MOON, '夜间模式');
  const btnFull = btn(IC_FULL, '全屏', '.opt');
  const btnDownload = btn(IC_DL, '下载');
  const btnFav = btn(IC_HEART, '收藏');

  const tabThumbs = h(
    'button.rd-tab',
    { type: 'button', 'aria-pressed': 'true' },
    icon(IC_THUMB, 'ico', 14),
    h('span', '缩略图')
  );
  const tabOutline = h(
    'button.rd-tab',
    { type: 'button', 'aria-pressed': 'false' },
    icon(IC_LIST, 'ico', 14),
    h('span', '目录')
  );

  const thumbHost = h('div.side-panel.th-host');
  const outlineHost = h('div.ol-host');
  const outlinePanel = h('div.side-panel', { hidden: true }, outlineHost);

  // 注意：h() 的选择器语法是 tag.class#id，顺序写反会把 class 吞进 id
  const viewer = h('div.pdfViewer#viewer');
  const container = h('div.rd-container#viewerContainer', viewer);

  const statusText = h('p.rd-status', '正在准备…');
  const netText = h('p.rd-net', '');
  const overlay = h(
    'div.rd-overlay',
    h('div.rd-overlay-box', h('div.spinner'), statusText, netText)
  );

  const side = h(
    'aside.rd-side',
    h('div.rd-tabs', tabThumbs, tabOutline),
    h('div.rd-panels', thumbHost, outlinePanel)
  );

  const backdrop = h('div.rd-backdrop');

  const root = h(
    'div.reader',
    h(
      'div.rd-bar',
      h(
        'div.rd-bar-l',
        h(
          'a.rd-btn.rd-back',
          { href: build('book', {}, book.id), title: '返回详情' },
          icon(IC_BACK, 'ico', 18)
        ),
        btnSide,
        h('div.rd-title', { title: book.title }, book.title)
      ),
      h(
        'div.rd-bar-c',
        btnPrev,
        h('div.rd-pager', pageInput, h('span.rd-slash', '/'), total),
        btnNext,
        h('span.rd-div'),
        btnZoomOut,
        zoomLabel,
        btnZoomIn
      ),
      h('div.rd-bar-r', btnRotate, btnScroll, btnSpread, btnNight, btnFull, h('span.rd-div'), btnDownload, btnFav)
    ),
    h('div.rd-body', side, backdrop, container, overlay)
  );

  backdrop.onclick = () => btnSide.click();

  return {
    root,
    container,
    viewer,
    overlay,
    side,
    backdrop,
    pageInput,
    total,
    zoomLabel,
    btnSide,
    btnPrev,
    btnNext,
    btnZoomOut,
    btnZoomIn,
    btnRotate,
    btnScroll,
    btnSpread,
    btnNight,
    btnFull,
    btnDownload,
    btnFav,
    tabThumbs,
    tabOutline,
    thumbHost,
    thumbPanel: thumbHost,
    outlinePanel,
    outlineHost,
    setStatus: (t) => {
      statusText.textContent = t;
    },
    setNet: (t) => {
      netText.textContent = t;
    },
    hideOverlay: () => overlay.classList.add('gone'),
    fail: (title, detail, b) => {
      clear(overlay);
      overlay.classList.remove('gone');
      overlay.append(
        h(
          'div.rd-overlay-box.err',
          h('h3', title),
          h('p.rd-status', detail),
          h(
            'div.rd-fail-actions',
            h('a.btn.btn-primary', { href: build('book', {}, b.id) }, '返回详情页'),
            h(
              'button.btn',
              { type: 'button', onclick: () => location.reload() },
              '重试'
            )
          )
        )
      );
    },
  };
}

/* ================================================================
   小工具
   ================================================================ */

function initialPage(route, book, pages) {
  const q = Number(route.query.p);
  if (Number.isInteger(q) && q >= 1 && q <= pages) return q;
  if (prefs.get('askResume') === false) return 1;
  const p = progress.get(book.id);
  if (p && p.page > 1 && p.page <= pages) return p.page;
  return 1;
}

function applyNight(ui, on) {
  ui.root.classList.toggle('night', on);
  ui.btnNight.setAttribute('aria-pressed', String(on));
}

function applySidebar(ui, on) {
  ui.root.classList.toggle('side-open', on);
  ui.btnSide.setAttribute('aria-pressed', String(on));
}

function setFav(ui, on) {
  ui.btnFav.setAttribute('aria-pressed', String(on));
  ui.btnFav.title = on ? '取消收藏' : '收藏';
  const svg = ui.btnFav.querySelector('svg');
  if (svg) svg.style.fill = on ? 'currentColor' : 'none';
  ui.btnFav.classList.toggle('on', on);
}

function syncScrollBtn(ui, pdfViewer, ScrollMode, SpreadMode) {
  ui.btnScroll.title = `翻页方式：${SCROLL_LABEL[pdfViewer.scrollMode] || ''}`;
  ui.btnSpread.title = `版式：${SPREAD_LABEL[pdfViewer.spreadMode] || ''}`;
  ui.btnScroll.classList.toggle('on', pdfViewer.scrollMode !== ScrollMode.VERTICAL);
  ui.btnSpread.classList.toggle('on', pdfViewer.spreadMode !== SpreadMode.NONE);
}
