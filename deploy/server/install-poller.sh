#!/usr/bin/env bash
# 一键安装「实时直播状态轮询」（在服务器上以 root 执行）。
#
#   curl -fsSL https://github.com/Fire0King/Fire0King.github.io/releases/download/site-latest/install-poller.sh -o /tmp/poller-install.sh
#   sudo bash /tmp/poller-install.sh
#
# 作用：每 30 秒查一次 B 站直播间，把结果写到站点根目录下的 api/live-status.json，
#      直播页前端直接 fetch 它 —— 不依赖 GitHub Actions 的调度，也不需要 Node/Go。
set -euo pipefail

REPO="${SITE_REPO:-Fire0King/Fire0King.github.io}"
TAG="${SITE_TAG:-site-latest}"
BASE="${SITE_BASE_URL:-https://github.com/${REPO}/releases/download/${TAG}}"
WEB_ROOT="${SITE_WEB_ROOT:-/var/www/myqian-bao.top}"
WEB_USER="${SITE_WEB_USER:-www-data}"
ROOM_ID="${LIVE_STATUS_ROOM_ID:-1750753391}"
BIN=/usr/local/bin/live-status-poller.sh
ENV_FILE=/etc/default/live-status-poller
OUT_FILE="$WEB_ROOT/api/live-status.json"

if [ "$(id -u)" != "0" ]; then
	echo "请用 root 执行：sudo bash $0" >&2
	exit 1
fi

echo "== 1/5 检查依赖 =="
command -v curl >/dev/null || { apt-get update -qq && apt-get install -y curl; }
command -v python3 >/dev/null && echo "python3：$(python3 -V)" || echo "提示：没有 python3，脚本会退回 grep 解析（够用，但建议装上）"
echo "curl OK"

echo "== 2/5 试拉一次 B 站接口 =="
code="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 8 --max-time 20 \
	-H "User-Agent: Mozilla/5.0" -H "Referer: https://live.bilibili.com/" \
	"https://api.live.bilibili.com/room/v1/Room/get_info?room_id=$ROOM_ID" || true)"
if [ "$code" != "200" ]; then
	echo "❌ B 站接口返回 HTTP ${code:-无响应}。注意必须带 Referer、且不要带 Origin。" >&2
	exit 1
fi
echo "接口可达（HTTP 200）"

echo "== 3/5 下载脚本与 systemd 单元 =="
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
for f in live-status-poller.sh live-status-poller.service live-status-poller.timer; do
	if ! curl -fsSL --retry 3 --retry-delay 3 --connect-timeout 15 --max-time 120 \
		-o "$TMP_DIR/$f" "$BASE/$f"; then
		echo "❌ 下载 $f 失败：$BASE/$f（若 404，说明 Release 还未包含该文件）" >&2
		exit 1
	fi
done
install -m 0755 "$TMP_DIR/live-status-poller.sh" "$BIN"
install -m 0644 "$TMP_DIR/live-status-poller.service" /etc/systemd/system/live-status-poller.service
install -m 0644 "$TMP_DIR/live-status-poller.timer" /etc/systemd/system/live-status-poller.timer

echo "== 4/5 写配置并立刻跑一次 =="
mkdir -p "$WEB_ROOT/api"
cat >"$ENV_FILE" <<EOF
# 实时直播状态轮询配置（改完：systemctl restart live-status-poller.timer）
LIVE_STATUS_ROOM_ID=$ROOM_ID
LIVE_STATUS_OUT=$OUT_FILE
EOF
chmod 0644 "$ENV_FILE"
if "$BIN"; then
	echo "首次写入成功：$OUT_FILE"
	chown "$WEB_USER:$WEB_USER" "$OUT_FILE" 2>/dev/null || true
	head -c 300 "$OUT_FILE"; echo
else
	echo "⚠️ 首次写入失败（上面的日志里有原因）；定时器已配好，之后会自动重试" >&2
fi

echo "== 5/5 启用定时器（每 30 秒） =="
systemctl daemon-reload
systemctl enable --now live-status-poller.timer
systemctl list-timers live-status-poller.timer --no-pager || true

cat <<EOF

✅ 安装完成。常用命令：
  立刻跑一次：   sudo $BIN
  看日志：       journalctl -u live-status-poller.service -n 20 --no-pager
  看定时器：     systemctl list-timers live-status-poller.timer
  改配置：       sudo nano $ENV_FILE
  临时停用：     sudo systemctl disable --now live-status-poller.timer

注意：这个文件写在站点根目录的 api/ 下，已在 pull-site.sh 的 rsync 排除列表里，
      重新部署站点不会把它删掉（若你手动同步过站点，确认它还在）。
EOF
