#!/usr/bin/env node
/* ============================================================
   smoke.mjs — 真实浏览器验收（零依赖 CDP 驱动）
   ------------------------------------------------------------
   直接拉起本机 Chrome 的 headless 模式，通过 DevTools Protocol
   跑一遍全站路由，收集 console 报错 / 未捕获异常 / 失败请求，
   并对关键 DOM 断言，最后截图到 .smoke/。

   用法:
     node tools/serve.mjs 8787 &
     node tools/smoke.mjs [baseUrl]
   ============================================================ */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.argv[2] || 'http://localhost:8787';
const SHOTS = path.join(ROOT, '.smoke');
const PORT = 9333;

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

/* ================= CDP 极简客户端 ================= */

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
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* noop */
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================= 启动 Chrome ================= */

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('找不到 Chrome/Edge');
}

async function launch() {
  const bin = findChrome();
  const profile = path.join(os.tmpdir(), `smoke-profile-${Date.now()}`);
  const child = spawn(
    bin,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--hide-scrollbars',
      '--mute-audio',
      '--window-size=1440,900',
      '--disable-extensions',
      '--disable-background-networking',
      'about:blank',
    ],
    { stdio: 'ignore', detached: false }
  );

  let ver = null;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) {
        ver = await r.json();
        break;
      }
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  if (!ver) throw new Error('Chrome 调试端口没起来');
  console.log(`  浏览器: ${ver.Browser}`);
  return { child, profile, bin };
}

async function firstPageTarget() {
  for (let i = 0; i < 40; i++) {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) return page;
    await sleep(200);
  }
  throw new Error('没有找到 page target');
}

/* ================= 断言辅助 ================= */

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`    ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`    ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/* ================= 主流程 ================= */

const logs = { errors: [], warns: [], netFail: [] };

