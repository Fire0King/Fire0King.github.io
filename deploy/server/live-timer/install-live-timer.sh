#!/usr/bin/env bash
# 一键安装「直播礼物加时器」（在服务器上以 root 执行）。
#
# 国内服务器推荐这么用（Release 附件走 githubusercontent，经常 SSL unexpected eof）：
#   curl -fsSL --retry 3 -o /tmp/repo.tgz https://codeload.github.com/Fire0King/Fire0King.github.io/tar.gz/refs/heads/main
#   mkdir -p /tmp/repo && tar -xzf /tmp/repo.tgz -C /tmp/repo --strip-components=1
#   sudo SITE_LOCAL_DIR=/tmp/repo/deploy/server/live-timer bash /tmp/repo/deploy/server/live-timer/install-live-timer.sh
#
# 或者从自己的电脑传上去：
#   scp -r deploy/server/live-timer root@<服务器>:/tmp/lt
#   sudo SITE_LOCAL_DIR=/tmp/lt/live-timer bash /tmp/lt/live-timer/install-live-timer.sh
#
# 作用：常驻一个进程连 B 站弹幕，把「还剩多久」写成站点根目录下的 api/live-timer.json，
#      前端页面（/live-timer/）轮询它，OBS 里加个浏览器源就完事。
#
# 环境变量：
#   SITE_LOCAL_DIR  本地文件目录（含 live-timer.mjs / .service / .config.example.json），设了就不联网取
#   SITE_BASE_URL   Release 前缀（默认走 site-latest，国内可能不通）
#   SITE_BRANCH     codeload 兜底用的分支（默认 main）
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
DATA_DIR=/var/lib/live-timer
# 运行配置放在 /var/lib/live-timer：服务以 www-data 运行，网页保存时能原子改写它
# /etc/live-timer 只放口令（admin.json，root:www-data 0640，网页改不了它）
CONF_FILE="$DATA_DIR/config.json"
ADMIN_FILE="$CONF_DIR/admin.json"
BIN=/usr/local/bin/live-timer.mjs
OUT_FILE="$WEB_ROOT/api/live-timer.json"

if [ "$(id -u)" != "0" ]; then
	echo "请用 root 执行：sudo bash $0" >&2
	exit 1
fi

echo "== 1/7 检查 Node =="
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

echo "== 2/7 准备文件 =="
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# 三条来路，按可靠性排序：
#   ① SITE_LOCAL_DIR：你已经把 deploy/server/live-timer/ 拷到服务器上了（最稳）
#   ② Release 附件：走 objects.githubusercontent.com —— 国内服务器经常 SSL unexpected eof
#   ③ codeload 源码包：走 codeload.github.com —— 和 pull-site.sh 同一条路，一般能通
SRC_DIR="${SITE_LOCAL_DIR:-}"
if [ -n "$SRC_DIR" ]; then
	if [ ! -d "$SRC_DIR" ]; then
		echo "❌ SITE_LOCAL_DIR 不存在：$SRC_DIR" >&2
		exit 1
	fi
	echo "来源：本地目录 $SRC_DIR"
fi

if [ -z "$SRC_DIR" ]; then
	mkdir -p "$TMP_DIR/fetch"
	ok=1
	for f in live-timer.mjs live-timer.service live-timer.config.example.json; do
		if ! curl -fsSL --retry 3 --retry-delay 3 --connect-timeout 15 --max-time 120 \
			-o "$TMP_DIR/fetch/$f" "$BASE/$f"; then
			ok=0
			echo "⚠️ Release 取 $f 失败（国内服务器常见：objects.githubusercontent.com 不通），改用源码包" >&2
			break
		fi
	done
	if [ "$ok" = "1" ]; then
		SRC_DIR="$TMP_DIR/fetch"
		echo "来源：Release 附件"
	fi
fi

