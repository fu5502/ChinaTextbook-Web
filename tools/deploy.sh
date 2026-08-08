#!/usr/bin/env bash
# 标准部署脚本（Cloudflare Workers + Static Assets）
#
# 历史教训：曾因部署时未把 data/ 打包上传，导致线上 data/catalog.json 404、
# 全站“教材索引加载失败”。本脚本保证 data/、vendor/ 等必需资源一定被带上，
# 并在 _deploy_tmp 放一个空 .gitignore，防止 wrangler 因任何忽略规则漏传文件。
#
# 用法（先设置凭证，再运行）：
#   export CF_API_KEY=xxxx CF_EMAIL=32120477@qq.com CLOUDFLARE_ACCOUNT_ID=xxxx
#   bash tools/deploy.sh
#
# 注意：脚本本身不含任何凭证，凭证一律来自环境变量。
set -euo pipefail

cd "$(dirname "$0")/.."

: "${CF_API_KEY:?请先设置环境变量 CF_API_KEY}"
: "${CF_EMAIL:?请先设置环境变量 CF_EMAIL}"
: "${CLOUDFLARE_ACCOUNT_ID:?请先设置环境变量 CLOUDFLARE_ACCOUNT_ID}"

WRANGLER="${WRANGLER:-$HOME/.workbuddy/binaries/node/workspace/node_modules/.bin/wrangler}"
[ -x "$WRANGLER" ] || { echo "找不到 wrangler：$WRANGLER（可用 WRANGLER=路径 覆盖）"; exit 1; }

# 清理并重建部署临时目录
rm -rf _deploy_tmp
mkdir _deploy_tmp

# 复制全部站点静态资源（务必包含 data/ 与 vendor/）
cp -r index.html assets data vendor .nojekyll _headers README.md wrangler.toml _deploy_tmp/
# 空 .gitignore：覆盖根目录规则，确保不漏传任何文件
: > _deploy_tmp/.gitignore

cd _deploy_tmp
"$WRANGLER" deploy

echo
echo "部署完成。请验证线上索引可达："
echo "  https://textbook.zyweb.top/data/catalog.json  （应返回 HTTP 200 的 JSON）"
