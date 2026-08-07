/* ============================================================
   catalog.js — 索引加载、字典展开、facet 计算
   ============================================================ */

const CATALOG_URL = 'data/catalog.json';

/**
 * 展开后的书目对象：
 * { id, title, stage, subject, edition, publisher, grade, vol,
 *   size, path, parts, fileName, hay }
 */
let _books = [];
let _dict = null;
let _meta = null;
let _byId = new Map();
let _loaded = null;

const F = { id: 0, title: 1, stage: 2, subject: 3, edition: 4, publisher: 5, grade: 6, vol: 7, size: 8, path: 9, parts: 10 };

/** 加载并展开索引（幂等） */
export function loadCatalog() {
  if (_loaded) return _loaded;
  _loaded = fetch(CATALOG_URL)
    .then((r) => {
      if (!r.ok) throw new Error(`索引加载失败 HTTP ${r.status}`);
      return r.json();
    })
    .then((raw) => {
      _dict = raw.dict;
      _meta = { v: raw.v, generatedAt: raw.generatedAt, repo: raw.repo, ref: raw.ref };

      const D = raw.dict;
      const pick = (arr, i) => (i >= 0 ? arr[i] : null);

      _books = raw.books.map((b) => {
        const path = b[F.path];
        const slash = path.lastIndexOf('/');
        const fileName = path.slice(slash + 1).replace(/\.pdf$/i, '');
        const o = {
          id: b[F.id],
          title: b[F.title],
          stage: pick(D.stage, b[F.stage]),
          subject: pick(D.subject, b[F.subject]),
          edition: pick(D.edition, b[F.edition]),
          publisher: pick(D.publisher, b[F.publisher]),
          grade: pick(D.grade, b[F.grade]),
          vol: pick(D.vol, b[F.vol]),
          size: b[F.size],
          path,
          parts: b[F.parts] || 0,
          fileName,
        };
        // 搜索用倒排素材（小写，含原始文件名）
        o.hay = [o.title, fileName, o.stage, o.subject, o.edition, o.publisher, o.grade, o.vol]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return o;
      });

      _byId = new Map(_books.map((b) => [b.id, b]));
      return { books: _books, dict: _dict, meta: _meta };
    });
  return _loaded;
}

export const books = () => _books;
export const dict = () => _dict;
export const meta = () => _meta;
export const getBook = (id) => _byId.get(id) || null;

/** 是否为分卷书 */
export const isVolume = (b) => Array.isArray(b.parts) && b.parts.length > 0;

/** 分片路径推导：<virtualPath>_merge_folder/<basename>.<i> */
export function partPaths(b) {
  if (!isVolume(b)) return [b.path];
  const base = b.path.slice(b.path.lastIndexOf('/') + 1);
  return b.parts.map((_, i) => `${b.path}_merge_folder/${base}.${i + 1}`);
}

/** 分片的全局字节区间 [{path,size,start,end}] */
export function segments(b) {
  const paths = partPaths(b);
  if (!isVolume(b)) return [{ path: paths[0], size: b.size, start: 0, end: b.size }];
  let off = 0;
  return b.parts.map((sz, i) => {
    const seg = { path: paths[i], size: sz, start: off, end: off + sz };
    off += sz;
    return seg;
  });
}

/* ---------------- 筛选 ---------------- */

export const DIMENSIONS = {
  小学: ['subject', 'edition', 'grade', 'vol'],
  初中: ['subject', 'edition', 'grade', 'vol'],
  高中: ['subject', 'edition', 'module', 'vol'],
  '小学（五•四学制）': ['subject', 'edition', 'grade', 'vol'],
  '初中（五•四学制）': ['subject', 'edition', 'grade', 'vol'],
  大学: ['subject', 'edition'],
  习题: [],
};

export const DIM_LABEL = {
  stage: '学段',
  subject: '学科',
  edition: '版本',
  publisher: '出版社',
  grade: '年级',
  module: '模块',
  vol: '册次',
};

/** 从 vol 派生高中「模块」维度 */
export function moduleOf(b) {
  if (!b.vol) return null;
  const m = b.vol.match(/^(选择性必修|必修|选修)/);
  return m ? m[1] : null;
}

const valueOf = (b, dim) => (dim === 'module' ? moduleOf(b) : b[dim]);

