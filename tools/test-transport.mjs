/* ============================================================
   离线验证跨分片 Range 拼接
   用法：node tools/test-transport.mjs
   ------------------------------------------------------------
   1. planRange 纯函数单测（合成数据）
   2. 真机联网：对一本分卷教材
      a) 跨越切片边界读一段，与分别读两片再拼接比对
      b) 读虚拟文件尾部，解析 startxref，再按全局偏移读 xref 位置，
         验证「N 个切片 = 一个连续 PDF」这一前提成立
   ============================================================ */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planRange, concatBytes } from '../assets/js/reader/transport.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');

let failed = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, detail) => {
  failed++;
  console.log(`  ✗ ${name}\n      ${detail}`);
};
function eq(name, a, b) {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  sa === sb ? ok(name) : bad(name, `实际 ${sa}\n      期望 ${sb}`);
}

/* ================= 1. planRange 单测 ================= */

console.log('\n[1] planRange 纯函数');

const segs = [
  { path: 'a.1', size: 100, start: 0, end: 100 },
  { path: 'a.2', size: 50, start: 100, end: 150 },
  { path: 'a.3', size: 30, start: 150, end: 180 },
];

eq('整段落在首片', planRange(segs, 0, 10), [{ path: 'a.1', from: 0, to: 9, length: 10 }]);

eq('整段落在中片', planRange(segs, 110, 120), [{ path: 'a.2', from: 10, to: 19, length: 10 }]);

eq('跨越一个边界', planRange(segs, 95, 105), [
  { path: 'a.1', from: 95, to: 99, length: 5 },
  { path: 'a.2', from: 100 - 100, to: 104 - 100, length: 5 },
]);

eq('跨越两个边界', planRange(segs, 90, 160), [
  { path: 'a.1', from: 90, to: 99, length: 10 },
  { path: 'a.2', from: 0, to: 49, length: 50 },
  { path: 'a.3', from: 0, to: 9, length: 10 },
]);

eq('紧贴边界左侧', planRange(segs, 90, 100), [{ path: 'a.1', from: 90, to: 99, length: 10 }]);
eq('紧贴边界右侧', planRange(segs, 100, 110), [{ path: 'a.2', from: 0, to: 9, length: 10 }]);
eq('读到文件末尾', planRange(segs, 175, 180), [{ path: 'a.3', from: 25, to: 29, length: 5 }]);
eq('空区间', planRange(segs, 50, 50), []);
eq('倒置区间', planRange(segs, 60, 50), []);

// 覆盖率：任意区间拆分后长度之和必须等于区间长度
let cover = true;
for (let i = 0; i < 400; i++) {
  const a = Math.floor(Math.random() * 180);
  const b = a + 1 + Math.floor(Math.random() * (180 - a));
  const sum = planRange(segs, a, b).reduce((s, p) => s + p.length, 0);
  if (sum !== b - a) {
    cover = false;
    bad('随机区间覆盖', `[${a},${b}) 拆出 ${sum} 字节`);
    break;
  }
}
if (cover) ok('随机区间覆盖（400 次）');

/* ================= 2. concatBytes ================= */

console.log('\n[2] concatBytes');
{
  const r = concatBytes([new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5, 6])]);
  eq('顺序拼接', [...r], [1, 2, 3, 4, 5, 6]);
  eq('空数组', [...concatBytes([])], []);
}

/* ================= 3. 真机联网验证 ================= */

const OFFLINE = process.argv.includes('--offline');
if (OFFLINE) {
  console.log('\n[3] 联网验证已跳过（--offline）');
  finish();
}

console.log('\n[3] 联网验证跨分片寻址');

const catalog = JSON.parse(readFileSync(path.join(ROOT, 'data', 'catalog.json'), 'utf8'));
const F = { title: 1, size: 8, path: 9, parts: 10 };

const volBooks = catalog.books.filter((b) => Array.isArray(b[F.parts]) && b[F.parts].length > 1);
// 挑总体积最小的一本，减少测试流量
volBooks.sort((a, b) => a[F.size] - b[F.size]);
const raw = volBooks[0];

