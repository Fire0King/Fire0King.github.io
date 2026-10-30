# 直播礼物加时器（倒计时叠层）

直播间挂一个倒计时，观众送礼物就往上加时间，到点 00:00 可以继续变成「加班计时」。

整套东西只有两块：

| 部分 | 文件 | 跑在哪 |
| --- | --- | --- |
| 采集 + 计时服务 | `deploy/server/live-timer/live-timer.mjs` | 你的服务器（systemd 常驻，零依赖 Node 22+） |
| 倒计时叠层页面 | `src/pages/live-timer.astro` + `src/components/pages/live-timer/CountdownOverlay.svelte` | 站点静态页 `/live-timer/`，OBS 浏览器源直接抓 |

数据流向：B 站弹幕 WebSocket → 服务进程（礼物折算成秒数，维护结束时间戳）→ 每秒写 `api/live-timer.json` → 页面轮询渲染。

为什么是「写文件 + 轮询」而不是长连接：静态站没有 API 层，同源 JSON 最省事，断线、刷新、OBS 重开都能自愈；1 秒的延迟对礼物加时完全够用。

---

## 1. 服务器上装

```bash
curl -fsSL https://github.com/Fire0King/Fire0King.github.io/releases/download/site-latest/install-live-timer.sh -o /tmp/live-timer-install.sh
sudo bash /tmp/live-timer-install.sh
```

脚本会：检查 Node ≥ 22 → 装 `/usr/local/bin/live-timer.mjs` 和 systemd 服务 → 生成 `/var/lib/live-timer/config.json`（随机控制口令）→ 试连一次弹幕 → 启动服务 → **生成网页登录口令并打印** → 验证 `api/live-timer.json` 是否写出来了。

> **国内服务器报 `curl: (56) OpenSSL SSL_read: ... unexpected eof`？**
> Release 附件走 `objects.githubusercontent.com`，国内经常连不通（重试几次可能又通了）。
> 安装脚本内置三层兜底：`SITE_LOCAL_DIR` → Release → `codeload` 源码包，所以可以绕开它：
>
> ```bash
> # 方式 A：从自己的电脑把四个文件传上去（最快，总共约 40 KB）
> scp -r deploy/server/live-timer root@<服务器IP>:/tmp/lt
> sudo SITE_LOCAL_DIR=/tmp/lt/live-timer bash /tmp/lt/live-timer/install-live-timer.sh
>
> # 方式 B：走 codeload（和 pull-site.sh 同一条路；站点能自动更新就说明这条通）
> curl -fsSL --retry 4 -o /tmp/repo.tgz https://codeload.github.com/Fire0King/Fire0King.github.io/tar.gz/refs/heads/main
> mkdir -p /tmp/repo && tar -xzf /tmp/repo.tgz -C /tmp/repo --strip-components=1
> sudo SITE_LOCAL_DIR=/tmp/repo/deploy/server/live-timer bash /tmp/repo/deploy/server/live-timer/install-live-timer.sh
> ```

常用命令：

```bash
journalctl -u live-timer -f                 # 看日志
sudo nano /var/lib/live-timer/config.json       # 改配置
sudo systemctl restart live-timer           # 改完重启
node /usr/local/bin/live-timer.mjs --config /var/lib/live-timer/config.json --check      # 只自检连通性
node /usr/local/bin/live-timer.mjs --config /var/lib/live-timer/config.json --self-test  # 离线自检
```

> `--check` 走的是真实的 `getDanmuInfo`（带 wbi 签名），能拿到弹幕服务器列表就说明签名/IP 没问题。
> 返回 `-352` 一般是 IP 被风控：在配置里填 `cookie`（浏览器登录 B 站后复制 `SESSDATA=xxx`）再试。

### 注意：重新部署站点不会删掉状态文件

`pull-site.sh` 里已经排除了 `api/live-timer.json`，否则每次 `rsync --delete` 都会把服务刚写的文件删掉。

---

## 2. 配置说明

配置文件在 /var/lib/live-timer/config.json（属主 www-data，网页保存时由服务原子改写）；口令在 /var/lib/live-timer/admin.json（www-data 0600）。

