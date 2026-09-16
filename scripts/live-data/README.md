# 直播数据采集脚本

独立的小 npm 包（不参与站点构建），负责把 B站 / 抖音 的直播状态与粉丝数写进
`src/data/live/*.json`。配置在仓库根目录的 `src/config/live-report.config.json`，
完整说明见 [`docs/live-report.md`](../../docs/live-report.md)。

## 安装

```bash
cd scripts/live-data
npm install
```

## 用法

```bash
node collect.mjs                 # 正式采集（写入数据文件）
node collect.mjs --dry-run       # 只打印将要做什么，不写文件
node collect.mjs --dump          # 打印接口原始返回（排查字段路径）
node collect.mjs --demo          # 写入 90 天演示数据（仅本地预览，别提交）
node collect.mjs --force-follower# 忽略"快照写入间隔"，立刻写一次粉丝快照
node collect.mjs --strict        # 所有平台都失败时返回非零退出码（CI 严格模式）
```

## 自检

```bash
node verify-state-machine.mjs            # 状态机（无网络、不写文件）
npx tsx verify-report-utils.mjs          # 页面计算逻辑（需要仓库根目录的 tsx）
```

`verify-state-machine.mjs` 覆盖：开播 / 下播 / 时长结算、**接口失败时不会把在播场次结算掉**、
标题节流、粉丝快照节流、保留天数裁剪。改逻辑后先跑它。

环境变量（CI 里从 Secrets 注入）：

| 变量 | 说明 |
| --- | --- |
| `BILIBILI_COOKIE` | 可选，B站 Cookie，如 `SESSDATA=xxx; bili_jct=xxx` |
| `DOUYIN_COOKIE` | **抖音必需**，如 `ttwid=xxx; msToken=xxx`；不配抖音接口返回空响应 |

## 逻辑

每次运行只做一件事：把“当前状态”和 `streams.json` 里的 `active` 对比。

```
在播 + 无 active  -> 新建 active（B站 用 live_time 作为精确开播时间）
在播 + 有 active  -> 标题变化且超过 titleUpdateIntervalMinutes 时更新标题
下播 + 有 active  -> 结算 durationSeconds，写入 records，清掉 active
接口失败          -> 跳过该平台，active 原样保留（绝不当作“下播”）
```

因此时长精度 ≈ 轮询间隔，且只有“开播 / 下播 / 标题变化（受节流）/ 粉丝快照到期”时才写文件，
GitHub Actions 也就只在这些时刻提交，不会每 10 分钟刷一条提交记录，也不会把
Pages 的部署频率（GitHub Pages 约 10 次/小时、Cloudflare Pages 500 次/月）打满。

`collect.mjs` 只在被直接执行时跑采集（文件末尾有 `isDirectRun` 判断），
被测试文件 import 时只导出状态机函数，不产生副作用。

## 依赖

| 包 | 用途 |
| --- | --- |
| [`@ikenxuan/amagi`](https://github.com/ikenxuan/amagi) | B站 / 抖音 web 接口封装（GPL-3.0，仅在此脚本内使用） |

`package-lock.json` 已提交（根 `.gitignore` 为这个目录单独开了例外），CI 用
`npm ci --prefix scripts/live-data` 安装，保证版本一致。

## 接口与字段

脚本调用的接口（`amagi` v6.6.0，B站三个接口实测过真实账号）：

| 平台 | 接口 | 取什么 | 是否需要 Cookie |
| --- | --- | --- | --- |
| B站 | `fetchUserCard({ host_mid })` | `data.card.fans` → 粉丝数 | 不需要 |
| B站 | `fetchUserLiveStatus({ host_mid })` | `liveStatus`(1=在播)、`title`、`cover`、`roomid` | 不需要 |
| B站 | `fetchLiveRoomInfo({ room_id })` | `live_status`(1=在播/2=轮播)、`live_time` → 精确开播时间 | 不需要 |
| 抖音 | `fetchUserProfile({ sec_uid })` | `follower_count`、`live_status` | **需要** |
| 抖音 | `fetchLiveRoomInfo({ room_id, web_rid })` | `status`(2=在播)、`title` | **需要** |

注意事项：

- amagi 的失败是**返回 `success:false`** 而不是抛异常，脚本用 `unwrap()` 统一转换，
  否则“接口失败”会被误判成“未开播”并错误结算正在进行的场次（`verify-state-machine.mjs` 有覆盖）。
- 抖音 `fetchLiveRoomInfo` 的 `room_id` 是必填且不能为空，实际请求以 `web_rid` 为准，
  所以没填 `roomId` 时脚本用 `web_rid` 顶替。
- 抖音返回结构随版本变动较多，脚本用 `deepFind()` 按候选字段名查找，
  字段找不到时**先 `--dump` 看原始返回**，再把真实字段名补进 `collectDouyin()`
  的候选列表即可（不需要改页面）。

## 疑难

- **B站 时长偏差**：确认 `live-report.config.json` 里填了 `roomId`，这样用 `live_time` 精确到秒。
- **抖音总是失败**：必须配 `DOUYIN_COOKIE`，抖音 web 接口匿名请求只返回空响应。
- **B站 uid 填错**：B站直播状态接口对不存在的 UID 也返回 `liveStatus: 0`（看起来像“从未开播”），
  用 `--dump` 看 `url` / `roomid` 是否为空即可判断。
- **Actions 里失败但本地正常**：检查 Secrets 名称是否与 workflow 一致，以及仓库默认分支。