const book = {
  title: raw[F.title],
  size: raw[F.size],
  path: raw[F.path],
  parts: raw[F.parts],
};

// 与 catalog.js segments() 同构（此处独立实现，顺带交叉校验）
const base = book.path.slice(book.path.lastIndexOf('/') + 1);
let off = 0;
const bookSegs = book.parts.map((sz, i) => {
  const s = { path: `${book.path}_merge_folder/${base}.${i + 1}`, size: sz, start: off, end: off + sz };
  off += sz;
  return s;
});

console.log(`  书名：${book.title}`);
console.log(`  体积：${(book.size / 1048576).toFixed(1)}MB，切片 ${book.parts.join(' + ')}`);

const MIRROR = 'https://ghfast.top/https://raw.githubusercontent.com/TapXWorld/ChinaTextbook/master/';
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

async function fetchPart(p, from, to) {
  const res = await fetch(MIRROR + encPath(p), { headers: { Range: `bytes=${from}-${to}` } });
  if (res.status !== 206 && res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const u8 = new Uint8Array(await res.arrayBuffer());
  return res.status === 206 ? u8 : u8.subarray(from, to + 1);
}

/** 用 planRange 读虚拟文件的全局区间 */
async function readVirtual(begin, end) {
  const plan = planRange(bookSegs, begin, Math.min(end, book.size));
  const bufs = [];
  for (const p of plan) bufs.push(await fetchPart(p.path, p.from, p.to));
  return concatBytes(bufs);
}

try {
  const B = bookSegs[0].end; // 第一个切片边界

  // a) 跨边界 128 字节：虚拟读 vs 分别读再拼
  const viaPlan = await readVirtual(B - 64, B + 64);
  const tail = await fetchPart(bookSegs[0].path, bookSegs[0].size - 64, bookSegs[0].size - 1);
  const head = await fetchPart(bookSegs[1].path, 0, 63);
  const manual = concatBytes([tail, head]);
  eq('跨边界读取长度', viaPlan.length, 128);
  eq('跨边界字节一致', Buffer.from(viaPlan).toString('hex'), Buffer.from(manual).toString('hex'));

  // b) 头部魔数
  const magic = await readVirtual(0, 8);
  const magicStr = Buffer.from(magic).toString('latin1');
  magicStr.startsWith('%PDF-') ? ok(`虚拟文件头 ${magicStr.trim()}`) : bad('虚拟文件头', magicStr);

  // c) 尾部 startxref → 按全局偏移回读，验证连续寻址
  const tailBuf = await readVirtual(book.size - 2048, book.size);
  const tailStr = Buffer.from(tailBuf).toString('latin1');
  if (!/%%EOF/.test(tailStr)) bad('虚拟文件尾 %%EOF', tailStr.slice(-60));
  else ok('虚拟文件尾含 %%EOF');

  const m = /startxref\s+(\d+)\s*%%EOF/.exec(tailStr);
  if (!m) {
    bad('解析 startxref', tailStr.slice(-120).replace(/[^\x20-\x7e]/g, '.'));
  } else {
    const xrefOff = Number(m[1]);
    console.log(`  startxref → 全局偏移 ${xrefOff}（总长 ${book.size}）`);
    if (xrefOff >= book.size) {
      bad('startxref 落点', `${xrefOff} 超出文件长度`);
    } else {
      const at = await readVirtual(xrefOff, xrefOff + 40);
      const s = Buffer.from(at).toString('latin1');
      // 交叉引用表（xref）或交叉引用流（"N 0 obj ... /Type /XRef"）
      if (/^xref/.test(s) || /^\d+\s+\d+\s+obj/.test(s)) {
        ok(`startxref 落点有效：${JSON.stringify(s.slice(0, 24))}`);
      } else {
        bad('startxref 落点', JSON.stringify(s.slice(0, 40)));
      }
    }
  }
} catch (err) {
  bad('联网验证', err.message);
}

finish();

function finish() {
  console.log(failed ? `\n共 ${failed} 项失败\n` : '\n全部通过\n');
  process.exit(failed ? 1 : 0);
}
