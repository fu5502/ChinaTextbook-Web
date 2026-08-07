/* ============================================================
   download.js — 下载（单文件直链 / 分卷取回后浏览器内合并）
   详情页与阅读器共用
   ============================================================ */

import { fmtSize, triggerDownload } from './util.js';
import { isVolume, segments } from './catalog.js';
import { sourcesFor } from './sources.js';
import { toast, toastOk, toastError } from './ui/toast.js';

const busy = new Set();

/** 单文件：直接交给浏览器下载，不占内存 */
export function downloadSingle(b) {
  const src = sourcesFor(b.size)[0];
  if (!src) {
    toastError('当前没有可用线路');
    return false;
  }
  triggerDownload(src.build(b.path), `${b.title}.pdf`);
  toast(`已通过 ${src.name} 开始下载`, 'info', 2600);
  return true;
}

/**
 * 分卷：并发取回全部切片 → Blob 合并 → 触发下载
 * @param {object} b
 * @param {(text:string, pct:number)=>void} [onProgress]
 */
export async function downloadVolume(b, onProgress) {
  if (busy.has(b.id)) {
    toast('该书正在下载中', 'info', 1800);
    return false;
  }
  const segs = segments(b);
  const srcList = sourcesFor(b.size);
  if (!srcList.length) {
    toastError('当前没有可用线路');
    return false;
  }

  busy.add(b.id);
  const buffers = new Array(segs.length);
  let done = 0;
  const report = () =>
    onProgress?.(`合并中 ${done} / ${segs.length}`, Math.round((done / segs.length) * 100));

  report();
  toast(`正在从 ${srcList[0].name} 取回 ${segs.length} 个分卷，共 ${fmtSize(b.size)}`, 'info', 3200);

  const queue = segs.map((s, i) => ({ s, i }));
  const worker = async () => {
    while (queue.length) {
      const { s, i } = queue.shift();
      let lastErr = null;
      for (const trySrc of srcList.slice(0, 3)) {
        try {
          const r = await fetch(trySrc.build(s.path), { credentials: 'omit' });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const ab = await r.arrayBuffer();
          if (ab.byteLength !== s.size) throw new Error(`分卷 ${i + 1} 长度不符`);
          buffers[i] = ab;
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
        }
      }
      if (lastErr) throw lastErr;
      done++;
      report();
    }
  };

  try {
    await Promise.all([worker(), worker()]);
    const blob = new Blob(buffers, { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    triggerDownload(url, `${b.title}.pdf`);
    // 上百 MB 的 Blob 不释放会撑爆内存，留够浏览器落盘时间后回收
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toastOk('合并完成，已开始下载');
    return true;
  } catch (e) {
    console.error('[download]', e);
    toastError(`分卷下载失败：${e.message}。可在右上角切换线路后重试。`);
    return false;
  } finally {
    buffers.length = 0;
    busy.delete(b.id);
    onProgress?.(null, 0);
  }
}

/** 统一入口 */
export function downloadBook(b, onProgress) {
  return isVolume(b) ? downloadVolume(b, onProgress) : Promise.resolve(downloadSingle(b));
}

export const isDownloading = (id) => busy.has(id);
