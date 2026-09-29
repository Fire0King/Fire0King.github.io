#!/usr/bin/env bash
# 一键安装「服务器定时派发采集」（在服务器上以 root 执行）。
#
#   curl -fsSL https://github.com/Fire0King/Fire0King.github.io/releases/download/site-latest/install-dispatch.sh -o /tmp/dispatch-install.sh
#   sudo bash /tmp/dispatch-install.sh
#
# 作用：GitHub 的 schedule 不准时（实测 */10 实际 4~6 次/天），改由服务器每 10 分钟
#      调一次 Actions API 触发采集工作流。装完还需要放一个 GitHub 令牌（脚本最后会提示）。
set -euo pipefail

REPO="${LIVE_DATA_REPO:-Fire0King/Fire0King.github.io}"
TAG="${SITE_TAG:-site-latest}"
BASE="${SITE_BASE_URL:-https://github.com/${REPO}/releases/download/${TAG}}"
BIN=/usr/local/bin/live-data-dispatch.sh
ENV_FILE=/etc/default/live-data-dispatch
TOKEN_DIR=/etc/live-data-dispatch

if [ "$(id -u)" != "0" ]; then
	echo "请用 root 执行：sudo bash $0" >&2
	exit 1
fi

echo "== 1/5 检查依赖 =="
if ! command -v curl >/dev/null; then
	echo "正在安装 curl…"
	apt-get update -qq && apt-get install -y curl
fi
echo "curl OK：$(curl --version | head -n1)"

echo "== 2/5 检查能否访问 GitHub API =="
if ! curl -fsSI --connect-timeout 10 --max-time 20 https://api.github.com >/dev/null; then
	echo "❌ 服务器访问不了 api.github.com，派发无法工作：" >&2
	echo "   getent hosts api.github.com / curl -vI https://api.github.com" >&2
	exit 1
fi
echo "api.github.com 可达"

echo "== 3/5 下载脚本与 systemd 单元 =="
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
for f in live-data-dispatch.sh live-data-dispatch.service live-data-dispatch.timer; do
	if ! curl -fsSL --retry 3 --retry-delay 3 --connect-timeout 15 --max-time 120 \
		-o "$TMP_DIR/$f" "$BASE/$f"; then
		echo "❌ 下载 $f 失败：$BASE/$f" >&2
		echo "   若 404，说明仓库还没发布过含该文件的 Release（见 docs/deploy-own-server.md 第 5.6 节）" >&2
		exit 1
	fi
done
install -m 0755 "$TMP_DIR/live-data-dispatch.sh" "$BIN"
install -m 0644 "$TMP_DIR/live-data-dispatch.service" /etc/systemd/system/live-data-dispatch.service
install -m 0644 "$TMP_DIR/live-data-dispatch.timer" /etc/systemd/system/live-data-dispatch.timer

echo "== 4/5 写入配置 =="
install -d -m 0700 "$TOKEN_DIR"
cat >"$ENV_FILE" <<EOF
# 采集派发配置（改完：systemctl restart live-data-dispatch.timer）
LIVE_DATA_REPO=$REPO
LIVE_DATA_WORKFLOW=live-data.yml
LIVE_DATA_REF=main
LIVE_DATA_TOKEN_FILE=$TOKEN_DIR/token
EOF
chmod 0644 "$ENV_FILE"

echo "== 5/5 启用定时器（每 10 分钟一次）=="
systemctl daemon-reload
systemctl enable --now live-data-dispatch.timer
systemctl list-timers live-data-dispatch.timer --no-pager || true

if [ -s "$TOKEN_DIR/token" ]; then
	echo "✅ 已检测到令牌，安装完成。手动验证：sudo $BIN"
else
	cat <<EOF

⚠️ 还差最后一步：放一个 GitHub 令牌，否则派发会跳过。
   1. 打开 https://github.com/settings/personal-access-tokens/new
      · Token name 随填，Expiration 建议 90 天或更长
      · Repository access → Only select repositories → 选 Fire0King/Fire0King.github.io
      · Permissions → Repository permissions → 找到 Actions → 设为 Read and write
      · 生成后复制那串 github_pat_… （只显示一次）
   2. 在服务器上执行下面这行，把令牌粘进去（不会回显、不经过任何第三方）：

      sudo sh -c 'read -rsp "粘贴令牌后回车: " t; printf "%s" "\$t" > $TOKEN_DIR/token; chmod 600 $TOKEN_DIR/token; echo; echo 已保存'

   3. 验证（应输出 "✅ 已派发 live-data.yml"）：

      sudo $BIN
      journalctl -u live-data-dispatch.service -n 5 --no-pager
EOF
fi
