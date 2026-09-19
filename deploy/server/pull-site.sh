#!/usr/bin/env bash
# 服务器侧拉取部署：把 CI 发布的站点产物同步到站点根目录。
#
# 由 systemd timer 定时调用（见 site-pull.timer）。只做出站 HTTPS 请求，
# 不开放任何入站 SSH，所以不会再产生"异地登录"告警。
#
# 为什么默认从 codeload 的分支归档下载，而不是 Release 附件：
#   实测本服务器（阿里云杭州）到 GitHub 两个下载通道差 500 倍 ——
#     Release 附件（Fastly，release-assets.githubusercontent.com）约 13~20 KB/s
#     codeload 分支归档（codeload.github.com）约 10 MB/s
#   因此 CI 会把产物推到 site-dist 分支，这里用 codeload 拉；Release 仍作为备用源。
#
# 流程：读远端版本号（git ls-remote）→ 与本地比对 → 有新版本才下载 → 解包到独立版本目录
#       → 校验 index.html → rsync 同步到站点根目录 → 记录版本、清理旧版本。
#       校验失败时【不会】碰线上目录，坏包不会导致站点挂掉。
#
# 可用环境变量覆盖（一般不用改）：
#   SITE_REPO         GitHub 仓库 slug       默认 Fire0King/Fire0King.github.io
#   SITE_BRANCH       产物分支               默认 site-dist
#   SITE_TAG          Release 的 tag         默认 site-latest
#   SITE_ARCHIVE_URL  产物下载地址（可换 OSS）默认 https://codeload.github.com/<repo>/tar.gz/refs/heads/<branch>
#   SITE_BASE_URL     备用源前缀             默认 https://github.com/<repo>/releases/download/<tag>
#   SITE_WEB_ROOT     站点根目录             默认 /var/www/myqian-bao.top
#   SITE_STATE_DIR    状态/历史版本目录       默认 /var/lib/site-pull
#   SITE_WEB_USER     站点目录属主           默认 www-data
#   SITE_KEEP         保留的历史版本数量      默认 3
#   SITE_DRY_RUN      设为 1：只下载解包，不同步（首次验证用）
#   SITE_FORCE        设为 1：忽略"已是最新"，强制同步一次
set -euo pipefail

REPO="${SITE_REPO:-Fire0King/Fire0King.github.io}"
BRANCH="${SITE_BRANCH:-site-dist}"
TAG="${SITE_TAG:-site-latest}"
ARCHIVE_URL="${SITE_ARCHIVE_URL:-https://codeload.github.com/${REPO}/tar.gz/refs/heads/${BRANCH}}"
BASE="${SITE_BASE_URL:-https://github.com/${REPO}/releases/download/${TAG}}"
WEB_ROOT="${SITE_WEB_ROOT:-/var/www/myqian-bao.top}"
STATE_DIR="${SITE_STATE_DIR:-/var/lib/site-pull}"
WEB_USER="${SITE_WEB_USER:-www-data}"
KEEP="${SITE_KEEP:-3}"
LOCK_FILE="${SITE_LOCK_FILE:-/run/site-pull.lock}"

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
die() { log "❌ $*"; exit 1; }

TMP_DIR=""
cleanup() { [ -n "$TMP_DIR" ] && rm -rf "$TMP_DIR"; }
trap 'cleanup; die "同步失败（脚本第 $LINENO 行）"' ERR

# ① 依赖检查
for pair in "curl:curl" "tar:tar" "rsync:rsync" "flock:util-linux"; do
	cmd="${pair%%:*}"
	pkg="${pair##*:}"
	command -v "$cmd" >/dev/null || die "缺少命令 $cmd，请先安装：apt install -y $pkg"
done

# ② 单实例：上一次还没跑完就跳过，避免并发写同一个目录
mkdir -p "$STATE_DIR"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
	log "上一次同步还在进行，本次跳过"
	exit 0
fi

TMP_DIR="$(mktemp -d "$STATE_DIR/tmp.XXXXXX")"

# ③ 取远端版本号：优先 git ls-remote（走 github.com，只有几十字节而且快）；
#    没有 git 时退回 Release 里那个 179 字节的 version.json。
REMOTE_SHA=""
if command -v git >/dev/null; then
	REMOTE_SHA="$(git ls-remote "https://github.com/${REPO}" "refs/heads/${BRANCH}" 2>/dev/null | cut -f1 || true)"
	REMOTE_SHA="${REMOTE_SHA%%$'\n'*}"
	[ -n "$REMOTE_SHA" ] && log "远端 ${BRANCH} = ${REMOTE_SHA:0:7}"
