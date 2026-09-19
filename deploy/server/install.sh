#!/usr/bin/env bash
# 一键安装「服务器侧拉取部署」（在服务器上以 root 执行）。
#
#   curl -fsSL https://github.com/Fire0King/Fire0King.github.io/releases/download/site-latest/install.sh -o /tmp/site-install.sh
#   sudo bash /tmp/site-install.sh
#
# 脚本会：装依赖 → 验证能访问 GitHub → 下载拉取脚本与 systemd 单元 → 立即同步一次
#        → 启用每 2 分钟检查一次的定时器。无需入站 SSH，因此不会有异地登录告警。
#
# 可用环境变量覆盖（示例：SITE_WEB_ROOT=/www/wwwroot/myqian-bao.top sudo bash install.sh）：
#   SITE_REPO / SITE_TAG / SITE_BASE_URL / SITE_WEB_ROOT / SITE_WEB_USER / SITE_KEEP
set -euo pipefail

REPO="${SITE_REPO:-Fire0King/Fire0King.github.io}"
TAG="${SITE_TAG:-site-latest}"
BASE="${SITE_BASE_URL:-https://github.com/${REPO}/releases/download/${TAG}}"
WEB_ROOT="${SITE_WEB_ROOT:-/var/www/myqian-bao.top}"
WEB_USER="${SITE_WEB_USER:-www-data}"
KEEP="${SITE_KEEP:-3}"
BIN=/usr/local/bin/site-pull.sh
ENV_FILE=/etc/default/site-pull

if [ "$(id -u)" != "0" ]; then
	echo "请用 root 执行：sudo bash $0" >&2
	exit 1
fi

echo "== 1/6 检查依赖 =="
missing=""
for pair in "curl:curl" "tar:tar" "rsync:rsync" "flock:util-linux"; do
	cmd="${pair%%:*}"
	pkg="${pair##*:}"
	command -v "$cmd" >/dev/null || missing="$missing $pkg"
done
if [ -n "$missing" ]; then
	echo "缺少组件：$missing，正在安装…"
	apt-get update -qq
	# shellcheck disable=SC2086
	apt-get install -y $missing
fi
echo "依赖 OK：$(curl --version | head -n1)"

echo "== 2/6 验证能下载 Release 附件（侧拉取的前提）=="
# 注意：要测的是【附件地址】，不是 github.com —— 附件会跳转到 GitHub 的 CDN 主机
# release-assets.githubusercontent.com，国内部分网络只对它有影响。
if ! curl -fsSI -o /dev/null --connect-timeout 10 --max-time 30 "$BASE/version.json"; then
	echo "❌ 下载不了 $BASE/version.json。常见原因与处理：" >&2
	echo "   · DNS：getent hosts github.com / release-assets.githubusercontent.com" >&2
	echo "   · 只测试 github.com 能通不代表附件能通，请以上面这条命令为准" >&2
	echo "   · 确实不通时改用文档 5.5.5 节的 OSS 中转（把 SITE_BASE_URL 指过去即可）" >&2
	exit 1
fi
echo "附件可下载：$(curl -fsS --connect-timeout 10 --max-time 30 "$BASE/version.json")"

echo "== 3/6 下载拉取脚本与 systemd 单元 =="
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
for f in pull-site.sh site-pull.service site-pull.timer; do
	if ! curl -fsSL --retry 3 --retry-delay 3 --connect-timeout 15 --max-time 120 \
		-o "$TMP_DIR/$f" "$BASE/$f"; then
		echo "❌ 下载 $f 失败：$BASE/$f" >&2
		echo "   若提示 404，说明仓库里的 publish-site.yml 还没跑过、Release 还没生成。" >&2
		exit 1
	fi
done
install -m 0755 "$TMP_DIR/pull-site.sh" "$BIN"
install -m 0644 "$TMP_DIR/site-pull.service" /etc/systemd/system/site-pull.service
install -m 0644 "$TMP_DIR/site-pull.timer" /etc/systemd/system/site-pull.timer

echo "== 4/6 写入配置（$ENV_FILE）=="
cat >"$ENV_FILE" <<EOF
# 服务器侧拉取部署的配置（改完执行：systemctl restart site-pull.timer 或等下一轮）
SITE_REPO=$REPO
SITE_TAG=$TAG
SITE_BASE_URL=$BASE
SITE_WEB_ROOT=$WEB_ROOT
SITE_WEB_USER=$WEB_USER
SITE_KEEP=$KEEP
EOF
echo "站点根目录：$WEB_ROOT（属主 $WEB_USER）"

echo "== 5/6 立即同步一次（前台执行，便于看结果）=="
if [ ! -d "$WEB_ROOT" ]; then
	mkdir -p "$WEB_ROOT"
	echo "站点根目录不存在，已创建：$WEB_ROOT"
fi
if "$BIN"; then
	echo "首次同步成功"
else
	echo "⚠️ 首次同步失败（上面的日志里有原因）。定时器已配好，修好后可手动重试：sudo $BIN" >&2
fi

echo "== 6/6 启用定时器（每 2 分钟检查一次）=="
systemctl daemon-reload
systemctl enable --now site-pull.timer
systemctl list-timers site-pull.timer --no-pager || true

cat <<EOF

✅ 安装完成。常用命令：
  手动同步一次：   sudo $BIN
  看同步日志：     journalctl -u site-pull.service -n 50 --no-pager
  跟踪日志：       journalctl -u site-pull.service -f
  查看定时器：     systemctl list-timers site-pull.timer
  临时停用：       sudo systemctl disable --now site-pull.timer
  改配置：         sudo nano $ENV_FILE 然后 systemctl restart site-pull.timer

验证站点：curl -I http://127.0.0.1/ 或浏览器打开 http://<服务器IP>/
EOF
