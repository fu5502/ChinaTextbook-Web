#!/usr/bin/env node
/**
 * build-catalog.mjs
 * 抓取 TapXWorld/ChinaTextbook 的 Git tree，归一化后产出 data/catalog.json
 *
 * 用法：
 *   node tools/build-catalog.mjs
 *   GITHUB_TOKEN=xxx node tools/build-catalog.mjs   # 可选，提高 API 限额
 *
 * 无第三方依赖，Node 18+ 即可（内置 fetch）。
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const REPO = 'TapXWorld/ChinaTextbook';
const REF = 'master';
const TREE_API = `https://api.github.com/repos/${REPO}/git/trees/${REF}?recursive=1`;

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const NUM_CN = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/** 中文/阿拉伯数字 → number，支持 一~二十 */
function toNum(s) {
  if (/^\d+$/.test(s)) return Number(s);
  if (CN_NUM[s]) return CN_NUM[s];
  const m = s.match(/^十([一二三四五六七八九])$/);
  if (m) return 10 + CN_NUM[m[1]];
  const m2 = s.match(/^([一二])?十$/);
  if (m2) return m2[1] === '二' ? 20 : 10;
  return null;
}

/** FNV-1a 32bit → base36，取 8 位 */
function fnv1a(str, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
    // 处理多字节：把高位也混进去
    const hi = str.charCodeAt(i) >>> 8;
    if (hi) {
      h ^= hi;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h >>> 0;
}

function makeId(path, salt = 0) {
  const h = fnv1a(path, salt ? 0x811c9dc5 ^ salt : undefined);
  return h.toString(36).padStart(7, '0').slice(0, 8);
}

const basename = (p) => p.slice(p.lastIndexOf('/') + 1);

/* ------------------------------------------------------------------ *
 * 解析规则
 * ------------------------------------------------------------------ */

const TITLE_PREFIXES = [
  '义务教育教科书（五•四学制）·',
  '义务教育教科书（五·四学制）·',
  '义务教育教科书(五•四学制)·',
  '普通高中教科书·',
  '义务教育教科书·',
  '义务教育教科书',
  '普通高中教科书',
  '普通高中课程标准实验教科书·',
  '普通高中课程标准实验教科书',
];

function cleanTitle(fileName) {
  let t = fileName.replace(/\.pdf$/i, '');
  for (const p of TITLE_PREFIXES) {
    if (t.startsWith(p)) {
      t = t.slice(p.length);
      break;
    }
  }
  // 上游文件名把「水平N」写了两遍：体育与健康教师用书水平一水平一
  t = t.replace(/(水平[一二三四])\1+$/, '$1');
  t = t.replace(/\s{2,}/g, ' ');
  return t.trim() || fileName.replace(/\.pdf$/i, '');
}

/** 版本社归一：'苏教版-江苏凤凰教育出版社' → ['苏教版','江苏凤凰教育出版社'] */
function splitEdition(raw) {
  if (!raw) return [null, null];
  const i = raw.indexOf('-');
  if (i < 0) return [raw.trim(), null];
  const short = raw.slice(0, i).trim();
  const pub = raw.slice(i + 1).trim();
  return [short || raw.trim(), pub || null];
}

/** 年级解析：优先「水平N」特例，再「N年级」 */
function parseGrade(text) {
  const lv = text.match(/水平([一二三四])/);
  if (lv) return `水平${lv[1]}`;
  const m = text.match(/([一二三四五六七八九1-9])\s*年级/);
  if (!m) return null;
  const c = m[1];
  const n = CN_NUM[c] ?? Number(c);
  return n >= 1 && n <= 9 ? `${NUM_CN[n]}年级` : null;
}

/**
 * 册次解析。
 * 高中：输出「必修1」「选择性必修3」——与教材封面印刷一致（实测主流形态为
 *       「选择性必修1 自然地理基础」，数字紧跟模块名，最高到 11）。
 *       兼容「必修 第一册」「必修 第1册」的旧写法，统一成同一形态。
 * 其他：输出「上册/下册/全一册」。
 */
function parseVol(text, stage) {
  let module = null;
  if (/选择性必修/.test(text)) module = '选择性必修';
  else if (/必修/.test(text)) module = '必修';
  else if (/选修/.test(text)) module = '选修';

  // 「第N册」写法
  let idx = null;
  const byCe = text.match(/第\s*([一二三四五六七八九十]{1,2}|\d{1,2})\s*册/);
  if (byCe) idx = toNum(byCe[1]);

  if (module) {
    // 数字紧跟模块名：选择性必修1 / 必修2。要求紧邻，否则「必修 技术与设计1」会误判
    if (idx == null) {
      const re = new RegExp(`${module}\\s?(\\d{1,2}|[一二三四五六七八九十]{1,2})(?!年)`);
      const m = text.match(re);
      if (m) idx = toNum(m[1]);
    }
    if (idx != null) return `${module}${idx}`;
    if (/全一册/.test(text)) return `${module}（全一册）`;
    if (/上册|（上）/.test(text)) return `${module}（上）`;
    if (/中册|（中）/.test(text)) return `${module}（中）`;
    if (/下册|（下）/.test(text)) return `${module}（下）`;
    return module;
  }

  if (/上册/.test(text)) return '上册';
  if (/中册/.test(text)) return '中册';
  if (/下册/.test(text)) return '下册';
  if (/全一册/.test(text)) return '全一册';
  if (idx != null) return `第${idx}册`;
  return null;
}

/** 由完整路径解析出一条书目记录的分类字段 */
function parseRecord(path) {
  const segs = path.split('/');
  const file = segs[segs.length - 1];
  const nameNoExt = file.replace(/\.pdf$/i, '');

  let stage = segs[0];
  let subject = null;
  let editionRaw = null;
  let grade = null;

  if (/刷习题/.test(stage)) {
    // 学数学最重要的刷习题在这里/初中练习题_带答案/<试卷组>/<文件>.pdf
    // segs[1] 恒为「初中练习题_带答案」，作为 edition 无筛选价值，直接丢弃
    stage = '习题';
    subject = '中考数学真题';
    editionRaw = null;
    grade = null;
  } else if (stage === '大学') {
    subject = segs[1] || null;
    editionRaw = segs.length >= 4 ? segs[2] : null;
  } else if (segs.length === 5) {
    // 初中：学段/学科/版本/年级/文件
    subject = segs[1];
    editionRaw = segs[2];
    // segs[3] 未必是年级（如「学生读本」），解析不出就退回文件名，再不行为 null
    grade = parseGrade(segs[3]) || parseGrade(nameNoExt);
  } else if (segs.length === 4) {
    // 小学 / 高中：学段/学科/版本/文件（年级藏在文件名）
    subject = segs[1];
    editionRaw = segs[2];
    grade = parseGrade(nameNoExt);
  } else if (segs.length === 3) {
    subject = segs[1];
  } else {
    subject = segs[1] || null;
    editionRaw = segs[2] || null;
    grade = parseGrade(nameNoExt);
  }

  if (stage.startsWith('高中')) grade = null; // 高中无年级概念

  const [edition, publisher] = splitEdition(editionRaw);
  const vol = parseVol(nameNoExt, stage);

  return {
    title: cleanTitle(file),
    file: nameNoExt,
    stage,
    subject,
    edition,
    publisher,
    grade,
    vol,
    path,
  };
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function fetchTree() {
  const headers = { 'User-Agent': 'build-catalog', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(TREE_API, { headers });
  if (!res.ok) throw new Error(`tree API ${res.status} ${res.statusText}`);
  const json = await res.json();
  if (json.truncated) throw new Error('tree API 返回被截断（truncated=true），需改用分页抓取');
  return json.tree.filter((n) => n.type === 'blob');
}

function build(blobs) {
  const direct = [];
  const partGroups = new Map(); // virtualPath -> [{idx, path, size}]

  for (const b of blobs) {
    const p = b.path;
    if (/\.pdf$/i.test(p)) {
      direct.push({ path: p, size: b.size | 0 });
      continue;
    }
    // 分卷：<virtual>.pdf_merge_folder/<name>.pdf.N
    const m = p.match(/^(.*\.pdf)_merge_folder\/(.+)\.(\d+)$/i);
    if (m) {
      const virtualPath = m[1];
      const idx = Number(m[3]);
      if (!partGroups.has(virtualPath)) partGroups.set(virtualPath, []);
      partGroups.get(virtualPath).push({ idx, path: p, size: b.size | 0 });
    }
  }

  const directSet = new Set(direct.map((d) => d.path));

  const entries = [];
  for (const d of direct) entries.push({ path: d.path, size: d.size, parts: 0 });

  let volumeOnly = 0;
  let volumeSkipped = 0;
  for (const [vpath, parts] of partGroups) {
    if (directSet.has(vpath)) {
      volumeSkipped++;
      continue;
    }
    parts.sort((a, b) => a.idx - b.idx);
    // 断言分片编号连续从 1 开始
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].idx !== i + 1) {
        console.warn(`⚠ 分片编号不连续：${vpath} → ${parts.map((x) => x.idx).join(',')}`);
        break;
      }
    }
    const sizes = parts.map((p) => p.size);
    entries.push({
      path: vpath,
      size: sizes.reduce((a, b) => a + b, 0),
      parts: sizes,
    });
    volumeOnly++;
  }

  // 解析
  const records = entries.map((e) => ({ ...parseRecord(e.path), size: e.size, parts: e.parts }));

  // 字典（按频次降序）
  const FIELDS = ['stage', 'subject', 'edition', 'publisher', 'grade', 'vol'];
  const dict = {};
  const indexOf = {};
  for (const f of FIELDS) {
    const freq = new Map();
    for (const r of records) {
      const v = r[f];
      if (v == null) continue;
      freq.set(v, (freq.get(v) || 0) + 1);
    }
    const list = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh')).map((x) => x[0]);
    dict[f] = list;
    indexOf[f] = new Map(list.map((v, i) => [v, i]));
  }

  // id 生成 + 碰撞检测
  const used = new Set();
  for (const r of records) {
    let salt = 0;
    let id = makeId(r.path);
    while (used.has(id)) {
      salt++;
      id = makeId(r.path, salt);
      if (salt > 50) throw new Error(`id 碰撞无法解决：${r.path}`);
    }
    used.add(id);
    r.id = id;
  }

  // 排序：stage → subject → edition → grade → vol
  const stageOrder = ['小学', '初中', '高中', '小学（五•四学制）', '初中（五•四学制）', '大学', '习题'];
  const so = (s) => {
    const i = stageOrder.indexOf(s);
    return i < 0 ? 99 : i;
  };
  const gradeOrder = (g) => {
    if (!g) return 99;
    const m = g.match(/^([一二三四五六七八九])年级$/);
    if (m) return CN_NUM[m[1]];
    const lv = g.match(/^水平([一二三四])$/);
    if (lv) return 20 + CN_NUM[lv[1]];
    return 50;
  };
  const volOrder = (v) => {
    if (!v) return 999;
    if (v === '上册') return 1;
    if (v === '中册') return 2;
    if (v === '下册') return 3;
    if (v === '全一册') return 4;
    const m = v.match(/^(选择性必修|必修|选修)(\d{1,2})?(（(.+)）)?$/);
    if (m) {
      const base = m[1] === '必修' ? 100 : m[1] === '选择性必修' ? 200 : 300;
      if (m[2]) return base + Number(m[2]); // 必修1..11
      const sub = { 上: 91, 中: 92, 下: 93, 全一册: 94 }[m[4]];
      return base + (sub ?? 99); // 上/中/下 → 91-94；纯模块名 → 99，排最后
    }
    const n2 = v.match(/^第(\d{1,2})册$/);
    if (n2) return 400 + Number(n2[1]);
    return 900;
  };

  records.sort(
    (a, b) =>
      so(a.stage) - so(b.stage) ||
      (a.subject || '').localeCompare(b.subject || '', 'zh') ||
      (a.edition || '').localeCompare(b.edition || '', 'zh') ||
      gradeOrder(a.grade) - gradeOrder(b.grade) ||
      volOrder(a.vol) - volOrder(b.vol) ||
      a.title.localeCompare(b.title, 'zh')
  );

  const ix = (f, v) => (v == null ? -1 : indexOf[f].get(v) ?? -1);

  const books = records.map((r) => [
    r.id,
    r.title,
    ix('stage', r.stage),
    ix('subject', r.subject),
    ix('edition', r.edition),
    ix('publisher', r.publisher),
    ix('grade', r.grade),
    ix('vol', r.vol),
    r.size,
    r.path,
    r.parts,
  ]);

  return {
    catalog: {
      v: 1,
      generatedAt: new Date().toISOString(),
      repo: REPO,
      ref: REF,
      fields: ['id', 'title', 'stage', 'subject', 'edition', 'publisher', 'grade', 'vol', 'size', 'path', 'parts'],
      dict,
      books,
    },
    stats: { direct: direct.length, volumeOnly, volumeSkipped, total: records.length, records },
  };
}