fi
if [ -z "$REMOTE_SHA" ]; then
	if curl -fsSL --retry 3 --retry-delay 3 --connect-timeout 15 --max-time 60 \
		-o "$TMP_DIR/version.json" "$BASE/version.json"; then
		REMOTE_SHA="$(sed -n 's/.*"sha"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$TMP_DIR/version.json")"
		REMOTE_SHA="${REMOTE_SHA%%$'\n'*}"
	fi
	[ -n "$REMOTE_SHA" ] || die "取不到远端版本号（git ls-remote 与 Release version.json 都不通）—— 先在服务器上确认能访问 GitHub：curl -I https://github.com（见文档 5.5.5 节）"
fi

STATE_FILE="$STATE_DIR/current-sha"
LOCAL_SHA="$(cat "$STATE_FILE" 2>/dev/null || true)"
if [ "$LOCAL_SHA" = "$REMOTE_SHA" ] && [ "${SITE_FORCE:-0}" != "1" ]; then
	log "已是最新版本 ${REMOTE_SHA:0:7}，无需更新"
	exit 0
fi

if [ -n "$LOCAL_SHA" ]; then
	log "发现新版本 ${REMOTE_SHA:0:7}（当前 ${LOCAL_SHA:0:7}）"
else
	log "首次部署，开始拉取 ${REMOTE_SHA:0:7}"
fi

# ④ 下载产物：主源 codeload 分支归档，失败退回 Release 附件
START_TS="$(date +%s)"
if ! curl -fsSL --retry 3 --retry-delay 5 --connect-timeout 15 --max-time 600 \
	-o "$TMP_DIR/site.tgz" "$ARCHIVE_URL"; then
	log "⚠ 主源下载失败（$ARCHIVE_URL），改用备用源"
	if ! curl -fsSL --retry 3 --retry-delay 5 --connect-timeout 15 --max-time 600 \
		-o "$TMP_DIR/site.tgz" "$BASE/site.tar.gz"; then
		die "主源与备用源都下载失败"
	fi
fi
log "下载完成：$(du -h "$TMP_DIR/site.tgz" | cut -f1)，用时 $(( $(date +%s) - START_TS ))s"

# ⑤ 解包到独立版本目录：先验证，确认无误才动线上目录
tar -tzf "$TMP_DIR/site.tgz" >"$TMP_DIR/list.txt"
STRIP_OPTS=()
if ! grep -qE '^(\./)?index\.html$' "$TMP_DIR/list.txt"; then
	# codeload 的分支归档会多一层 <仓库>-<分支>/ 目录
	STRIP_OPTS=(--strip-components=1)
fi
REL_DIR="$STATE_DIR/releases/$REMOTE_SHA"
rm -rf "$REL_DIR"
mkdir -p "$REL_DIR"
tar -xzf "$TMP_DIR/site.tgz" -C "$REL_DIR" "${STRIP_OPTS[@]}"
if [ ! -f "$REL_DIR/index.html" ]; then
	die "产物里没有 index.html，拒绝发布（列表前 5 项：$(head -n 5 "$TMP_DIR/list.txt" | tr '\n' ' '))"
fi

# ⑥ 同步到站点根目录（version.json 只是元数据，不放到网站上）
if [ "${SITE_DRY_RUN:-0}" = "1" ]; then
	log "SITE_DRY_RUN=1：已解包到 $REL_DIR，跳过同步（线上目录未改动）"
	exit 0
fi

mkdir -p "$WEB_ROOT"
rsync -a --delete --chown="$WEB_USER:$WEB_USER" \
	--exclude='.user.ini' --exclude='.well-known' --exclude='version.json' \
	"$REL_DIR/" "$WEB_ROOT/"
log "已同步到 $WEB_ROOT（属主 $WEB_USER）"

printf '%s' "$REMOTE_SHA" >"$STATE_FILE"
[ -f "$REL_DIR/version.json" ] && cp -f "$REL_DIR/version.json" "$STATE_DIR/version.json"

# ⑦ 只保留最近 N 个版本，方便回滚（回滚见文档第 7 节）
if [ -d "$STATE_DIR/releases" ]; then
	ls -1dt "$STATE_DIR/releases"/*/ 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
		log "清理旧版本 $(basename "$old")"
		rm -rf "$old"
	done
fi

BUILT_AT="$(sed -n 's/.*"built_at"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$STATE_DIR/version.json" 2>/dev/null || true)"
BUILT_AT="${BUILT_AT%%$'\n'*}"
log "✅ 发布完成：${REMOTE_SHA:0:7}（构建于 ${BUILT_AT:-未知}）"