/**
 * 按条件过滤。cond 形如 { stage:'小学', subject:'数学', ... }
 * skipDim 用于计算某维度的 facet（排除该维度自身的约束）
 */
export function filterBooks(cond, skipDim = null, source = _books) {
  const keys = Object.keys(cond).filter((k) => cond[k] && k !== skipDim);
  if (!keys.length) return source;
  return source.filter((b) => keys.every((k) => valueOf(b, k) === cond[k]));
}

/** 计算某维度在当前条件下的取值与命中数，按预设顺序排序 */
export function facet(cond, dim, source = _books) {
  const base = filterBooks(cond, dim, source);
  const map = new Map();
  for (const b of base) {
    const v = valueOf(b, dim);
    if (v == null) continue;
    map.set(v, (map.get(v) || 0) + 1);
  }
  const list = [...map.entries()].map(([value, count]) => ({ value, count }));
  list.sort(sorterFor(dim));
  return list;
}

const STAGE_ORDER = ['小学', '初中', '高中', '小学（五•四学制）', '初中（五•四学制）', '大学', '习题'];
const GRADE_ORDER = ['一年级', '二年级', '三年级', '四年级', '五年级', '六年级', '七年级', '八年级', '九年级', '水平一', '水平二', '水平三'];
const MODULE_ORDER = ['必修', '选择性必修', '选修'];
const SUBJECT_ORDER = [
  '语文', '数学', '英语', '物理', '化学', '生物学', '科学', '历史', '地理', '地理图册',
  '道德与法治', '思想政治', '信息技术', '通用技术', '音乐', '美术', '艺术', '体育与健康',
  '语文·书法练习指导', '日语', '俄语', '人文地理',
  '高等数学', '线性代数', '概率论', '离散数学', '中考数学真题',
];

function volOrder(v) {
  if (v === '上册') return 1;
  if (v === '中册') return 2;
  if (v === '下册') return 3;
  if (v === '全一册') return 4;
  const m = v.match(/^(选择性必修|必修|选修)(\d{1,2})?(（(.+)）)?$/);
  if (m) {
    const base = m[1] === '必修' ? 100 : m[1] === '选择性必修' ? 200 : 300;
    if (m[2]) return base + Number(m[2]);
    return base + ({ 上: 91, 中: 92, 下: 93, 全一册: 94 }[m[4]] ?? 99);
  }
  const n = v.match(/^第(\d{1,2})册$/);
  if (n) return 400 + Number(n[1]);
  return 900;
}

function byList(list) {
  return (a, b) => {
    const ia = list.indexOf(a.value);
    const ib = list.indexOf(b.value);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.value.localeCompare(b.value, 'zh');
  };
}

function sorterFor(dim) {
  switch (dim) {
    case 'stage':
      return byList(STAGE_ORDER);
    case 'grade':
      return byList(GRADE_ORDER);
    case 'module':
      return byList(MODULE_ORDER);
    case 'subject':
      return byList(SUBJECT_ORDER);
    case 'vol':
      return (a, b) => volOrder(a.value) - volOrder(b.value) || a.value.localeCompare(b.value, 'zh');
    default:
      // 版本/出版社：命中多的在前，便于快速找到主流版本
      return (a, b) => b.count - a.count || a.value.localeCompare(b.value, 'zh');
  }
}

/** 每个学段的代表学科（首页卡片副标题用） */
export function stageSummary() {
  const map = new Map();
  for (const b of _books) {
    if (!map.has(b.stage)) map.set(b.stage, { stage: b.stage, count: 0, subjects: new Map() });
    const s = map.get(b.stage);
    s.count++;
    if (b.subject) s.subjects.set(b.subject, (s.subjects.get(b.subject) || 0) + 1);
  }
  return STAGE_ORDER.filter((s) => map.has(s)).map((s) => {
    const o = map.get(s);
    const subs = [...o.subjects.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]);
    return { stage: o.stage, count: o.count, subjects: subs, top: subs[0] || null };
  });
}

/** 排序结果集 */
export function sortBooks(list, mode) {
  const arr = [...list];
  switch (mode) {
    case 'size-asc':
      return arr.sort((a, b) => a.size - b.size);
    case 'size-desc':
      return arr.sort((a, b) => b.size - a.size);
    case 'title':
      return arr.sort((a, b) => a.title.localeCompare(b.title, 'zh'));
    default:
      return arr; // 索引本身已按 学段→学科→版本→年级→册次 排好
  }
}