if [ -z "$SRC_DIR" ]; then
	SRC_BRANCH="${SITE_BRANCH:-main}"
	echo "来源：codeload 源码包（${SRC_BRANCH}）"
	if ! curl -fsSL --retry 3 --retry-delay 5 --connect-timeout 15 --max-time 300 \
		-o "$TMP_DIR/repo.tgz" "https://codeload.github.com/${REPO}/tar.gz/refs/heads/${SRC_BRANCH}"; then
		echo "❌ 源码包也拉不下来。最省事的办法是从你电脑上传过去：" >&2
		echo "   scp -r deploy/server/live-timer root@<这台服务器>:/tmp/lt" >&2
		echo "   sudo SITE_LOCAL_DIR=/tmp/lt/live-timer bash /tmp/lt/live-timer/install-live-timer.sh" >&2
		exit 1
	fi
	mkdir -p "$TMP_DIR/repo"
	tar -xzf "$TMP_DIR/repo.tgz" -C "$TMP_DIR/repo" --strip-components=1
	SRC_DIR="$TMP_DIR/repo/deploy/server/live-timer"
fi

if [ ! -f "$SRC_DIR/live-timer.mjs" ]; then
	echo "❌ $SRC_DIR 里没有 live-timer.mjs（目录不对？）" >&2
	exit 1
fi

install -m 0755 "$SRC_DIR/live-timer.mjs" "$BIN"
install -m 0644 "$SRC_DIR/live-timer.service" /etc/systemd/system/live-timer.service

echo "== 3/7 写配置 =="
mkdir -p "$CONF_DIR" "$DATA_DIR" "$WEB_ROOT/api"`nchown "$WEB_USER":"$WEB_USER" "$DATA_DIR" 2>/dev/null || true
if [ -f "$CONF_FILE" ]; then
	echo "已存在 $CONF_FILE，保留不动（要改：sudo nano $CONF_FILE）"
else
	TOKEN="${LIVE_TIMER_TOKEN:-$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)}"
	sed -e "s#1750753391#${ROOM_ID}#g" \
		-e "s#/var/www/myqian-bao.top#${WEB_ROOT}#g" \
		-e "s#换成你自己的长口令#${TOKEN}#" \
		"$SRC_DIR/live-timer.config.example.json" >"$CONF_FILE"
	# 由 www-data 持有：服务进程要能在网页上被保存配置时改写这个文件
	chown "$WEB_USER":"$WEB_USER" "$CONF_FILE"
	chmod 0600 "$CONF_FILE"
	echo "已生成 $CONF_FILE（控制口令：$TOKEN）"
fi
chown "$WEB_USER":"$WEB_USER" "$WEB_ROOT/api" 2>/dev/null || true

echo "== 4/7 试连一次 B 站弹幕 =="
if sudo -u "$WEB_USER" node "$BIN" --config "$CONF_FILE" --check; then
	echo "弹幕接口可达"
else
	echo "⚠️ 自检失败（多半是 getDanmuInfo 风控）。服务仍会启动并自动重试；" >&2
	echo "   若一直失败，在配置里填 cookie（浏览器登录后复制 SESSDATA=...）再重启。" >&2
fi

echo "== 5/7 启动服务 =="
systemctl daemon-reload
systemctl enable --now live-timer.service
sleep 2
systemctl --no-pager --lines=5 status live-timer.service || true

echo "== 6/7 设置网页登录口令 =="
if [ -f "$ADMIN_FILE" ]; then
	echo "已存在 $ADMIN_FILE，保留（要改：sudo node $BIN --config $CONF_FILE --set-password）"
else
	node "$BIN" --config "$CONF_FILE" --set-password >/tmp/.lt-pw 2>&1 || true
	chown root:"$WEB_USER" "$ADMIN_FILE" 2>/dev/null || true
	chmod 0640 "$ADMIN_FILE" 2>/dev/null || true
	grep -o '网页登录口令：.*' /tmp/.lt-pw 2>/dev/null || cat /tmp/.lt-pw 2>/dev/null
	rm -f /tmp/.lt-pw
	echo "（上面这串口令就是网页 ${REPO##*/} 站点 /live-timer/config/ 的登录口令）"
fi

echo "== 7/7 检查输出文件 =="
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
