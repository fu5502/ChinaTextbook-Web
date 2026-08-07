#!/usr/bin/env node
/* ============================================================
   serve.mjs — 本地静态服务器（仅用于开发预览）
   用法: node tools/serve.mjs [port]
   ------------------------------------------------------------
   · 支持 Range 请求（阅读器要用）
   · 正确的 MIME（.mjs 必须是 text/javascript，否则 ES module 加载失败）
   · 无缓存，改完刷新即可
   ============================================================ */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2]) || 8787;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';

    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    let stat;
    try {
      stat = await fsp.stat(file);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 ' + rel);
      return;
    }
    if (stat.isDirectory()) {
      res.writeHead(302, { location: rel + '/' }).end();
      return;
    }

    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const base = {
      'content-type': type,
      'cache-control': 'no-store',
      'accept-ranges': 'bytes',
      'access-control-allow-origin': '*',
    };

    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (m) {
        let start = m[1] === '' ? stat.size - Number(m[2]) : Number(m[1]);
        let end = m[1] === '' || m[2] === '' ? stat.size - 1 : Number(m[2]);
        start = Math.max(0, start);
        end = Math.min(stat.size - 1, end);
        if (start > end) {
          res.writeHead(416, { 'content-range': `bytes */${stat.size}` }).end();
          return;
        }
        res.writeHead(206, {
          ...base,
          'content-range': `bytes ${start}-${end}/${stat.size}`,
          'content-length': end - start + 1,
        });
        fs.createReadStream(file, { start, end }).pipe(res);
        return;
      }
    }

    res.writeHead(200, { ...base, 'content-length': stat.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(String(err));
  }
});

server.listen(PORT, () => {
  console.log(`静态服务器已启动: http://localhost:${PORT}/`);
  console.log(`根目录: ${ROOT}`);
});
