/* ============================================================
   search.js — 分词 AND 匹配 + 字段加权打分
   1939 条纯 JS 过滤，无需索引库
   ============================================================ */

/** 学科/常见词别名，让「政治」也能搜到「思想政治」 */
const ALIAS = {
  政治: ['思想政治', '道德与法治'],
  生物: ['生物学'],
  信息: ['信息技术'],
  体育: ['体育与健康'],
  书法: ['书法练习指导'],
  人教: ['人教版'],
  苏教: ['苏教版'],
  北师大: ['北师大版'],
  部编: ['统编版'],
  部编版: ['统编版'],
  高数: ['高等数学'],
  线代: ['线性代数'],
  一上: ['一年级', '上册'],
  一下: ['一年级', '下册'],
  二上: ['二年级', '上册'],
  二下: ['二年级', '下册'],
  三上: ['三年级', '上册'],
  三下: ['三年级', '下册'],
  四上: ['四年级', '上册'],
  四下: ['四年级', '下册'],
  五上: ['五年级', '上册'],
  五下: ['五年级', '下册'],
  六上: ['六年级', '上册'],
  六下: ['六年级', '下册'],
  七上: ['七年级', '上册'],
  七下: ['七年级', '下册'],
  八上: ['八年级', '上册'],
  八下: ['八年级', '下册'],
  九上: ['九年级', '上册'],
  九下: ['九年级', '下册'],
};

const DIGIT_CN = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '七', 8: '八', 9: '九' };

/** 把查询串切成词组；每个词组是「或」关系的候选数组 */
export function tokenize(q) {
  const raw = String(q || '')
    .trim()
    .toLowerCase()
    .split(/[\s,，、+]+/)
    .filter(Boolean);

  return raw.map((t) => {
    const alts = new Set([t]);
    if (ALIAS[t]) ALIAS[t].forEach((a) => alts.add(a.toLowerCase()));
    // 「5年级」→「五年级」
    const m = t.match(/^([1-9])年级$/);
    if (m) alts.add(`${DIGIT_CN[m[1]]}年级`);
    // 「五年级」→「5年级」（反向，文件名里也有阿拉伯写法）
    const m2 = t.match(/^([一二三四五六七八九])年级$/);
    if (m2) {
      const n = Object.entries(DIGIT_CN).find(([, c]) => c === m2[1]);
      if (n) alts.add(`${n[0]}年级`);
    }
    return [...alts];
  });
}

/** 单本书对一组词的匹配打分；返回 -1 表示不匹配 */
function scoreBook(b, groups, rawQuery) {
  let score = 0;
  const title = b.title.toLowerCase();

  for (const alts of groups) {
    let best = -1;
    for (const t of alts) {
      if (!b.hay.includes(t)) continue;
      let s;
      if (title === t) s = 100;
      else if (title.startsWith(t)) s = 60;
      else if (title.includes(t)) s = 40;
      else if (
        (b.subject && b.subject.toLowerCase().includes(t)) ||
        (b.edition && b.edition.toLowerCase().includes(t))
      )
        s = 20;
      else s = 10;
      if (s > best) best = s;
    }
    if (best < 0) return -1; // AND：任一词组未命中即淘汰
    score += best;
  }

  // 整串精确匹配标题：强力加权
  const rq = rawQuery.trim().toLowerCase();
  if (rq && title === rq) score += 200;
  else if (rq && title.startsWith(rq)) score += 80;

  // 轻微惩罚超长标题（更短的通常是主教材而非辅导用书）
  score -= Math.min(8, b.title.length / 12);

  return score;
}

/**
 * 执行搜索
 * @returns {{list: Array, terms: string[]}}
 */
export function search(query, source, limit = 400) {
  const groups = tokenize(query);
  if (!groups.length) return { list: [], terms: [] };

  const scored = [];
  for (const b of source) {
    const s = scoreBook(b, groups, query);
    if (s >= 0) scored.push({ b, s });
  }
  scored.sort((x, y) => y.s - x.s);

  const terms = groups.flat();
  return {
    list: scored.slice(0, limit).map((x) => x.b),
    total: scored.length,
    terms,
  };
}

/** 搜索建议：返回学科/版本/年级维度的快捷入口 */
export function suggest(query, source, max = 6) {
  const { list } = search(query, source, 60);
  return list.slice(0, max);
}