```jsonc
{
  "roomId": 1750753391,          // 直播间号，短号长号都行
  "host": "127.0.0.1",           // 控制接口只监听本机
  "port": 8848,
  "adminToken": "换成随机长口令",  // 控制口令，留空则只允许 127.0.0.1 调用
  "outFile": "/var/www/myqian-bao.top/api/live-timer.json",
  "stateFile": "/var/lib/live-timer/state.json", // 重启后断点续计用

  "initialMinutes": 120,         // 开局给多少分钟
  "paused": false,
  "ignoreSilverGifts": true,     // 免费礼物（银瓜子）不加时
  "cnyToMinutes": 1,             // 没命中 gifts 表的礼物：1 元 = 1 分钟
  "priceUnit": 1000,             // 礼物 price 字段的单位（金瓜子 1000 = 1 元）

  // 指定礼物「每一个」加/减多久（键可以是礼物名，也可以是 giftId）
  // 实际生效会乘礼物数量：小花花 ×3 = 2 × 3 = 6 分钟
  "gifts": {
    "小心心": 0,
    "辣条": 0,
    "小花花": 2,
    "粉丝团灯牌": -0.1
  },

  // 大航海：1 舰长 / 2 提督 / 3 总督
  "guards": { "1": 30, "2": 60, "3": 120 },

  // 防翻车
  "caps": {
    "perGiftMinutes": 60,        // 单次礼物最多加 60 分钟
    "perUserPerMinute": 10,      // 同一人 1 分钟内最多加 10 分钟（0 = 不限）
    "totalMinutes": 480          // 整场最多加 8 小时（0 = 不限）
  }
}
```

几条实践建议：

- **一定要设 `caps.totalMinutes`**。直播间一热闹真的能给你加到天亮，给自己留个上限。
- 想按「1 元 = 30 秒」就写 `"cnyToMinutes": 0.5`，想「1 元 = 2 分钟」写 `2`。
- 礼物名以弹幕里推送的 `giftName` 为准（B 站偶尔改名），不确定就先只留 `cnyToMinutes` 按价格算。
- `gifts` 里写 `0` 表示这个礼物不加时，正好用来屏蔽刷屏的小礼物。
- `gifts` 里的分钟数**按每一个算，自动乘数量**：写 `2`，有人送 ×10 就是 +20 分钟；写 `-0.1`，送 ×100 个灯牌就是 -10 分钟。负数即减时，减到 0 为止。
- 送 100 个只推送**一次**事件（`num: 100`），所以乘数量是唯一正确的算法；不要按「事件次数」估。
- **盲盒礼物**（假面盲盒、幸运盲盒、狂欢盲盒…礼物面板里 `gift_type=6`）：B 站推过来的是「开出来的奖品」（比如南瓜假面、蝠影马车），**真正花掉的钱在 `blind_gift.original_gift_price` 里**。程序按盒子实付价折算，所以礼物表里写盒子名即可（如 `"假面盲盒": 9`）；日志和配置页会附注「开出 ×××」。

---

## 3. 页面与 OBS

页面地址：`https://你的域名/live-timer/`

OBS 里加「浏览器源」：

- URL 填上面的地址（建议带参数，见下表）
- 宽高 `1920 × 1080`（和画布一致，让叠层自己定位）
- 勾上「使用自定义帧率」可关掉；背景默认就是透明的

| 参数 | 默认 | 作用 |
| --- | --- | --- |
| `pos` | `bl` | 停靠位置：`bl/bc/br/tl/tc/tr` |
| `scale` | `1` | 整体缩放，`1.5` 这种 |
| `label` | `距下播还有` | 顶部文案 |
| `accent` | `%23FB7299` | 主色（记得 URL 里 `#` 写成 `%23`） |
| `theme` | `dark` | `dark` / `light` |
| `gifts` | 开 | `gifts=0` 关掉礼物飘屏 |
| `rules` | 开 | `rules=0` 关掉倒计时上方的礼物价目（「10 个人气票 = +1 分钟」那条） |
| `bar` | 开 | `bar=0` 只留大数字 |
| `overtime` | 开 | `overtime=0` 到点就停在 `00:00` |
| `bg` | 关 | `bg=1` 加个深色底，方便自己调样式时看清 |
| `admin` | 关 | `admin=1` 显示控制台，**别放进 OBS 源** |

例子：

```
https://myqian-bao.top/live-timer/?pos=br&scale=1.2&label=今天还能播
```

### 配置台（网页上直接改，要口令）

导航栏「直播配置」→ `https://你的域名/live-timer/config/`

页面分两块：

- **服务器配置（需要口令）**：登录后直接读/写服务器上的 `/var/lib/live-timer/config.json`，点「保存到服务器」立刻生效，不用 SSH、不用重启。开局时长在下次「重新开局」时生效，礼物规则、上限、直播间号立即生效（改直播间号会自动重连弹幕）。
- **叠层样式（公开，不用口令）**：位置、缩放、文案、主色、主题、飘屏/礼物价目/进度条开关。这些只影响 URL，右边实时预览（`mock=1` 本地假数据），改完复制「OBS 地址」即可。

安全设计：

