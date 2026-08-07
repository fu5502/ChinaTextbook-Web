#!/usr/bin/env node
/* ============================================================
   overflow.mjs — 移动端横向溢出验收（零依赖 CDP 驱动）
   检查若干关键路由在窄视口下是否产生横向滚动条。
   用法:
     node tools/serve.mjs 8787 &
     node tools/overflow.mjs [baseUrl]
   ============================================================ */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.argv[2] || 'http://localhost:8787';

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      } else {
        for (const fn of this.handlers.get(msg.method) || []) fn(msg.params);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('ws 连接失败')), { once: true });
    });
    return new CDP(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} 超时`));
      }, 60000);
    });
  }
  close() {
    try { this.ws.close(); } catch { /* noop */ }
  }
}

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('找不到 Chrome/Edge');
}

let activeChild = null;

async function launch() {
  const bin = findChrome();
  const profile = path.join(os.tmpdir(), `of-profile-${Date.now()}`);
  const child = spawn(
    bin,
    [
      '--headless=new',
      '--remote-debugging-port=9344',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--mute-audio',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );
  activeChild = child;
  let ver = null;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch('http://127.0.0.1:9344/json/version');
      if (r.ok) { ver = await r.json(); break; }
    } catch { /* wait */ }
    await sleep(250);
  }
  if (!ver) throw new Error('Chrome 调试端口没起来');
  return { child, profile };
}

const SIZES = [
  { w: 360, h: 740, label: '360 (小屏)' },
  { w: 390, h: 844, label: '390 (iPhone)' },
  { w: 414, h: 896, label: '414' },
];
const ROUTES = [
  { hash: '#/', label: '首页' },
  { hash: '#/browse', label: '浏览' },
  { hash: '#/book/0n2jrah', label: '详情' },
  { hash: '#/favorites', label: '收藏' },
];

let pass = 0, fail = 0;

async function main() {
  const { child, profile } = await launch();
  // 取第一个 page target
  let target;
  for (let i = 0; i < 40; i++) {
    const list = await (await fetch('http://127.0.0.1:9344/json/list')).json();
    target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (target) break;
    await sleep(200);
  }
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const evalJs = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: `(()=>{try{const v=${expr};return v===undefined?null:JSON.stringify(v)}catch(e){return JSON.stringify({__err:String(e)})}})()`,
      returnByValue: true,
    });
    const raw = r.result?.value;
    if (raw === undefined || raw === null) return undefined;
    return JSON.parse(raw);
  };

  // 初始加载 + 清本地数据
  await cdp.send('Page.navigate', { url: `${BASE}/#/` });
  await sleep(2000);
  await evalJs(`localStorage.clear()`);

  for (const s of SIZES) {
    console.log(`\n视口 ${s.label} (${s.w}×${s.h})`);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: s.w, height: s.h, deviceScaleFactor: 2, mobile: true,
    });
    for (const r of ROUTES) {
      await cdp.send('Page.navigate', { url: `${BASE}/${r.hash}` });
      await sleep(1200);
      const m = await evalJs(`(()=>{
        const de=document.documentElement;
        return {sw:de.scrollWidth, iw:window.innerWidth,
                sh:de.scrollHeight, ih:window.innerHeight};
      })()`);
      const overflow = m.sw - m.iw;
      const ok = overflow <= 1; // 允许 1px 取整误差
      if (ok) { pass++; console.log(`    ✓ ${r.label} — 无横向溢出 (scrollWidth ${m.sw} ≤ innerWidth ${m.iw})`); }
      else { fail++; console.log(`    ✗ ${r.label} — 横向溢出 ${overflow}px (scrollWidth ${m.sw} > innerWidth ${m.iw})`); }
    }
  }

  console.log('\n' + '─'.repeat(48));
  console.log(`通过 ${pass} · 失败 ${fail}`);
  cdp.close();
  child.kill();
  await sleep(300);
  try { await fs.promises.rm(profile, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('溢出检查崩了:', e);
  try { activeChild?.kill(); } catch { /* noop */ }
  process.exit(2);
});