async function main() {
  await fsp.mkdir(SHOTS, { recursive: true });

  console.log('启动浏览器…');
  const { child, profile } = await launch();
  const target = await firstPageTarget();
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Network.enable');

  cdp.on('Runtime.consoleAPICalled', (p) => {
    const text = (p.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
    if (p.type === 'error') logs.errors.push(text);
    else if (p.type === 'warning') logs.warns.push(text);
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails;
    logs.errors.push(`[uncaught] ${d.exception?.description || d.text}`);
  });
  cdp.on('Log.entryAdded', (p) => {
    if (p.entry.level === 'error') logs.errors.push(`[log] ${p.entry.text}`);
  });
  cdp.on('Network.loadingFailed', (p) => {
    if (p.type === 'Image' || p.blockedReason === 'other') return;
    logs.netFail.push(`${p.type} ${p.errorText}`);
  });

  const evalJs = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: `(()=>{try{return JSON.stringify(${expr})}catch(e){return JSON.stringify({__err:String(e)})}})()`,
      returnByValue: true,
      awaitPromise: true,
    });
    const v = r.result?.value;
    return v === undefined ? undefined : JSON.parse(v);
  };
  const exec = async (code) => {
    await cdp.send('Runtime.evaluate', {
      expression: `(()=>{${code}})()`,
      returnByValue: false,
      awaitPromise: false,
    });
  };
  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await fsp.writeFile(path.join(SHOTS, `${name}.png`), Buffer.from(r.data, 'base64'));
  };
  const noErrors = (where) => {
    const real = logs.errors.filter((e) => !/favicon|ERR_ABORTED/i.test(e));
    check(`${where} 无 JS 报错`, real.length === 0, real.slice(0, 3).join(' | '));
  };
  const hardReload = async (url, waitMs = 1200) => {
    logs.errors.length = 0;
    logs.netFail.length = 0;
    await cdp.send('Page.navigate', { url });
    await sleep(waitMs);
  };

  // SPA 内跳转：通过 hash 变更触发 router，比 Page.navigate 更稳定
  const gotoHash = async (hash, opts = {}) => {
    const { waitMs = 800, ready, stable } = opts;
    logs.errors.length = 0;
    logs.netFail.length = 0;
    await exec(`location.hash='${hash.replace(/'/g, "\\'")}'`);
    // 等待 hash 真正生效（hashchange 是异步的）
    await waitFor(() => evalJs(`location.hash==='${hash.replace(/'/g, "\\'")}'`), 3000);
    await sleep(waitMs);
    if (ready) await waitFor(ready, opts.readyTimeout || 8000);
    if (stable) await waitStable(stable, opts.stableTimeout || 5000);
  };
  const waitFor = async (fn, ms = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await fn()) return true;
      await sleep(250);
    }
    return false;
  };
  const waitStable = async (selector, ms = 5000) => {
    let last = -1;
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const n = await evalJs(`document.querySelectorAll('${selector}').length`);
      if (n === last && n > 0) return true;
      last = n;
      await sleep(400);
    }
    return false;
  };

  // 阅读器公共测试
  async function readerTest(id, shotName, timeout) {
    await gotoHash(`#/read/${id}`, { waitMs: 500 });
    const t0 = Date.now();
    let ready = false;
    let lastNet = '';
    while (Date.now() - t0 < timeout) {
      const st = await evalJs(`(()=>{
        const c=document.querySelector('.rd-container .pdfViewer .page canvas');
        const ov=document.querySelector('.rd-overlay');
        return {
          canvas: !!c,
          w: c?.width||0,
          total: document.querySelector('.rd-total')?.textContent||'',
          hidden: !!ov?.classList.contains('gone'),
          err: !!document.querySelector('.rd-overlay-box.err'),
          errText: document.querySelector('.rd-overlay-box.err')?.textContent||'',
          net: document.querySelector('.rd-net')?.textContent||'',
        };
      })()`);
      lastNet = st.net || lastNet;
      if (st.err) {
        check(`${id} 打开文档`, false, st.errText.slice(0, 180));
        await shot(shotName + '-error');
        return;
      }
      if (st.canvas && st.w > 0 && st.hidden) {
        ready = true;
        check(`${id} 首页渲染完成`, true, `${((Date.now() - t0) / 1000).toFixed(1)}s · 共 ${st.total} 页`);
        break;
      }
      await sleep(700);
    }
    if (!ready) {
      check(`${id} 首页渲染完成`, false, `超时 ${timeout / 1000}s，网络状态: ${lastNet}`);
      await shot(shotName + '-timeout');
      return;
    }
    const info = await evalJs(`(()=>{
      const c=document.querySelector('.rd-container .pdfViewer .page canvas');
      const ctx=c.getContext('2d');
      const d=ctx.getImageData(0,0,Math.min(c.width,60),Math.min(c.height,60)).data;
      let sum=0,minv=255,maxv=0;
      for(let i=0;i<d.length;i+=4){const v=(d[i]+d[i+1]+d[i+2])/3;sum+=v;if(v<minv)minv=v;if(v>maxv)maxv=v;}
      return {pages:Number(document.querySelector('.rd-total').textContent),
              canvasW:c.width, canvasH:c.height,
              spread:maxv-minv, avg:Math.round(sum/(d.length/4)),
              loaded: document.querySelector('.rd-net')?.textContent||''};
    })()`);
    check(`${id} 页数有效`, info.pages > 0, `${info.pages} 页`);
    check(`${id} 画布尺寸合理`, info.canvasW > 200 && info.canvasH > 200, `${info.canvasW}×${info.canvasH}`);
    check(`${id} 按需读取（未整包下载）`, /已读取/.test(info.loaded), info.loaded);
    noErrors(`阅读器 ${id}`);
    await shot(shotName);
  }

  try {
    /* ---------- 0. 初始加载并清空本地数据 ---------- */
    await hardReload(`${BASE}/#/`, 2000);
    await waitFor(() => evalJs(`document.querySelectorAll('.stage-card').length > 0`), 10000);
    await evalJs(`localStorage.clear()`);
    // 主流程关闭封面缩图引擎（避免 1900 本按需渲染拖慢整套时序；封面功能单独验证）
    await evalJs(`window.__NO_COVER__ = true`);

    /* ---------- 1. 首页 ---------- */
    console.log('\n[1] 首页');
    check('学段入口加载', (await evalJs(`document.querySelectorAll('.stage-card').length`)) > 0,
      `${await evalJs(`document.querySelectorAll('.stage-card').length`)} 个学段`);
    check('页脚统计', /\d/.test((await evalJs(`document.getElementById('footer-stat')?.textContent||''`)) || ''),
      await evalJs(`document.getElementById('footer-stat')?.textContent`));
    check('标题正确', (await evalJs(`document.title`)).includes('教材'));
    /* ---------- 1b. 轮播幻灯片 ---------- */
    const ss = await evalJs(`(()=>{
      const root=document.querySelector('.slideshow');
      if(!root) return {ok:false};
      const activeBtn=root.querySelector('.ss-int.on');
      return {ok:true, slides:root.querySelectorAll('.slide').length, active:activeBtn?activeBtn.textContent:null, dots:root.querySelectorAll('.ss-dot').length, hasPause:!!root.querySelector('.ss-pause')};
    })()`);
    check('轮播渲染', ss.ok && ss.slides >= 1, `slides=${ss.slides}`);
    check('轮播默认 5s', ss.active === '5s', `active=${ss.active}`);
    check('轮播控件齐全', ss.hasPause && ss.dots >= 1, `dots=${ss.dots}`);
    await evalJs(`document.querySelector('.slideshow .ss-int[data-s="10"]').click()`);
    const ss10 = await evalJs(`({active:document.querySelector('.slideshow .ss-int.on')?.textContent, stored:localStorage.getItem('tb:slideInterval')})`);
    check('轮播可切到 10s', ss10.active === '10s' && ss10.stored === '10', JSON.stringify(ss10));
    await evalJs(`document.querySelector('.slideshow .ss-pause').click()`);
    const pz = await evalJs(`({p:document.querySelector('.slideshow').classList.contains('paused'), btn:document.querySelector('.slideshow .ss-pause').classList.contains('on')})`);
    check('轮播可暂停', pz.p && pz.btn, JSON.stringify(pz));
    await evalJs(`document.querySelector('.slideshow .ss-pause').click(); document.querySelector('.slideshow .ss-int[data-s="5"]').click();`);
    noErrors('首页');
    await shot('01-home');

    /* ---------- 2. 浏览 ---------- */
    console.log('\n[2] 浏览页');
    await gotoHash('#/browse', { waitMs: 500, ready: () => evalJs(`document.querySelectorAll('.book-card').length > 0`), stable: '.book-card' });
    const n1 = await evalJs(`document.querySelectorAll('.book-card').length`);
    check('列表渲染', n1 > 0, `${n1} 张`);
    check('筛选组存在', (await evalJs(`document.querySelectorAll('.filter-group').length`)) > 0);
    noErrors('浏览页');
    await shot('02-browse');

    /* ---------- 3. 筛选 ---------- */
    console.log('\n[3] 筛选（小学 + 数学）');
    await gotoHash('#/browse?stage=小学&subject=数学', { waitMs: 500, ready: () => evalJs(`document.querySelectorAll('.book-card').length > 0`), stable: '.book-card' });
    const debugFilter = await evalJs(`(()=>{
      const cards=[...document.querySelectorAll('.book-card')].slice(0,3).map(c=>({id:c.getAttribute('data-id'),subject:c.getAttribute('data-subject'),title:c.querySelector('.bc-title')?.textContent}));
      return {hash:location.hash,title:document.title,crumbs:document.querySelector('.crumbs')?.textContent,count:document.querySelectorAll('.book-card').length,cards};
    })()`);
    console.log('    dbg:', JSON.stringify(debugFilter));
    const n2 = debugFilter.count;
    check('筛选生效', n2 > 0, `${n2} 张`);
    const firstSub = debugFilter.cards?.[0]?.subject;
    check('结果科目一致', firstSub === '数学', `data-subject=${firstSub}`);
    noErrors('筛选');
    await shot('03-filter');

    /* ---------- 4. 搜索 ---------- */
    console.log('\n[4] 搜索');
    await gotoHash('#/search?q=' + encodeURIComponent('人教版 数学 五年级'), { waitMs: 500, ready: () => evalJs(`document.querySelectorAll('.book-card').length > 0`), stable: '.book-card' });
    const n3 = await evalJs(`document.querySelectorAll('.book-card').length`);
    check('搜索有结果', n3 > 0, `${n3} 条`);
    check('搜索框回填', (await evalJs(`document.getElementById('q')?.value`)) === '人教版 数学 五年级');
    noErrors('搜索');
    await shot('04-search');

    /* ---------- 5. 详情 ---------- */
    console.log('\n[5] 详情页');
    await gotoHash('#/book/0n2jrah', { waitMs: 800, ready: () => evalJs(`document.body.textContent.includes('道德与法治三年级下册')`) });
    check('标题渲染', (await evalJs(`document.body.textContent.includes('道德与法治三年级下册')`)) === true);
    check('有在线阅读入口', (await evalJs(`!!document.querySelector('a[href*="#/read/"]')`)) === true);
    noErrors('详情页');
    await shot('05-detail');

    /* ---------- 6. 阅读器：小文件 ---------- */
    console.log('\n[6] 阅读器 · 小文件 (0.1MB)');
    await readerTest('0z8l42i', '06-reader-small', 45000);

    /* ---------- 7. 阅读器：普通教材 ---------- */
    console.log('\n[7] 阅读器 · 普通教材 (24MB)');
    await readerTest('0n2jrah', '07-reader-normal', 60000);

    /* ---------- 8. 阅读器：分卷合并 ---------- */
    console.log('\n[8] 阅读器 · 分卷虚拟合并 (45.8MB / 2 卷)');
    await readerTest('092j1gl', '08-reader-volume', 75000);

    /* ---------- 9. 夜间 + 侧栏 ---------- */
    console.log('\n[9] 夜间模式 / 缩略图侧栏');
    await evalJs(`(()=>{const b=[...document.querySelectorAll('.rd-btn')].find(x=>x.title==='夜间模式');b&&b.click();return 1})()`);
    await sleep(800);
    check('夜间类已挂上', (await evalJs(`document.querySelector('.reader')?.classList.contains('night')`)) === true);
    // 缩略图渲染是异步的，等至多 5 秒
    await waitFor(() => evalJs(`document.querySelectorAll('.th-canvas').length > 0`), 5000);
    const thumbCount = await evalJs(`document.querySelectorAll('.th-item').length`);
    const thumbDrawn = await evalJs(`document.querySelectorAll('.th-canvas').length`);
    check('缩略图已构建', thumbCount > 0, `${thumbCount} 项`);
    check('缩略图有渲染', thumbDrawn > 0, `${thumbDrawn} 张已画`);
    await shot('09-reader-night');

    /* ---------- 10. 翻页 + 目录 ---------- */
    console.log('\n[10] 翻页 / 目录标签');
    await evalJs(`(()=>{const b=[...document.querySelectorAll('.rd-btn')].find(x=>x.title==='下一页');b&&b.click();b&&b.click();return 1})()`);
    await sleep(1500);
    const pg = await evalJs(`document.querySelector('.rd-page-input')?.value`);
    check('翻页生效', Number(pg) > 1, `当前第 ${pg} 页`);
    await evalJs(`(()=>{const t=[...document.querySelectorAll('.rd-tab')][1];t&&t.click();return 1})()`);
    const olOk = await waitFor(
      () => evalJs(`!!document.querySelector('.ol-list') || !!document.querySelector('.side-empty')`),
      5000
    );
    check('目录面板可用', olOk === true);
    await shot('10-reader-outline');

    /* ---------- 11. 移动端 ---------- */
    console.log('\n[11] 移动端视口 390×844');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await gotoHash('#/', { waitMs: 500, ready: () => evalJs(`document.querySelectorAll('.stage-card').length > 0`), stable: '.stage-card' });
    check('移动端首页渲染', (await evalJs(`document.querySelectorAll('.stage-card').length`)) > 0);
    noErrors('移动端首页');
    await shot('11-mobile-home');

    await gotoHash('#/browse', { waitMs: 500, ready: () => evalJs(`document.querySelectorAll('.book-card').length > 0`), stable: '.book-card' });
    await shot('12-mobile-browse');

    /* ---------- 12. 收藏 / localStorage ---------- */
    console.log('\n[12] 收藏持久化');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await gotoHash('#/book/0n2jrah', { waitMs: 800, ready: () => evalJs(`document.body.textContent.includes('道德与法治三年级下册')`) });
    const favBefore = await evalJs(`JSON.parse(localStorage.getItem('tb:favorites')||'[]').length`);
    // 详情页主卡收藏按钮：按钮同时有 title='收藏' 和文本 '收藏'
    await evalJs(
      `(()=>{
        const b=[...document.querySelectorAll('button')].find(x=>x.title==='收藏'&&x.textContent?.includes('收藏'));
        b&&b.click();
        return 1
      })()`
    );
    await sleep(500);
    const favCount = await evalJs(`JSON.parse(localStorage.getItem('tb:favorites')||'[]').length`);
    check('收藏数增加', favCount === favBefore + 1, `${favBefore}→${favCount}`);
    await gotoHash('#/favorites', { waitMs: 500, ready: () => evalJs(`document.body.textContent.includes('我的收藏')`), stable: '.book-card' });
    const favDebug = await evalJs(`(()=>{
      return {hash:location.hash,title:document.title,heading:document.querySelector('h1')?.textContent,count:document.querySelectorAll('.book-card').length,ls:JSON.parse(localStorage.getItem('tb:favorites')||'[]').length};
    })()`);
    console.log('    dbg:', JSON.stringify(favDebug));
    const favN = favDebug.count;
    check('收藏页有记录', favN === 1, `${favN} 本`);
    await shot('13-favorites');

    /* ---------- 13. 404 ---------- */
    console.log('\n[13] 无效路由');
    await gotoHash('#/nope/xxx', { waitMs: 500 });
    check('404 兜底', (await evalJs(`!!document.querySelector('.state, .state-error, .empty')`)) === true);
    noErrors('404');

    /* ---------- 14. 封面缩图引擎（显式启用） ---------- */
    console.log('\n[14] 封面缩图引擎');
    // 主流程通过 window.__NO_COVER__ 关闭了封面；此处显式打开。
    // 注意：带 # 的 Page.navigate 对 Chrome 只是同文档 hash 变更，不会重置 window，
    // 因此用 gotoHash（hash 跳转）即可，window.__NO_COVER__ 已为 false。
    await evalJs('window.__NO_COVER__ = false');
    await gotoHash('#/browse?stage=小学&subject=数学', {
      waitMs: 1500,
      ready: () => evalJs(`document.querySelectorAll('.book-card').length > 0`),
      stable: '.book-card',
    });
    // 等封面引擎真正渲染出一张真实缩图（loaded）
    const coverLoaded = await waitFor(
      () => evalJs(`[...document.querySelectorAll('.bc-cover')].some(c => c.classList.contains('loaded'))`),
      45000
    );
    const coverStat = await evalJs(`(()=>{const cs=[...document.querySelectorAll('.bc-cover')];return {total:cs.length, loaded:cs.filter(c=>c.classList.contains('loaded')).length, failed:cs.filter(c=>c.classList.contains('failed')).length};})()`);
    console.log('    dbg:', JSON.stringify(coverStat));
    check('封面引擎渲染出真实缩图', coverLoaded === true, `loaded=${coverStat.loaded} failed=${coverStat.failed} 共 ${coverStat.total} 张`);
    noErrors('封面');
    await shot('14-covers');
  } finally {
    /* ---------- 汇总 ---------- */
    console.log('\n' + '─'.repeat(56));
    console.log(`通过 ${pass} · 失败 ${fail}`);
    if (failures.length) {
      console.log('\n失败项:');
      for (const f of failures) console.log('  ✗ ' + f);
    }
    if (logs.warns.length) {
      console.log(`\n警告 ${logs.warns.length} 条（最近 5）:`);
      for (const w of logs.warns.slice(-5)) console.log('  ! ' + w.slice(0, 160));
    }
    console.log(`\n截图: ${SHOTS}`);

    cdp.close();
    child.kill();
    await sleep(400);
    try {
      await fsp.rm(profile, { recursive: true, force: true });
    } catch {
      /* 临时 profile 清理失败无所谓 */
    }
    process.exit(fail ? 1 : 0);
  }
}

main().catch((e) => {
  console.error('冒烟测试崩了:', e);
  process.exit(2);
});