| 项 | 做法 |
| --- | --- |
| 口令存储 | 只存 scrypt 哈希（`/var/lib/live-timer/admin.json`，`0600 www-data`），不可逆推，网页拿不到明文 |
| 登录态 | 登录后发一个 HMAC 签名令牌（8 小时），之后请求带 `Authorization: Bearer`；令牌过期或伪造一律 401 |
| 爆破防护 | 同一 IP 10 分钟内错 5 次锁 5 分钟（锁定期内正确口令也进不去），失败会写日志 |
| 写入范围 | 只接受白名单字段（`roomId` / `initialMinutes` / `cnyToMinutes` / `ignoreSilverGifts` / `gifts` / `guards` / `caps`），`outFile`、`stateFile`、`adminToken` 这类字段即使传了也会被忽略 |
| 改口令 | 登录后页面里「修改网页登录口令」：填当前口令 + 新口令即可；改完会换签名密钥，**其它设备上的登录立刻失效**，当前页面自动续约 |
| 传输 | 只走 HTTPS（nginx 443）；管理接口不返回 CORS 头，跨站脚本读不到 |

口令两种改法：

1. **网页上改（推荐）**：登录 → 展开「修改网页登录口令」→ 填当前口令、新口令（≥6 位，可用中文）、再输一次 → 保存。
2. **服务器上改（忘记口令时用）**：

```bash
sudo node /usr/local/bin/live-timer.mjs --config /var/lib/live-timer/config.json --set-password 你的新口令
# 不给参数 = 随机生成并打印
chown www-data:www-data /var/lib/live-timer/admin.json && chmod 0600 /var/lib/live-timer/admin.json
```

两种方式都不用重启服务，下一次登录就用新口令。

### 网页控制台（可选）

`?admin=1` 打开后可以「重新开局 / 暂停 / 继续 / ±分钟」，需要在 nginx 里把 `/live-timer-api/` 反代到本机 8848：

```nginx
location /live-timer-api/ {
    proxy_pass http://127.0.0.1:8848/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_read_timeout 60s;
    add_header Cache-Control "no-store";
}

# 状态文件别让浏览器缓存
location = /api/live-timer.json {
    add_header Cache-Control "no-store";
    try_files $uri =404;
}
```

改完 `nginx -t && systemctl reload nginx`。不想开控制台也可以直接在服务器上 curl：

```bash
curl -s -X POST -H 'x-timer-token: 你的口令' -H 'content-type: application/json' \
  -d '{"action":"pause"}' http://127.0.0.1:8848/control
```

`action` 支持：`start`（重新开局）、`pause`、`resume`、`add`（配 `minutes`）、`sub`、`demoGift`（配 `seconds`，本地调样式用）。

---

## 4. 本地调样式（不用开播）

```bash
# 造一份配置，outFile 指到临时目录即可
node deploy/server/live-timer/live-timer.mjs --config ./tmp.json --demo
```

然后开 `pnpm dev`，访问 `http://localhost:4321/live-timer/?admin=1&bg=1`，
控制台里点「+10 分」，或者：

```bash
curl -X POST -H 'x-timer-token: test' -H 'content-type: application/json' \
  -d '{"action":"demoGift","seconds":90,"user":"小明","label":"小花花"}' \
  http://127.0.0.1:8848/control
```

就能看到礼物飘屏和进度条变化，不用真的收礼物。

---

## 5. 常见问题

**页面一直 `--:--`**
服务没写文件。`journalctl -u live-timer -n 30` 看报错；`ls -l /var/www/.../api/live-timer.json` 看有没有、时间戳是不是在动。

**日志里 `getDanmuInfo 失败 code=-352`**
签名或 IP 被风控。先 `--check` 复现；填 `cookie`（`SESSDATA=...`）通常能解决；还不能就连换网络/换机器试。

**礼物没加时**
① 免费礼物被 `ignoreSilverGifts` 挡了；② 命中 `gifts` 里的 0；③ 触发 `perUserPerMinute` 限速（日志会写「触发单人限速」）；④ 已到 `totalMinutes` 上限。

**时间加多了（一次礼物算两次）**
B 站连击会推多条 `SEND_GIFT`。服务端按 `uid+giftId+时间戳+combo` 去重，如果还重复，把 `caps.perGiftMinutes` 调小先兜底，然后把日志里那几条 `timestamp`/`combo_num` 发我，我补规则。

**重启服务器会不会清零**
不会。`stateFile` 存了 deadline，重启后接着走；要重开一场点「重新开局」（`start`）。

**改了页面参数 OBS 里没变**
OBS 浏览器源有缓存，右键源 →「刷新页面缓存」；参数本身在 URL 上，改 URL 后必须刷新。

---

## 6. 一点提醒

礼物换时长本质是打赏激励：别包装成抽奖、盲盒或「送礼必做某事」的承诺，B 站对礼物抽奖有单独规则，这类玩法容易被判违规。设好单次和整场上限，也给自己留条退路。
