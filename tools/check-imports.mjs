/* 静态校验 assets/js 下所有 ES 模块的 import/export 一致性
   用法：node tools/check-imports.mjs                        */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', 'assets', 'js');

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) files.push(p);
  }
})(root);

const norm = (p) => path.resolve(p).replace(/\\/g, '/');
const exportsOf = new Map();

for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const set = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+([\w$]+)/gm)) set.add(m[1]);
  for (const m of src.matchAll(/^export\s+(?:async\s+)?class\s+([\w$]+)/gm)) set.add(m[1]);
  for (const m of src.matchAll(/^export\s+(?:const|let|var)\s+([\w$]+)/gm)) set.add(m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]+)\}/gm)) {
    for (const s of m[1].split(',')) {
      const t = s.trim().split(/\s+as\s+/).pop().trim();
      if (t) set.add(t);
    }
  }
  if (/^export\s+default/m.test(src)) set.add('default');
  exportsOf.set(norm(f), set);
}

let bad = 0;
const rel = (f) => path.relative(root, f).replace(/\\/g, '/');

for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/import\s+([\s\S]*?)\s+from\s+['"](\.[^'"]+)['"]/g)) {
    const clause = m[1];
    const spec = m[2];
    const target = norm(path.join(path.dirname(f), spec));
    if (!exportsOf.has(target)) {
      console.log(`✗ 找不到模块 ${spec}（引用自 ${rel(f)}）`);
      bad++;
      continue;
    }
    const exp = exportsOf.get(target);
    const braces = clause.match(/\{([\s\S]*)\}/);
    if (!braces) continue;
    for (const raw of braces[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (!name) continue;
      if (!exp.has(name)) {
        console.log(`✗ ${spec} 未导出 ${name}（引用自 ${rel(f)}）`);
        bad++;
      }
    }
  }
  // 动态 import 只检查文件存在
  for (const m of src.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
    const target = norm(path.join(path.dirname(f), m[1]));
    if (!exportsOf.has(target)) {
      console.log(`✗ 动态导入目标不存在 ${m[1]}（引用自 ${rel(f)}）`);
      bad++;
    }
  }
}

console.log(bad ? `\n共 ${bad} 处问题` : `✓ ${files.length} 个模块，import/export 全部对得上`);
process.exit(bad ? 1 : 0);