async function main() {
  console.log('→ 抓取 tree API …');
  const blobs = await fetchTree();
  console.log(`  ${blobs.length} 个 blob`);

  const { catalog, stats } = build(blobs);

  const outDir = resolve(ROOT, 'data');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outFile = resolve(outDir, 'catalog.json');
  const json = JSON.stringify(catalog);
  writeFileSync(outFile, json, 'utf8');

  // ---- 统计 ----
  const d = catalog.dict;
  console.log('\n=== 统计 ===');
  console.log(`完整 PDF        : ${stats.direct}`);
  console.log(`仅分卷的书      : ${stats.volumeOnly}`);
  console.log(`分卷但有完整版  : ${stats.volumeSkipped}（已忽略分片）`);
  console.log(`书目总数        : ${stats.total}`);
  console.log(`学段            : ${d.stage.length}  ${d.stage.join(' / ')}`);
  console.log(`学科            : ${d.subject.length}`);
  console.log(`版本            : ${d.edition.length}`);
  console.log(`出版社          : ${d.publisher.length}`);
  console.log(`年级            : ${d.grade.length}  ${d.grade.join(' / ')}`);
  console.log(`册次            : ${d.vol.length}  ${d.vol.join(' / ')}`);
  console.log(`索引体积        : ${(json.length / 1024).toFixed(1)} KB`);

  const totalBytes = stats.records.reduce((a, r) => a + r.size, 0);
  console.log(`资源总量        : ${(totalBytes / 1024 / 1024 / 1024).toFixed(1)} GB`);
  const over20 = stats.records.filter((r) => r.size > 20 * 1024 * 1024).length;
  console.log(`>20MB（jsDelivr 不可用）: ${over20}`);

  const noVol = stats.records.filter((r) => !r.vol);
  const noSubject = stats.records.filter((r) => !r.subject);
  const noGrade = stats.records.filter(
    (r) => !r.grade && !r.stage.startsWith('高中') && r.stage !== '大学' && r.stage !== '习题'
  );
  console.log(`\n未解析出册次    : ${noVol.length}`);
  noVol.slice(0, 20).forEach((r) => console.log(`   · ${r.path}`));
  console.log(`未解析出学科    : ${noSubject.length}`);
  noSubject.slice(0, 10).forEach((r) => console.log(`   · ${r.path}`));
  console.log(`未解析出年级(非高中/大学/习题): ${noGrade.length}`);
  noGrade.slice(0, 20).forEach((r) => console.log(`   · ${r.path}`));

  console.log(`\n✓ 已写入 ${outFile}`);
}

main().catch((e) => {
  console.error('✗ 构建失败：', e.message);
  process.exit(1);
});
