/* ============================================================
   transport.js — 自定义 PDF Range 传输层
   ------------------------------------------------------------
   为什么不能用 pdf.js 自带的 PDFFetchStream：
   1) 浏览器 CORS 只放行安全头，Accept-Ranges / Content-Range 读不到
      → pdf.js 会判定「服务端不支持 Range」，退化成整包下载（最大 96MB）
   2) 分卷教材在仓库里是 N 个二进制切片，物理上不存在完整 PDF 文件
      → 需要把 N 个切片当成一个「虚拟连续文件」来寻址

   本模块继承 PDFDataRangeTransport，只读响应体、不读响应头，
   并把全局区间 [begin,end) 映射到各切片的局部区间。
   ============================================================ */

import { segments, isVolume } from '../catalog.js';
import { sourcesFor } from '../sources.js';
import { loadPdfjs } from './loader.js';

const REQ_TIMEOUT = 25000;
const MAX_ROUNDS = 3; // 全部线路轮询失败后的整体重试次数
const RETRY_DELAY = 900;

/* ------------------------------------------------------------------ *
 * 纯函数：区间规划（单独导出便于离线测试）
 * ------------------------------------------------------------------ */

/**
 * 把虚拟文件的全局区间切成各分片的局部区间
 * @param {Array<{path:string,size:number,start:number,end:number}>} segs
 * @param {number} begin 起始偏移（含）
 * @param {number} end   结束偏移（不含）
 * @returns {Array<{path:string,from:number,to:number,length:number}>} to 为闭区间端点
 */
export function planRange(segs, begin, end) {
  const out = [];
  if (!(end > begin)) return out;
  for (const s of segs) {
    if (s.end <= begin || s.start >= end) continue;
    const from = Math.max(begin, s.start) - s.start;
    const to = Math.min(end, s.end) - s.start - 1;
    if (to < from) continue;
    out.push({ path: s.path, from, to, length: to - from + 1 });
  }
  return out;
}

/** 拼接若干 Uint8Array */
export function concatBytes(list, total) {
  const n = total ?? list.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const b of list) {
    out.set(b, o);
    o += b.length;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 单次 Range 取数（含「服务端无视 Range」的兜底）
 * ------------------------------------------------------------------ */

class RangeError2 extends Error {
  constructor(msg, code) {
    super(msg);
    this.code = code;
  }
}

async function readNeeded(res, from, to) {
  const want = to - from + 1;
  const isPartial = res.status === 206;

  // 服务端老实返回 206：直接收完
  if (isPartial) {
    if (!res.body) {
      const u8 = new Uint8Array(await res.arrayBuffer());
      if (u8.length < want) throw new RangeError2(`分片长度不足 ${u8.length}/${want}`, 'short');
      return u8.subarray(0, want);
    }
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    while (got < want) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
    }
    try {
      await reader.cancel();
    } catch {
      /* noop */
    }
    if (got < want) throw new RangeError2(`分片长度不足 ${got}/${want}`, 'short');
    return concatBytes(chunks, got).subarray(0, want);
  }

  // 服务端无视 Range 返回 200 整包：边收边数，够了立刻掐断连接
  if (res.status === 200) {
    const need = to + 1;
    if (!res.body) {
      const u8 = new Uint8Array(await res.arrayBuffer());
      if (u8.length < need) throw new RangeError2('整包长度不足', 'short');
      return u8.subarray(from, to + 1);
    }
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    while (got < need) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
    }
    try {
      await reader.cancel();
    } catch {
      /* noop */
    }
    if (got < need) throw new RangeError2('整包长度不足', 'short');
    return concatBytes(chunks, got).subarray(from, to + 1);
  }

  throw new RangeError2(`HTTP ${res.status}`, 'http');
}

/* ------------------------------------------------------------------ *
 * MirrorRangeTransport
 * ------------------------------------------------------------------ */

/**
 * @param {object} book 索引里的书对象
 * @param {object} opts
 *   onStatus({loaded, inflight, source, requests})  每次取数后回调
 *   onFatal(err)                                    所有线路都失败
 * @returns {Promise<PDFDataRangeTransport>}
 */
