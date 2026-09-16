# 直播数据页面（B站 / 抖音）

一个与主题风格一致的独立页面 `/live/`，展示两件事：

1. **直播月历**：每一天是否直播、是哪个平台、播了多久，以及当时的直播标题（点击日期看当天全部场次）。
2. **粉丝报表**：B站 / 抖音 分别用柱状图展示每日粉丝增减，并给出当前粉丝总数与区间净增。

数据以 JSON 形式存放在 `src/data/live/`，由 GitHub Actions 定时调用 [@ikenxuan/amagi](https://github.com/ikenxuan/amagi) 抓取 B站 / 抖音 的公开接口后写入。

```
src/config/live-report.config.json   # 唯一配置源（页面 + 抓取脚本共用）
scripts/live-data/collect.mjs        # 抓取脚本（状态机：开播/下播/标题变化）
scripts/live-data/verify-report-utils.mjs  # 页面数据逻辑自检（无需构建）
src/data/live/streams.json           # 直播场次数据（含正在直播的场次）
src/data/live/followers.json         # 粉丝每日快照
src/pages/live.astro                 # 页面（heroPage：首屏留给 hero，数据下滑才出现）
src/components/pages/live/LiveHero.astro    # 整屏 hero（P3R 风格开场：波浪帘 + 开场文字 + 下滑提示）
src/components/pages/live/*.svelte   # 月历 / 柱状图 / 统计卡片
src/utils/live-report-utils.ts       # 纯计算工具（可被客户端组件复用）
src/utils/live-report-data.ts        # 数据装载（构建时读取 JSON + 合并手动补录）
.github/workflows/live-data.yml      # 定时抓取 + 自动提交数据
```

---

## 1. 快速开始

### 1.1 填配置

编辑 `src/config/live-report.config.json`：

```jsonc
{
  "bilibili": {
    "enable": true,
    "uid": "你的B站UID",        // 个人空间地址里那串数字
    "roomId": "你的直播间号"     // 可选，填了时长能精确到秒
  },
  "douyin": {
    "enable": true,
    "secUid": "MS4wLjABAAAA...", // 抖音主页链接 /user/ 后面那段
    "webRid": "123456789",       // live.douyin.com/{webRid}
    "roomId": ""                 // 可选，留给抖音直播间接口
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `title` / `subtitle` | 留空则使用 i18n 里的多语言标题；填了就固定显示该文案 |
| `timezone` | 统计与展示时区，默认 `Asia/Shanghai`。日期归属、时刻显示都用它 |
| `weekStart` | 月历一周起始日：`monday` / `sunday` |
| `collector.intervalMinutes` | 轮询间隔，**必须与 workflow 里的 cron 一致** |
| `collector.followerSnapshotIntervalHours` | 粉丝快照最小写入间隔（小时），控制提交频率 |
| `collector.titleUpdateIntervalMinutes` | 直播标题变化的最小写入间隔（分钟），默认 30；用于控制提交/部署频率 |
| `collector.retentionDays` | 历史保留天数，`0` 表示不限制 |
| `manualRecords` | 手动补录历史场次（见 1.5） |

`title` / `subtitle` / `weekStart` 之外的内容都只被抓取脚本使用，Cookie 之类的密钥**不要写在这里**。

### 1.2 配置仓库 Secrets（抖音必需）

仓库 → Settings → Secrets and variables → Actions：

| Secret | 说明 |
| --- | --- |
| `BILIBILI_COOKIE` | 可选，形如 `SESSDATA=xxx; bili_jct=xxx`，降低风控概率 |
| `DOUYIN_COOKIE` | **抖音必需**，形如 `ttwid=xxx; msToken=xxx`。抖音 web 接口匿名请求返回空响应 —— 详细获取步骤见 **[抖音 Cookie 配置指南](./douyin-cookie.md)** |

实测结论（本仓库账号）：B站的用户名片、直播状态、直播间信息**不带 Cookie 也能取到**（粉丝数、是否在播、标题、精确开播时间都正常）；抖音不带 Cookie 时 amagi 会返回 `success:false` + "你的抖音ck可能已经失效"，两个接口都拿不到数据。

脚本对接口失败的处理是**忽略该平台本次结果**（不会把"接口失败"当成"下播"），所以即使抖音没配好，B站数据也会正常记录；只有**所有启用的平台都失败**才返回失败码。

> 抖音那条 Cookie 怎么导出、加到哪个仓库、怎么验证生效、过期了怎么办，
> 全部写在 **[抖音 Cookie 配置指南](./douyin-cookie.md)** 里，照着做即可。

### 1.3 启用工作流与 Pages

`.github/workflows/live-data.yml` 已经写好，推送到默认分支后：

- 每 10 分钟自动跑一次（GitHub 高峰期可能延迟几分钟）；
- 也可以在 Actions 页面手动 `Run workflow`；
- 只在数据真的有变化时才提交，提交信息形如 `chore(data): 更新直播数据 2026-02-14 23:50`。

部署到 GitHub Pages 只需要额外做一件事：**仓库 Settings → Pages → Source 选 “GitHub Actions”**，其余（子路径、站点域名）由 `deploy.yml` 自动处理，详见 [4.1](#41-github-pages当前方案)。

### 1.4 本地预览

```bash
# 1) 安装抓取脚本的依赖（独立的 npm 包，不参与站点构建）
cd scripts/live-data && npm install && cd ../..

# 2) 想直接看页面效果：写入演示数据（90 天随机数据）
node scripts/live-data/collect.mjs --demo
pnpm dev        # 打开 http://localhost:4321/live/

# 3) 用真实账号采一次（需要本机能访问 B站/抖音）
node scripts/live-data/collect.mjs --dry-run   # 只打印结果，不写文件
node scripts/live-data/collect.mjs             # 正式写入

# 4) 看接口原始返回，排查字段路径（抖音返回结构变动时很有用）
node scripts/live-data/collect.mjs --dump

# 5) 恢复空数据（演示数据不要提交）
git checkout src/data/live
```

### 1.5 补录历史场次

机器人只能记录它上线之后的开播，之前的场次可以手工补。填在 `live-report.config.json`
的 `manualRecords` 里，两种写法：

**写法一：记得开播/结束时间**（时长自动按差值算，页面会显示时段）

```jsonc
"manualRecords": [
  {
    "platform": "bilibili",
    "title": "【歌回】点歌台营业中",
    "start": "2026-01-03T20:00:00+08:00",
    "end": "2026-01-03T23:10:00+08:00",
    "url": "https://live.bilibili.com/xxxxx"
  }
]
```

**写法二：只记得播了多久**（不瞎编开播时间，页面只显示时长、不显示时段）

```jsonc
"manualRecords": [
  {
    "_note": "B站 1 小时 58 分 47 秒",
    "platform": "bilibili",
    "title": "",
    "date": "2026-09-06",
    "durationSeconds": 7127
  }
]
```

要点：

- `date` 用 `YYYY-MM-DD`；`durationSeconds` 是秒（1 小时 24 分 = `5040`，2 小时 10 分 = `7800`）。
- `title` 可以留空字符串：月历格子和当天列表都会自动跳过空标题。
- 之后想补上时段，把 `start` / `end` 加上、删掉 `durationSeconds` 即可，时长会按区间重算。
- 只填时长的记录，内部开播时间用当天 00:00 占位（仅用于排序），页面靠 `timeUnknown` 标记不显示时段。
- 补录记录带“手动补录”标签，且不会和自动采集的同一场重复计算（同平台且开播时间相差 10 分钟以内视为同一场；
  只填时长的记录因为时间未知，做不了这个去重，所以同一场不要既补录又让机器人采到）。

### 1.6 自检

```bash
# 1) 状态机回归测试（不需要网络，不会写文件）：开播/下播/时长/节流/失败保护/保留天数
node scripts/live-data/verify-state-machine.mjs

# 2) 页面计算逻辑：月历、统计、跨天/闰年日期、粉丝增减
npx tsx scripts/live-data/verify-report-utils.mjs
```

两个脚本都以非零退出码表示失败，可以直接放进 CI。

### 1.7 直播页开场 hero（复刻 P3RE 官网开场）

`/live/` 的首屏是整屏开场，复刻 [Electr0ME/P3RE-Web-Effect](https://github.com/Electr0ME/P3RE-Web-Effect)：
蓝波浪帘从整屏盖住状态向下退场 → 白底上显示居中开场文字（3.5s 起小字淡入、4.8s 起整体淡出，
时长由 `hero.holdSeconds` 调节）→ 5.5s 文字刚淡完，背景动画**直接**接上（不做淡入，见下）→
右侧品牌图与底部下拉按钮同时出现；数据放在首屏之下，下滑才看到。配置在
`live-report.config.json` 的 `hero` 段：

| 字段 | 说明 |
| --- | --- |
| `enable` | 关掉则不给内容留首屏空间，数据从导航栏下方直接开始 |
| `title` / `introLines` | 居中开场文字；默认就是参考仓库原文（Memento Mori + 三行引文） |
| `waveColor` | 波浪颜色，默认参考的 P3R 蓝 `#469ce5`；填 `theme` 可跟随站点主色 |
| `logo` | 右侧淡入的品牌图（public 下的路径），留空则不显示 |
| `backgroundVideos` | 背景视频（public 下的路径数组）：第 1 段在 5.5s（文字刚淡完）**直接**接上、播完切第 2 段循环；留空则用内置 CSS 动画背景 |
| `curtainDelaySeconds` / `curtainDurationSeconds` | 帘子的延迟与时长，默认 `1` / `3`（参考值） |

自带素材：`public/videos/live-hero/fv_movie1.webm`（374 KB）与 `fv_movie2.webm`（378 KB），
换成自己的视频只要替换文件或改 `backgroundVideos` 即可。视频未配置或加载失败时，
会自动露出内置的 CSS 动画背景（深蓝底 + 漂移光带），不会出现空白首屏。

**白底 → 动画的交接为什么不做淡入淡出**：`fv_movie1` 自己开头 0.85s 就是整屏纯白
（`ffprobe` 量出来 YAVG=235，即 TV 范围的白），所以做法是「白底一直压在视频上面，
等视频真的出帧（`playing`）再整帧收掉」——换幕是无缝的**直接展示**。反过来说，
如果给视频加 `opacity` 淡入，它就会半透明地叠在白底/深色动画背景上，看着像
**蒙了一层灰**；同理，之前那一层压暗用的 `.live-hero-scrim`（黑 28%~56%）也一并删掉了，
它会把整个 P3R 画面压灰压暗。

#### 1.7.1 hero 渲染在哪一层（为什么能盖住导航栏）

hero 由 `MainGridLayout` 渲染在 `#page-hero-layer`：`<body>` 直系的整屏固定层，
`z-index: 1090`，所以开场动画是页面真正的最上层，导航栏（z-80）和内容（z-30）都在它下面。

| z-index | 层 | 与 hero 的关系 |
| --- | --- | --- |
| 9999 | 分享海报 / 灯箱（portal 到 body） | 在 hero 之上（正常） |
| 1100 | 移动端导航抽屉 `#nav-menu-panel` | 在 hero 之上（展开后不会被盖住；但首屏被 hero 覆盖时点不到导航栏上的开关按钮，下滑一点即可） |
| **1090** | **`#page-hero-layer`（hero）** | — |
| 1000 / 999 | 浮动控件、浮动目录、看板娘 | 在 hero 之下（开场时被盖住） |
| 80 | 固定导航栏 | 在 hero 之下（开场时被盖住） |
| 30 | 内容面板 `#content-panel` | 在 hero 之下 |

两个容易踩的坑，改布局时注意：

1. **不能放进 `#wallpaper-wrapper`**（原来的做法）。那是 `z-index: var(--overlay-z-index)`（默认 `-1`）
   的独立层叠上下文，里面的任何东西都不可能盖到导航栏上面，动画会被导航栏“切一刀”。
2. **`#page-hero-layer` 必须在 `astro.config.mjs` 的 swup `containers` 列表里**，
   否则切走页面时 hero 会残留在 DOM 里（空页面下它就是个 `pointer-events: none` 的空容器，
   不占位、不挡点击）。

hero 覆盖整屏时会主动把 `pointer-events` 设成 `auto` 吞掉点击：否则用户点到被盖住的导航栏按钮，
搜索/主题面板会开在 hero 底下，看起来像“点了没反应”。一开始下滑淡出就立刻改回 `none`，
点击穿透还给页面（浮动控件、看板娘照常可用）。滚动本身不受影响。

#### 1.7.2 支持哪些视频格式

Firefly 本身**不限制**视频格式，hero 用的是浏览器原生 `<video>`（主题自带的壁纸播放器
`BackgroundPlayer` 同理），能播什么完全由**浏览器**决定。实践上按兼容性从高到低：

| 容器 / 编码 | 兼容性 | 说明 |
| --- | --- | --- |
| `.mp4`（H.264/AVC + yuv420p，Main/Baseline/High，`+faststart`） | 全平台 | 唯一“闭眼用”的格式：Chrome / Edge / Firefox / Safari / iOS / 各家 App 内置浏览器都支持。要兼容老旧安卓 WebView、微信/QQ 内置浏览器，优先 **Main 或 Baseline**（High 在 2012 年前的设备上可能解不动） |
| `.webm`（VP8 / VP9 + Opus/Vorbis） | 较好 | Chrome / Edge / Firefox / 安卓全支持；Safari 需 macOS 11.3+ / iOS 14.5+，部分 App 内置浏览器不认 → 必须有 mp4 兜底 |
| `.mp4`（HEVC/H.265） | 差 | 基本只有 Safari 能播，Chrome/Firefox 直接报错 |
| `.webm`（AV1）、`.mp4`（AV1） | 一般 | 新 Chrome/Edge/Firefox 可以，老 Safari 不行 |
| `.mov` / `.m4v` | 差 | 只有容器封装成 H.264+AAC 时部分浏览器认，别用 |
| `.gif` / `.apng` | — | 能显示，但那是图片不是视频：只能写在 `logo` 这类 `<img>` 位置，不能进 `backgroundVideos` |

推荐做法：**同一个文件名留两份**——`fv_movie1.webm`（体积小，现代浏览器优先命中）+
`fv_movie1.mp4`（兜底）。页面模板会自动按“同名 mp4”查找并追加 `<source>`，所以只要
把两个文件放同目录同名即可，不用改配置。转换命令：

```bash
# WebM → 兼容性最好的 mp4（无音轨，适合做背景动画）
ffmpeg -i in.webm -c:v libx264 -profile:v main -level 3.1 -pix_fmt yuv420p \
  -crf 22 -preset slow -an -movflags +faststart out.mp4
```

另外三点容易被忽略的：

1. **静音才能自动播放**。现代浏览器只允许 `muted` 的视频自动播放，hero 里的 `<video>` 已经
   写死 `muted` + `playsinline`；若你的浏览器开了“省电模式”，Safari / iOS 会**拒绝一切自动播放**，
   这时脚本会退回到内置动画背景（见下）。
2. **“减少动效”会整体关掉开场**。系统开启“动画效果 → 关闭”时 `prefers-reduced-motion: reduce`
   生效，开场帘子、文字淡出、背景视频都会被跳过，直接显示白底 + 文字 + 按钮。
3. **别用变量帧率 / 超长 GOP 的素材**：首帧迟迟解不出来时，观感就是“黑屏几秒才动”。

#### 1.7.3 视频不播时怎么排查

hero 的脚本在控制台里留了线索，按 `F12` → Console / Network 看：

| 现象 | 排查方向 |
| --- | --- |
| 控制台 `[live-hero] 背景视频未能自动播放，将在首次交互后重试：NotAllowedError` | 自动播放被策略拦下，页面任何一次点击/滚动/按键后会自动重试；想立刻验证就先点一下页面 |
| 控制台 `[live-hero] 背景视频不可用，改用内置动画背景：MediaError 4 …` | 浏览器解不了这个编码（`4` = 格式不支持）。看 Network 里 `fv_movieN.webm` / `.mp4` 的响应类型，换 H.264 Main 的 mp4 |
| Network 里视频 404 | 路径不对，或忘了提交到仓库；`backgroundVideos` 里写的是 `public` 下的绝对路径（如 `/videos/live-hero/fv_movie1.webm`） |
| 视频只播了一遍就没了 | 第 1 段（intro）播完没接上第 2 段：确认 `backgroundVideos` 里给了两段，且第 2 个文件能正常加载 |
| 首屏只有静止画面 / 一片深蓝渐变 | 命中了兜底状态（`data-hero-state="fallback"`）：视频被拦或解码失败，此时内置动画背景在工作 |
| 点了导航栏的“播放背景视频”后 hero 消失 | 已修：hero 已移出壁纸层与 `#banner-overlay-container`，主题那层的显隐影响不到它了 |

---

## 2. 数据是怎样攒出来的（重要）

B站 和 抖音 都**没有公开的“历史直播记录”接口**，所以时长只能靠轮询推断：

```
每 10 分钟拉一次直播状态
  ├─ 上一轮没在播、这一轮在播  → 记下开播时间（B站 可用 live_time 精确到秒）
  ├─ 上一轮在播、这一轮下播    → 结算时长，写入 records
  └─ 标题变了                 → 更新当前场次的标题（受 titleUpdateIntervalMinutes 节流）
```

由此带来的特性与限制，请在用之前了解：

| 项目 | 说明 |
| --- | --- |
| 时长精度 | 约等于轮询间隔（默认 10 分钟）。轮询越密越准，代价是 Actions 运行次数与提交次数 |
| 开播时间 | B站 配置了 `roomId` 时用 `live_time`（精确到秒）；抖音用轮询时刻 |
| 接口失败 | amagi 失败时返回 `success:false`（不是抛异常）。脚本把它当作“本次无数据”并**跳过该平台**，绝不会误判成“下播”去结算正在进行的场次；只有全部平台都失败才算本次采集失败 |
| 漏采 | Actions 长时间不可用（例如周末连续失败、仓库 60 天无活动被停用定时任务）会漏掉“整场都在停机期间”的直播。手动 `Run workflow` 或补录可缓解 |
| 跨天场次 | 归到**开播当天**，时长照实计算（`date` 取开播日） |
| 粉丝增减 | 每个平台每天保留一个快照点，增减值 = 与上一个快照比较。快照写入间隔由 `followerSnapshotIntervalHours` 控制，取“当天最后一次写入”的值 |
| 第 0 天 | 第一个快照没有可比对象，图上显示为“起始”而不是 0 |
| 标题 | 记录的是当前场次的标题；节流期间的变化不会写入，最终下播时以最后一次成功写入的标题为准 |

---

## 3. GitHub Actions 说明与额度

| 项目 | 公开仓库 | 私有仓库 |
| --- | --- | --- |
| Actions 免费额度 | 不限量 | 每月 2000 分钟 |
| 建议 cron | `*/10 * * * *` | `*/30 * * * *`（同时把 `intervalMinutes` 改成 30） |
| 单次运行耗时 | 约 20~40 秒（安装依赖 + 一次采集） | 同左 |
| 每月约消耗 | — | `*/30` ≈ 1440 次 × 0.5 分钟 ≈ 720 分钟，安全 |

其它注意点：

- 定时任务的 cron 走 **UTC**，跑在默认分支上；向仓库的推送本身也会算作“仓库活跃”，正常不会触发 60 天停用规则。
- 工作流带了 `concurrency: live-data`，不会出现两个任务同时改写数据文件。
- 只在 `src/data/live/` 有内容变化时才提交，因此每天的提交量大约是：`2 × 直播场次 + 1~2 次粉丝快照`（标题变化受 `titleUpdateIntervalMinutes` 节流，默认 30 分钟内最多一次）。
- 数据提交不会再触发 `build.yml` / `biome.yml` / `biome.yml`（这两个工作流已经加了 `paths-ignore: src/data/live/**`），只由部署工作流构建一次。
- 采集脚本失败不会破坏站点：脚本读取 JSON 失败时会退回默认值，页面也能在没有数据时正常显示空状态。

---

## 4. 部署

站点是纯静态输出（`astro build` → `dist/`），GitHub Pages 和 Cloudflare Pages 都能直接用，靠两个环境变量切换：

| 变量 | 作用 | 用户站（当前：`Fire0King.github.io`） | 项目页（`Firefly_Blog` 这类仓库） |
| --- | --- | --- | --- |
| `PUBLIC_SITE_URL` | 站点 origin（canonical / sitemap / RSS / 侧边栏域名） | `https://fire0king.github.io` | `https://fire0king.github.io` |
| `PUBLIC_BASE_PATH` | 子路径（Astro 的 `base`） | `/`（根路径） | `/Firefly_Blog` |

两者都有默认值兜底：`PUBLIC_SITE_URL` 默认取 `src/config/siteConfig.ts` 里的 `site_url`，`PUBLIC_BASE_PATH` 默认 `/`。

### 4.1 GitHub Pages（当前方案）

当前主站部署在**用户站仓库** `Fire0King/Fire0King.github.io`（分支 `main`，`main` 是它的默认分支）：

| 项目 | 值 |
| --- | --- |
| 站点地址 | `https://fire0king.github.io/`（根路径，没有子路径） |
| 本地 remote | `origin`（`firefly-blog` 是旧的 `Firefly_Blog` 仓库，留作备份） |
| 本地分支 | `main`（跟踪 `origin/main`） |

**必须先做的一件事**：仓库 Settings → Pages → Build and deployment → Source 选 **GitHub Actions**。
如果停留在 “Deploy from a branch”，`deploy.yml` 会失败并提示 “Get Pages site failed / verify that the repository has Pages enabled and configured to build using GitHub Actions”。

`deploy.yml` 会自动推导并注入上表的两个变量（按仓库名判断是用户站还是 project page），**代码里不需要写死子路径**：

```bash
# 用户站：REPO == <OWNER>.github.io
OWNER=Fire0King  REPO=Fire0King.github.io
PUBLIC_SITE_URL=https://fire0king.github.io
PUBLIC_BASE_PATH=/

# 项目页（例如把仓库改名为 Firefly_Blog 时）
PUBLIC_BASE_PATH=/Firefly_Blog
```

推送后会发生什么：

1. `deploy.yml`：`pnpm install` → `pnpm build` → 上传 `dist/` 部署到 Pages（公开仓库 Actions 免费，首次构建约 3~6 分钟）；
2. `live-data.yml`：每 10 分钟采集一次，有变化就提交 → 这个提交会再次触发 `deploy.yml` → 页面数据自动更新；
3. `build.yml` / `biome.yml`：只在代码变更时跑检查（数据提交已忽略）。

> 定时任务只在**仓库默认分支**上运行。用户站的默认分支是 `main`，所以各工作流的监听分支同时写了
> `master` 与 `main`；如果你以后把默认分支改成别的名字，记得同步修改这四个工作流。

> 用两个仓库时注意：两个仓库的 Actions 都会各自采集并提交数据，等于双份 API 调用、两份数据。
> 建议只保留一个仓库跑 Actions（另一个在 Settings → Actions → General 里 Disable actions 即可）。

本地预览“GitHub Pages 子路径版”站点：

```powershell
# PowerShell
$env:PUBLIC_SITE_URL="https://fire0king.github.io"; $env:PUBLIC_BASE_PATH="/Firefly_Blog"; pnpm dev
# 然后访问 http://localhost:4321/Firefly_Blog/
```

GitHub Pages 的限制：

| 项目 | 说明 |
| --- | --- |
| 部署频率 | 约每小时 10 次。所以采集脚本对标题变化做了节流（`titleUpdateIntervalMinutes`），避免频繁改标题的主播把部署打满 |
| 数据时效 | 页面是静态的，数据只在重新部署后更新（提交后自动重建，通常几分钟内） |
| 自定义域名 | 在仓库 Variables 里设 `PUBLIC_SITE_URL`（例如 `https://blog.example.com`）、`PUBLIC_BASE_PATH=/`，再在 Pages 设置里绑定域名即可 |

### 4.2 Cloudflare Pages（以后搬过去）

| 设置项 | 值 |
| --- | --- |
| Framework preset | Astro（或 None） |
| Build command | `pnpm build` |
| Build output directory | `dist` |
| 环境变量 | `NODE_VERSION=22`（仓库要求 Node ≥ 22.23）、`PNPM_VERSION=11.22.0`（可选）、`PUBLIC_SITE_URL=你的域名`、`PUBLIC_BASE_PATH=/` |

说明：

- `astro.config.mjs` 只在设置了 `CF_WORKERS` 环境变量时启用 Cloudflare **Workers** 适配器。部署到 **Pages**（静态）时**不要**设置 `CF_WORKERS`，否则产物会变成 Worker 入口而不是静态站点。
- 换到 Cloudflare 后，GitHub 仓库 Variables 里的 `PUBLIC_BASE_PATH=/Firefly_Blog` **不会**影响 Cloudflare 的构建（那是 Actions 的环境变量），Cloudflare 侧只要不设 `PUBLIC_BASE_PATH` 就是根路径；但 `PUBLIC_SITE_URL` 记得在 Cloudflare 环境变量里改成新域名，否则 canonical / sitemap 仍指向 github.io。
- 也可以两边同时在线：GitHub Pages 用子路径，Cloudflare 用根路径，一份代码两套环境变量。
- 生产分支选 `master`，构建缓存建议开启。首次构建约 3~5 分钟。
- Pages 的部署方式二选一：
  1. **Git 集成**（推荐）：仓库推送即构建，数据提交后页面自动更新；
  2. **Wrangler 直传**：`pnpm build && npx wrangler pages deploy dist`，适合想自己控制发布时机的情况。

### 4.3 需要留意的“部署次数”问题

每次数据变化都会产生一次提交 → 触发一次部署，两边都有配额：

```
每天大约 2×场次(开播+下播) + 1~2 次粉丝快照 ≈ 6~12 次
一个月 ≈ 200~360 次
```

- GitHub Pages：约每小时 10 次的上限，正常情况下不会碰到；`titleUpdateIntervalMinutes` 就是为了防这个。
- Cloudflare Pages：免费版每月 **500 次构建**，一般够用但不算宽裕。

想进一步压低，有三条路：

1. 把 `followerSnapshotIntervalHours` 调到 `24`（粉丝快照每天只写一次），并把轮询降到 `*/15` → 每月约 120~200 次；
2. 让数据提交带上 `[CI Skip]`（Cloudflare Pages 会跳过这次构建），只在**开播/下播**这种真正需要页面更新的提交上正常构建：把 workflow 里 `git commit` 的提交信息按 `streams.json` 是否变化来决定是否加 `[CI Skip]`；
3. 换成下一节的 Cloudflare Worker 方案：数据不再走仓库，页面运行时读接口，**完全不产生构建**。

---

## 5. 更好的方案（推荐给比较在意实时性的场景）

GitHub Actions 的定时任务有两个天然短板：**最小粒度 5 分钟且经常延迟**、**私有仓库有分钟数限制**。既然你的目标平台已经是 Cloudflare，更顺的做法是把“采集”放到 Cloudflare 侧：

```
Cloudflare Worker (Cron Trigger，每 5 分钟)
   ├─ 调 amagi 抓 B站 / 抖音 状态与粉丝数
   ├─ 状态机结算场次、时长（逻辑同 collect.mjs）
   └─ 写入 KV：live-report:streams / live-report:followers
        ↓
Pages 页面运行时 fetch /api/live-report（同一个 Worker 的路由，带缓存头）
```

优点：

- 5 分钟粒度（免费版 Cron 最小 1 分钟，100k 请求/天，个人站完全够）；
- 不产生任何 Git 提交与 Pages 构建，不受 500 次/月限制，私有仓库也不吃 Actions 分钟数；
- 想改历史数据直接改 KV，页面立刻生效；
- Worker 里同样跑 `@ikenxuan/amagi`（`nodejs_compat` + esbuild 打包）。

代价与做法：

- 需要把 Worker 的 Cookie 放进 `wrangler secret`；页面要改成**运行时拉取**数据（现在的迁移页面是构建时读取 JSON，需要加一个 `dataSource: "static" | "dynamic"` 开关，类似主题里 bangumi / vndb 的 `mode` 配置）；
- 保留一个降级：Worker 不可用时退回构建时 JSON（也就是现在这套方案）。

如果你想上这套方案，告诉我，我可以把 Worker（Cron + KV + `/api/live-report`）和页面的 `dynamic` 数据模式一并实现；现在的实现可以原样保留作为静态降级。

另外两个小建议：

- **别把 Cookie 写进仓库**：GitHub 用 Secrets，Cloudflare 用 `wrangler secret put` / 控制台变量。
- **依赖许可**：`@ikenxuan/amagi` 是 GPL-3.0。本项目只在独立的采集脚本/Worker 里调用它、通过 JSON 传递数据，属于“独立进程调用”，不会传染站点代码；但不要把它的源码复制进 `src/`。

---

## 6. 排错清单

| 现象 | 排查方向 |
| --- | --- |
| 页面提示“未配置直播数据源” | `live-report.config.json` 里对应平台的 `uid` / `secUid` 是否填了 |
| 页面一直是空状态 | Actions 是否跑过（Actions 页面看 `Live data collector`）；`src/data/live/*.json` 是否有内容 |
| Actions 报 push 失败 | 分支保护规则 / Ruleset 是否允许 Actions 推送；Settings → Actions → General → Workflow permissions 建议设为 Read and write |
| Pages 部署报 “Get Pages site failed” | Settings → Pages → Source 必须选 **GitHub Actions** |
| Pages 打开后样式/图片全丢 | `PUBLIC_BASE_PATH` 不对。project page 必须是 `/<仓库名>`；看页面源码里的 `_astro/` 路径是否带前缀 |
| 抖音一直采集失败 | 按 **[抖音 Cookie 配置指南](./douyin-cookie.md)** 配置 `DOUYIN_COOKIE`（抖音匿名必失败）；用 `--dump` 看返回体，抖音字段结构可能变化 |
| 时长明显偏短/偏长 | 检查 cron 与 `intervalMinutes` 是否一致；Actions 是否被延迟 |
| 月历少了某天 | `date` 字段是开播日；跨天场次不会同时出现在两天 |
| 粉丝图某个平台空白 | 该平台还没有快照点（脚本只在粉丝数 > 0 时写入） |
| 站点里的域名/分享卡片指向旧域名 | `PUBLIC_SITE_URL` 没设或设错（canonical / sitemap / OG 都用它） |
| 构建时页面报错 | 先跑 `node scripts/live-data/verify-state-machine.mjs`、`npx tsx scripts/live-data/verify-report-utils.mjs` 与 `pnpm check` |
