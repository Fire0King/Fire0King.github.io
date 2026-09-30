#!/usr/bin/env bash
# 实时直播状态轮询：查 B 站直播间，把结果写成一份 JSON 供页面实时读取。
#
# 为什么不走 GitHub Actions：
#   GitHub 的 schedule 会被降频（实测本仓库 4~6 次/天），而页面需要的是"此刻是否在播"。
#   服务器直连 B 站接口没有这个问题，而且输出和站点同源，页面 fetch 不受 CORS 限制。
#
# 请求要点：带 User-Agent + Referer，**不要**带外站 Origin（带 Origin 会被 B 站 403 拒爬）。
#
# 输出：默认 /var/www/myqian-bao.top/api/live-status.json
#       该文件已在 pull-site.sh 的 rsync 排除列表里，不会被 --delete 删掉。
set -euo pipefail

ROOM_ID="${LIVE_STATUS_ROOM_ID:-1750753391}"
OUT="${LIVE_STATUS_OUT:-/var/www/myqian-bao.top/api/live-status.json}"
UA="${LIVE_STATUS_UA:-Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36}"
API="${LIVE_STATUS_API:-https://api.live.bilibili.com/room/v1/Room/get_info}"

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }

RAW="$(curl -fsS --connect-timeout 8 --max-time 20 \
	-H "User-Agent: $UA" \
	-H "Referer: https://live.bilibili.com/" \
	"$API?room_id=$ROOM_ID")" || { log "❌ 拉取直播间信息失败（保留上一次的 JSON）"; exit 1; }

# 优先用 python3 解析；没有 python3 就退回 grep（字段都很规整）
if command -v python3 >/dev/null; then
	PARSED="$(printf '%s' "$RAW" | python3 -c '
import json, sys
raw = sys.stdin.read()
try:
    d = json.loads(raw).get("data") or {}
except Exception:
    print(json.dumps({"ok": False}))
    raise SystemExit
status = int(d.get("live_status") or 0)
print(json.dumps({
    "ok": True,
    "status": status,
    "live": status == 1,
    "title": (d.get("title") or "").strip(),
    "online": int(d.get("online") or 0),
    "followers": int(d.get("attention") or 0),
    "startedAt": (d.get("live_time") or "").strip(),
    "area": (d.get("area_name") or "").strip(),
}, ensure_ascii=False))
')"
else
	getnum() { printf '%s' "$RAW" | grep -oE "\"$1\": *[0-9]+" | head -n1 | grep -oE '[0-9]+' || echo 0; }
	getstr() { printf '%s' "$RAW" | grep -oE "\"$1\": *\"[^\"]*\"" | head -n1 | sed -E 's/.*: *"([^"]*)"/\1/' || echo ""; }
	STATUS="$(getnum live_status)"
	LIVE=false
	[ "$STATUS" = "1" ] && LIVE=true
	PARSED="$(printf '{"ok":true,"status":%s,"live":%s,"title":"%s","online":%s,"followers":%s,"startedAt":"%s","area":"%s"}' \
		"$STATUS" "$LIVE" "$(getstr title)" "$(getnum online)" "$(getnum attention)" "$(getstr live_time)" "$(getstr area_name)")"
fi

if ! printf '%s' "$PARSED" | grep -q '"ok": *true'; then
	log "❌ 接口返回无法解析：$(printf '%s' "$RAW" | head -c 200)"
	exit 1
fi

JSON="$(printf '{"updatedAt":"%s","source":"server-poller","roomId":"%s","roomUrl":"https://live.bilibili.com/%s","bilibili":%s}' \
	"$(TZ=Asia/Shanghai date '+%Y-%m-%dT%H:%M:%S%:z')" "$ROOM_ID" "$ROOM_ID" "$PARSED")"

mkdir -p "$(dirname "$OUT")"
# 原子替换：先写临时文件再 mv，页面永远读不到写了一半的内容
printf '%s\n' "$JSON" >"$OUT.tmp"
chmod 0644 "$OUT.tmp"
mv -f "$OUT.tmp" "$OUT"

LIVE_TXT="未开播"
[ "$(printf '%s' "$PARSED" | grep -oE '"live": *(true|false)' | grep -oE 'true|false')" = "true" ] && LIVE_TXT="直播中"
log "✅ 已更新（$LIVE_TXT）→ $OUT"