export async function createTransport(book, opts = {}) {
  const { lib } = await loadPdfjs();

  class MirrorRangeTransport extends lib.PDFDataRangeTransport {
    constructor() {
      super(book.size, null, false, `${book.title}.pdf`);
      this.book = book;
      this.segs = segments(book);
      this.multipart = isVolume(book);

      this.concurrency = this.multipart ? 3 : 4;
      this.queue = [];
      this.inflight = 0;
      this.aborted = false;
      this.controllers = new Set();

      // 线路：按体积过滤 + 测速排序；失败的往后挪
      this.sources = sourcesFor(book.size);
      this.penalty = new Map(); // sourceId -> 失败次数
      this.noRange = new Set(); // 无视 Range 的线路
      this.lastGood = null;

      this.loaded = 0;
      this.requests = 0;
    }

    /* ---- pdf.js 调用入口 ---- */
    requestDataRange(begin, end) {
      if (this.aborted) return;
      this.queue.push({ begin, end: Math.min(end, this.length) });
      this.#pump();
    }

    abort() {
      this.aborted = true;
      this.queue.length = 0;
      for (const c of this.controllers) {
        try {
          c.abort();
        } catch {
          /* noop */
        }
      }
      this.controllers.clear();
    }

    /* ---- 队列调度 ---- */
    #pump() {
      while (!this.aborted && this.inflight < this.concurrency && this.queue.length) {
        const job = this.queue.shift();
        this.inflight++;
        this.#serve(job)
          .catch((err) => {
            if (!this.aborted) {
              console.error('[transport] 区间获取失败', job, err);
              opts.onFatal?.(err);
            }
          })
          .finally(() => {
            this.inflight--;
            if (!this.aborted) this.#pump();
          });
      }
    }

    async #serve({ begin, end }) {
      const plan = planRange(this.segs, begin, end);
      if (!plan.length) throw new Error(`区间越界 ${begin}-${end}`);

      const bufs = await Promise.all(
        plan.map((p) => this.#fetchPart(p.path, p.from, p.to, p.length))
      );
      if (this.aborted) return;

      const total = plan.reduce((a, p) => a + p.length, 0);
      this.loaded += total;
      this.requests += plan.length;

      // begin 必须与 pdf.js 请求时完全一致，否则内部断言会炸
      this.onDataRange(begin, plan.length === 1 ? bufs[0] : concatBytes(bufs, total));

      opts.onStatus?.({
        loaded: this.loaded,
        total: this.length,
        inflight: this.inflight,
        requests: this.requests,
        source: this.lastGood,
      });
    }

    /* ---- 线路顺序：惩罚过的排后面，成功过的排前面 ---- */
    #order() {
      return [...this.sources].sort((a, b) => {
        const pa = this.penalty.get(a.id) || 0;
        const pb = this.penalty.get(b.id) || 0;
        if (pa !== pb) return pa - pb;
        if (this.lastGood) {
          if (a.id === this.lastGood.id) return -1;
          if (b.id === this.lastGood.id) return 1;
        }
        return 0;
      });
    }

    async #fetchPart(path, from, to, expected) {
      let lastErr = null;
      for (let round = 0; round < MAX_ROUNDS; round++) {
        for (const src of this.#order()) {
          if (this.aborted) throw new Error('aborted');
          try {
            const buf = await this.#once(src, path, from, to, expected);
            this.lastGood = src;
            // 成功就抵掉一次历史惩罚，避免抖动后永久沉底
            const p = this.penalty.get(src.id) || 0;
            if (p > 0) this.penalty.set(src.id, p - 1);
            return buf;
          } catch (err) {
            if (this.aborted) throw err;
            lastErr = err;
            this.penalty.set(src.id, (this.penalty.get(src.id) || 0) + 1);
          }
        }
        if (round < MAX_ROUNDS - 1) await sleep(RETRY_DELAY * (round + 1));
      }
      throw new Error(
        `所有线路均无法读取该片段（${lastErr?.message || '未知错误'}）`
      );
    }

    async #once(src, path, from, to, expected) {
      // 已知无视 Range 的线路，只在小区间时才用（否则会拖满整包）
      if (this.noRange.has(src.id) && to > 4 * 1024 * 1024) {
        throw new RangeError2('该线路不支持分段读取', 'norange');
      }

      const ctrl = new AbortController();
      this.controllers.add(ctrl);
      const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT);
      try {
        const res = await fetch(src.build(path), {
          headers: { Range: `bytes=${from}-${to}` },
          signal: ctrl.signal,
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
        });
        if (res.status === 200) this.noRange.add(src.id);
        if (res.status !== 200 && res.status !== 206) {
          throw new RangeError2(`HTTP ${res.status}`, 'http');
        }
        const buf = await readNeeded(res, from, to);
        if (buf.length !== expected) {
          throw new RangeError2(`长度不符 ${buf.length}/${expected}`, 'len');
        }
        return buf;
      } finally {
        clearTimeout(timer);
        this.controllers.delete(ctrl);
      }
    }
  }

  return new MirrorRangeTransport();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
