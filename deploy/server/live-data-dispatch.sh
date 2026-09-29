#!/usr/bin/env bash
# 由服务器定时派发 GitHub Actions 的采集工作流。
#
# 为什么需要它：
#   GitHub 的 schedule 只是"尽力而为"。实测本仓库的 */10 cron 实际只跑了约 4~6 次/天
#   （间隔 149~500 分钟），导致开播后可能要好几小时才被采集到、页面上的"数据更新于"长期不动。
#   而 workflow_dispatch 是立即执行的，所以由服务器每 10 分钟调一次 API 触发采集，
#   频率就稳定了（GitHub 上原有的 cron 保留作为兜底）。
#
# 配置：/etc/default/live-data-dispatch（安装脚本会生成）
#   令牌文件里只放 PAT 本身，权限 600，属主 root。
set -euo pipefail

REPO="${LIVE_DATA_REPO:-Fire0King/Fire0King.github.io}"
WORKFLOW="${LIVE_DATA_WORKFLOW:-live-data.yml}"
REF="${LIVE_DATA_REF:-main}"
TOKEN_FILE="${LIVE_DATA_TOKEN_FILE:-/etc/live-data-dispatch/token}"
API="${LIVE_DATA_API:-https://api.github.com}"

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }

command -v curl >/dev/null || { log "❌ 缺少 curl"; exit 1; }

# 没配令牌不算故障：安静退出，避免每 10 分钟刷一条错误日志
if [ ! -r "$TOKEN_FILE" ]; then
	log "⚠ 还没配置令牌（$TOKEN_FILE 不存在），本次跳过 —— 配置步骤见 docs/deploy-own-server.md 第 5.6 节"
	exit 0
fi
TOKEN="$(tr -d '\r\n' <"$TOKEN_FILE")"
if [ -z "$TOKEN" ]; then
	log "⚠ 令牌文件为空（$TOKEN_FILE），本次跳过"
	exit 0
fi

OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT

CODE="$(curl -sS -o "$OUT" -w '%{http_code}' \
	--connect-timeout 15 --max-time 60 \
	-X POST \
	-H "Authorization: Bearer $TOKEN" \
	-H "Accept: application/vnd.github+json" \
	-H "X-GitHub-Api-Version: 2022-11-28" \
	-H "User-Agent: live-data-dispatch" \
	"$API/repos/$REPO/actions/workflows/$WORKFLOW/dispatches" \
	-d "{\"ref\":\"$REF\"}" || true)"

case "$CODE" in
204)
	log "✅ 已派发 $WORKFLOW（ref=$REF）"
	;;
401 | 403)
	log "❌ 令牌无效或权限不足（HTTP $CODE）：$(head -c 300 "$OUT")"
	exit 1
	;;
404)
	log "❌ 仓库或工作流不存在（HTTP 404）：$REPO / $WORKFLOW"
	exit 1
	;;
"")
	log "❌ 请求没有得到响应（检查服务器到 api.github.com 的网络）"
	exit 1
	;;
*)
	log "❌ 派发失败（HTTP $CODE）：$(head -c 300 "$OUT")"
	exit 1
	;;
esac
