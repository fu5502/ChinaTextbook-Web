# 教材馆 · Open Textbook

一个**免登录、免费、纯静态**的中小学与大学教材在线阅览站。基于公益项目
[TapXWorld/ChinaTextbook](https://github.com/TapXWorld/ChinaTextbook)（收录 1900+ 册 PDF 教材）
构建前端索引与浏览器内阅读器，不托管任何受版权保护的 PDF 文件本身，仅做检索与转发。

- 浏览 / 筛选：按学段、学科、版本、年级检索
- 全局搜索：书名、学科、版本关键词
- 浏览器内阅读：pdf.js 驱动，按需 Range 读取，支持翻页 / 缩放 / 旋转 / 双页 / 夜间模式 / 目录 / 缩略图
- 分卷虚拟合并：对超大教材自动按字节拼接多个 PDF 分片，呈现为一本连续文档
- 收藏 / 最近阅读 / 阅读进度：纯 `localStorage`，不依赖后端
- 多线路：jsDelivr / Fastly / GitHub 源站自动选路，支持自定义代理前缀

> 源码仓库：[github.com/fu5502/ChinaTextbook-Web](https://github.com/fu5502/ChinaTextbook-Web)

> 本站为纯前端静态站点，**零构建**（原生 ES Module + 手写 CSS），可直接托管到任意静态空间。

---

## 技术架构

| 关注点 | 方案 |
| --- | --- |
| 打包 | 无。原生 `<script type="module">` + ES Module |
| 路由 | 自研 hash-router（`#/home`、`#/browse`、`#/read/:id` …），SPA 单页 |
| 阅读器 | pdf.js `4.10.38`（vendor 本地化，非 CDN），按页渲染 |
| 按需读取 | `PDFDataRangeTransport` 自定义层：滚动到哪页才发 Range 请求，绕过 jsDelivr 20MB 限制 |
| 分卷拼接 | 多分片二进制按需拼接为单一连续 PDF 字节流（`tools/test-transport.mjs` 已字节级验证） |
| 数据 | `data/catalog.json`（索引），由 `tools/build-catalog.mjs` 从上游仓库 Git tree 生成 |
| 状态持久化 | `localStorage`（收藏 / 最近阅读 / 阅读进度 / 线路偏好），隐私模式自动降级为内存态 |

### 目录结构

```
.
├── index.html              # 入口（SPA 外壳 + 顶栏 + 页脚）
├── assets/
│   ├── css/                # tokens / base / components / layout / bookcard / reader
│   └── js/
│       ├── main.js         # 启动、路由装配、顶栏搜索、线路下拉
│       ├── router.js       # hash-router
│       ├── catalog.js      # 索引加载
│       ├── sources.js      # 多线路 / 测速 / 选路
│       ├── storage.js      # 收藏 / 进度（localStorage + 内存兜底）
│       ├── ui/             # home / browse(搜索·收藏) / detail / bookcard / toast
│       └── reader/         # reader.js / loader.js / transport.js（pdf.js 装配 + 按需 Range）
├── data/
│   └── catalog.json        # 教材索引（自动生成，勿手改）
├── vendor/
│   └── pdfjs/              # pdf.js 4.10.38（核心 + viewer + worker + cmap + 字体）
├── tools/
│   ├── serve.mjs           # 本地静态服务器（支持 Range 请求）
│   ├── build-catalog.mjs   # 抓取上游仓库生成 catalog.json
│   ├── smoke.mjs           # 真实浏览器验收（零依赖 CDP 驱动，13 个场景）
│   ├── overflow.mjs        # 移动端横向溢出验收（360/390/414 视口）
│   ├── test-transport.mjs  # 跨分片 Range 拼接离线单测 + 真机验证
│   └── check-imports.mjs   # ES Module import/export 静态一致性校验
├── .nojekyll               # 关闭 GitHub Pages 的 Jekyll 处理
└── README.md
```

---

## 本地运行

不需要 Node 依赖安装，只要一个能发 `Range` 请求、带正确 MIME 的静态服务器：

```bash
node tools/serve.mjs 8787
# 打开 http://localhost:8787/
```

（`tools/serve.mjs` 已内置 Range 支持、正确的 `.mjs` MIME、无缓存头，便于本地调试。）

---

## 测试与验收

全部零第三方依赖，直接用本机 Chrome/Edge 的 DevTools Protocol 驱动：

```bash
# 1) 起服务器
node tools/serve.mjs 8787 &

# 2) 全站 13 场景冒烟（首页/浏览/筛选/搜索/详情/3 类阅读器/夜间/翻页/移动端/收藏/404）
node tools/smoke.mjs http://localhost:8787

# 3) 移动端横向溢出（360/390/414 × 首页/浏览/详情/收藏）
node tools/overflow.mjs http://localhost:8787

# 4) 分卷 Range 拼接单测（纯函数 + 真机联网验证）
node tools/test-transport.mjs

# 5) ES Module 导入导出一致性
node tools/check-imports.mjs
```

验收结果（最近一次）：`smoke 通过 42 · 失败 0`、`overflow 通过 12 · 失败 0`，
三类阅读器（小文件 / 普通 24MB / 分卷 45.8MB）均按页按需渲染且**未整包下载**，全程无 JS 报错。

---

## 部署

站点全部使用**相对路径**（CSS/JS 经 `import.meta.url` 解析，数据走相对 `fetch`），
因此既可作为用户/组织页（`*.github.io`）部署，也可作为项目子路径页（`*.github.io/repo/`），
无需 `<base>` 或改写路径。

### GitHub Pages

1. 把本仓库推到 GitHub。
2. 仓库 **Settings → Pages → Build and deployment → Source = Deploy from a branch**。
3. 选择分支与 `/ (root)`，保存。
4. `.nojekyll` 已就位，Jekyll 不会拦截 `_` 开头的资源。

### Cloudflare Pages（推荐）

纯静态、零构建，哈希路由无需 rewrite，最容易。两种接入方式：

**方式 A · 控制台连接 Git（最省心）**
1. 把本仓库推到 GitHub（当前工作区还不是 git 仓库，需先 `git init` 并推送）。
2. Cloudflare 控制台 → **Workers & Pages → Create → Pages → Connect to Git**，选择本仓库。
3. 构建命令：**留空**（无需 build）；构建输出目录（Build output directory）：**`.`**（根目录，`index.html` 在此）。
4. 保存后自动获得 `*.pages.dev` 域名，可再绑定自定义域名。

**方式 B · 命令行直接上传（不连 Git）**
```bash
npx wrangler pages deploy . --project-name china-textbook
```
根目录的 `_headers` 会被自动应用（长缓存 + 基础安全头）。

### Cloudflare Workers（Static Assets）

若想在站点同域里再叠加服务端逻辑（例如自托管 PDF 代理、彻底绕开上游 CORS / 20MB 限制），
可用 Workers Static Assets 一条命令托管静态资源：

1. 安装 `wrangler`（`npm i -g wrangler`）。
2. 根目录已附带 `wrangler.toml`（声明 `[assets] directory = "."`）。
3. 部署：
   ```bash
   wrangler deploy                 # → *.workers.dev
   wrangler deploy --routes your.domain   # 绑定自定义域名
   ```
> 注意：Workers 模式下根目录的 `_headers` 文件**不生效**，缓存与安全头改由 `wrangler.toml` 的
> `[[headers]]` 段控制（已写入）。哈希路由下同样**无需** SPA 回退配置。

### 其它静态托管

任意支持静态文件的空间（Netlify、对象存储 + CDN、Nginx 等）均可，
只要以根目录作为站点根、并对 `.mjs` 返回 `text/javascript` 的 MIME。

> 提示：若放在子路径下，所有资源已按相对路径处理；仅需注意站点入口为 `index.html`。
> 由于使用 hash 路由，**无需**任何 SPA rewrite / 404 回退配置。

---

## 阅读器实现要点

- **按需读取**：`PDFDataRangeTransport` 仅在视口需要某页时才请求对应字节区间；已验证普通教材
  首页仅读取约 1.4MB / 6 段（而非整包 24MB），分卷教材读取约 5.8MB / 23 段。
- **分卷合并**：上游部分教材被切成多个 PDF 分片。`transport.js` 按全局偏移把跨分片的 Range 请求
  拆分为对各分片的子请求并拼接，对调用方呈现为一个连续 PDF 文件（见 `tools/test-transport.mjs`）。
- **线路切换**：jsDelivr / Fastly 系对 >20MB 文件支持不佳，站点按实测延迟与文件大小自动选路，
  大体量教材自动改走 GitHub 源站或用户自定义代理；用户可在顶栏下拉手动锁定。

---

## 数据来源与版权

- 教材 PDF 文件来自上游公益仓库 [TapXWorld/ChinaTextbook](https://github.com/TapXWorld/ChinaTextbook)，
  版权归原作者与出版方所有。
- 本仓库**仅包含前端代码与索引元数据**，不复制、不托管任何受版权保护的 PDF 内容，
  阅读/下载均直接指向上游公开文件地址。
- 若内容涉及版权问题，请依据上游仓库的说明处理。

---

## 许可证

- 前端代码：MIT（详见 `LICENSE`）。
- 教材内容版权归各自权利人，遵循上游仓库的授权说明。
