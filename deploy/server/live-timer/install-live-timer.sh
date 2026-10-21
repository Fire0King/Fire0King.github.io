#!/usr/bin/env bash
# 一键安装「直播礼物加时器」（在服务器上以 root 执行）。
#
#   curl -fsSL https://github.com/Fire0King/Fire0King.github.io/releases/download/site-latest/install-live-timer.sh -o /tmp/live-timer-install.sh
#   sudo bash /tmp/live-timer-install.sh
#
# 作用：常驻一个进程连 B 站弹幕，把「还剩多久」写成站点根目录下的 api/live-timer.json，
#      前端页面（/live-timer/）轮询它，OBS 里加个浏览器源就完事。
#
# 环境变量：
#   SITE_BASE_URL   文件下载地址（默认走站点 Release，含 live-timer.mjs / .service / .config.example.json）
#   SITE_WEB_ROOT   站点根目录（默认 /var/www/myqian-bao.top）
#   LIVE_TIMER_ROOM_ID  直播间号（默认取脚本里的 1750753391）
#   LIVE_TIMER_TOKEN    控制口令（默认随机生成）
set -euo pipefail

REPO="${SITE_REPO:-Fire0King/Fire0King.github.io}"
TAG="${SITE_TAG:-site-latest}"
BASE="${SITE_BASE_URL:-https://github.com/${REPO}/releases/download/${TAG}}"
WEB_ROOT="${SITE_WEB_ROOT:-/var/www/myqian-bao.top}"
WEB_USER="${SITE_WEB_USER:-www-data}"
ROOM_ID="${LIVE_TIMER_ROOM_ID:-1750753391}"
CONF_DIR=/etc/live-timer
CONF_FILE="$CONF_DIR/config.json"
BIN=/usr/local/bin/live-timer.mjs
OUT_FILE="$WEB_ROOT/api/live-timer.json"

if [ "$(id -u)" != "0" ]; then
	echo "请用 root 执行：sudo bash $0" >&2
	exit 1
fi

echo "== 1/6 检查 Node =="
if ! command -v node >/dev/null; then
	echo "❌ 没装 Node。本工具需要 Node 22+（要用内置 WebSocket），建议：" >&2
	echo "   curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs" >&2
	exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
	echo "❌ Node 版本太低（$(node -v)），需要 22+。升级：" >&2
	echo "   curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs" >&2
	exit 1
fi
echo "Node $(node -v) OK"

echo "== 2/6 下载脚本与 systemd 单元 =="
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
for f in live-timer.mjs live-timer.service live-timer.config.example.json; do
	if ! curl -fsSL --retry 3 --retry-delay 3 --connect-timeout 15 --max-time 120 \
		-o "$TMP_DIR/$f" "$BASE/$f"; then
		echo "❌ 下载 $f 失败：$BASE/$f（若 404，说明 Release 还未包含该文件）" >&2
		exit 1
	fi
done
install -m 0755 "$TMP_DIR/live-timer.mjs" "$BIN"
install -m 0644 "$TMP_DIR/live-timer.service" /etc/systemd/system/live-timer.service

echo "== 3/6 写配置 =="
mkdir -p "$CONF_DIR" "$WEB_ROOT/api"
if [ -f "$CONF_FILE" ]; then
	echo "已存在 $CONF_FILE，保留不动（要改：sudo nano $CONF_FILE）"
else
	TOKEN="${LIVE_TIMER_TOKEN:-$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)}"
	sed -e "s#1750753391#${ROOM_ID}#g" \
		-e "s#/var/www/myqian-bao.top#${WEB_ROOT}#g" \
		-e "s#换成你自己的长口令#${TOKEN}#" \
		"$TMP_DIR/live-timer.config.example.json" >"$CONF_FILE"
	chown root:"$WEB_USER" "$CONF_FILE"
	chmod 0640 "$CONF_FILE"
	echo "已生成 $CONF_FILE（控制口令：$TOKEN）"
fi
chown "$WEB_USER":"$WEB_USER" "$WEB_ROOT/api" 2>/dev/null || true

echo "== 4/6 试连一次 B 站弹幕 =="
if sudo -u "$WEB_USER" node "$BIN" --config "$CONF_FILE" --check; then
	echo "弹幕接口可达"
else
	echo "⚠️ 自检失败（多半是 getDanmuInfo 风控）。服务仍会启动并自动重试；" >&2
	echo "   若一直失败，在配置里填 cookie（浏览器登录后复制 SESSDATA=...）再重启。" >&2
fi

echo "== 5/6 启动服务 =="
systemctl daemon-reload
systemctl enable --now live-timer.service
sleep 2
systemctl --no-pager --lines=5 status live-timer.service || true

echo "== 6/6 检查输出文件 =="
if [ -f "$OUT_FILE" ]; then
	echo "✅ 已开始写 $OUT_FILE"
	head -c 200 "$OUT_FILE"; echo
else
	echo "⚠️ 还没写出来，看日志：journalctl -u live-timer -n 30 --no-pager" >&2
fi

cat <<EOF

✅ 安装完成。常用命令：
  看日志：   journalctl -u live-timer -f
  改配置：   sudo nano $CONF_FILE && sudo systemctl restart live-timer
  暂停/继续：curl -s -X POST -H 'x-timer-token: <口令>' -H 'content-type: application/json' \\
               -d '{"action":"pause"}' http://127.0.0.1:8848/control

OBS 浏览器源地址：https://你的域名/live-timer/
（想用网页控制台就加 ?admin=1，在页面上填口令）

要让网页上的控制台能用，还需要 nginx 反代本机 8848 端口，把这段加进站点的 server 块：
  location /live-timer-api/ {
      proxy_pass http://127.0.0.1:8848/;
      proxy_http_version 1.1;
      proxy_set_header Host \$host;
      proxy_read_timeout 60s;
      add_header Cache-Control "no-store";
  }
再加一条，避免状态文件被缓存：
  location = /api/live-timer.json {
      add_header Cache-Control "no-store";
      try_files \$uri =404;
  }
改完：nginx -t && systemctl reload nginx
EOF
