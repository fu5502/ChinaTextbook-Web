/* ============================================================
   loader.js — 按需加载 pdf.js（核心 + viewer）
   ------------------------------------------------------------
   加载顺序有硬性约束：
   · vendor/pdfjs/pdf.min.mjs 在求值时执行 globalThis.pdfjsLib = {...}
   · vendor/pdfjs/web/pdf_viewer.mjs 在模块顶层解构 globalThis.pdfjsLib
   → 必须「先 await 核心，再 import viewer」，两个 import 写在一起会炸
   ============================================================ */

const VENDOR = new URL('../../../vendor/pdfjs/', import.meta.url);

const url = (p) => new URL(p, VENDOR).href;

export const PDFJS_PATHS = {
  worker: url('pdf.worker.min.mjs'),
  cMapUrl: url('cmaps/'),
  standardFontDataUrl: url('standard_fonts/'),
  viewerCss: url('web/pdf_viewer.css'),
};

let loading = null;

/**
 * @returns {Promise<{lib: object, viewer: object}>}
 */
export function loadPdfjs() {
  if (loading) return loading;
  loading = (async () => {
    injectViewerCss();

    // 1) 核心：求值即挂载 globalThis.pdfjsLib
    const lib = await import(/* @vite-ignore */ url('pdf.min.mjs'));

    if (!globalThis.pdfjsLib) {
      // 极少数打包器/浏览器下 side-effect 未生效，手动补齐
      globalThis.pdfjsLib = lib;
    }

    // 2) worker（同源 vendor 目录，不需要 blob 兜底）
    lib.GlobalWorkerOptions.workerSrc = PDFJS_PATHS.worker;

    // 3) viewer 组件层（依赖上一步的全局变量）
    const viewer = await import(/* @vite-ignore */ url('web/pdf_viewer.mjs'));

    return { lib, viewer };
  })().catch((err) => {
    loading = null; // 允许重试
    throw err;
  });
  return loading;
}

let cssInjected = false;
function injectViewerCss() {
  if (cssInjected) return;
  cssInjected = true;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = PDFJS_PATHS.viewerCss;
  document.head.append(link);
}

/** getDocument 的公共参数 */
export function docParams(extra = {}) {
  return {
    cMapUrl: PDFJS_PATHS.cMapUrl,
    cMapPacked: true,
    standardFontDataUrl: PDFJS_PATHS.standardFontDataUrl,
    // 教材扫描件页面大、图多，256KB 一片在延迟和请求数之间比较平衡
    rangeChunkSize: 262144,
    disableAutoFetch: true,
    disableStream: true,
    enableXfa: false,
    ...extra,
  };
}
