# 抖音 Cookie 配置指南

直播数据页面的 B站 数据不需要任何凭据，但**抖音的 web 接口必须带 Cookie**，否则接口返回空响应。
本文是从零开始配置 `DOUYIN_COOKIE` 的完整步骤，包括浏览器导出、配到 GitHub、本地调试和排错。

> 相关背景：`scripts/live-data/collect.mjs` 通过 [`@ikenxuan/amagi`](https://github.com/ikenxuan/amagi)
> 调用抖音的两个接口：
>
> | 接口 | 域名 | 取什么 |
> | --- | --- | --- |
> | `fetchUserProfile({ sec_uid })` | `www.douyin.com` | 粉丝数、昵称、是否在直播 |
> | `fetchLiveRoomInfo({ room_id, web_rid })` | `live.douyin.com` | 直播标题、房间状态 |
>
> 两个域名的 Cookie 都是 `.douyin.com` 域下的同名 Cookie，通常会共享；但保险做法是两个页面都开一次再导出。

---

## 0. 没有 Cookie 会怎样（实测）

匿名请求抖音接口时，amagi 会返回 `success:false`，错误信息是：

```
获取响应数据失败！接口返回内容为空，你的抖音ck可能已经失效！
```

采集脚本的处理方式是**跳过抖音这一次**、继续处理 B站，所以：

- 工作流不会失败（不会把 CI 刷红）；
- 页面上的抖音部分一直空着：粉丝图显示「暂无粉丝快照数据」、月历上不会出现抖音的场次；
- 日志里会有 `douyin: 采集失败(...（请配置仓库 Secret DOUYIN_COOKIE）)`。

**如果你不介意只有 B站 数据，完全可以不配**，其余功能都正常。

---

## 1. 准备

| 需要 | 说明 |
| --- | --- |
| 一个抖音账号 | 用**你自己**的账号能拿到最完整的数据；抖音大部分用户主页信息匿名也能看，但接口本身仍要 Cookie |
| 电脑端浏览器 | Chrome / Edge 都行，**不要用手机 App 或微信内置浏览器**（拿不到 Network 面板） |
| 两个页面 | `https://www.douyin.com/` 和 `https://live.douyin.com/<你的webRid>`（你的 webRid 已填在配置里） |

> 建议先在本机浏览器的**无痕窗口**里登录抖音，专门用于导出这个 Cookie；无痕窗口关掉即失效，
> 用完也好判断这条 Cookie 什么时候会过期（见第 6 节）。

---

## 2. 从浏览器导出 Cookie

### 方法一：从 Network 面板复制整段（推荐）

这是最可靠的方式——拿到的就是浏览器实际发出去的 `Cookie` 请求头，格式与 amagi 需要的一致。

1. 打开 `https://www.douyin.com/`，确认已登录（右上角有头像）。
2. 按 `F12` 打开开发者工具，切到 **Network（网络）** 面板。
3. 在筛选栏点 **Fetch/XHR**，然后按 `F5` 刷新页面（必须刷新，Network 面板才会重新记录请求）。
4. 在请求列表里点任意一条发往 `douyin.com` 的请求（例如 `user/profile/other/`、`aweme/v1/web/...` 之类）。
5. 右侧切到 **Headers（标头）** → 向下找到 **Request Headers（请求标头）** → 找到 **`cookie`** 一行。
6. **复制这一行的完整值**（从第一个 `name=value` 到最后一个，不含前面的 `cookie: `）。
   值很长，通常是这样的形状（示例，非真实值）：
   ```
   ttwid=1%7Cxxxxxxxxxxxx; odin_tt=xxxxxxxx; passport_csrf_token=xxxxxxxx; msToken=xxxxxxxx; ...
   ```
7. 再打开 `https://live.douyin.com/<你的webRid>`（同一个浏览器标签页即可），用同样方式从
   发往 `live.douyin.com` 的请求里再复制一份 Cookie。
8. 把两份合并成一行：**先粘 www 那份，再在末尾追加 `; ` + live 那份独有的项**。
   两份里重复的项（如 `ttwid`）保留一份即可。嫌麻烦也可以只用 www 那份先试——
   先跑第 4 节的验证，如果直播标题取不到、但粉丝数能取到，再补上 live 域名的 Cookie。

### 方法二：从存储面板逐个拼（方法一拿不到时用）

有些浏览器版本会把 `cookie` 请求头折叠起来，可以手工拼：

1. `F12` → **Application（应用）** 面板（Chrome）或 **存储** 面板（Edge）。
2. 左侧 **Storage → Cookies → `https://www.douyin.com`**。
3. 把需要的几项按 `name=value; name=value` 的格式拼起来。经验上至少要有：
   - `ttwid`（设备标识，必需）
   - `odin_tt`
   - `msToken`
   - `passport_csrf_token`
   - 如果列表里还有 `s_v_web_id`、`UIFID`、`sessionid` 之类，一并带上更稳
4. 同样再取一份 `https://live.douyin.com` 下的 Cookie 并按上面方式合并。

> 说明：请求里的 `msToken`、`verifyFp`、`a_bogus` 等参数 amagi 会自己生成并拼接，
> 所以**你导出的 Cookie 里即使少了 `msToken` 也常常能用**；但 `ttwid` 这类设备标识
> 是浏览器侧生成的，缺少它基本必失败。整段复制是最省心的做法。

---

## 3. 配到 GitHub（线上采集用）

采集工作流跑在**主站仓库**里，所以 Secret 必须加在主站仓库：

**仓库 `Fire0King/Fire0King.github.io`** → Settings → Secrets and variables → Actions → **Secrets** 标签页 → **New repository secret**

| 字段 | 填什么 |
| --- | --- |
| Name | `DOUYIN_COOKIE` —— **必须完全一致**（大小写、下划线都不能变，工作流里就是按这个名字读的） |
| Secret | 第 2 步复制的整段 Cookie（**一整行**，不要加引号，末尾不要留换行/空格） |

点 **Add secret** 保存。

> 关键点：
> - **Secrets 是按仓库隔离的**。加在 `Firefly_Blog` 之类的其他仓库里对主站无效。
> - Secret 保存后**无法再查看**，只能重新设置；粘贴前先确认没有多选到换行。
> - 同一个仓库里另一个可选 Secret 是 `BILIBILI_COOKIE`（B站 不需要，配了只是降低风控概率）。

---

## 4. 验证是否生效

### 方式一：手工触发一次采集（推荐）

1. 仓库 → **Actions** 标签页 → 左侧选 **Live data collector**。
2. 右上 **Run workflow** → 分支选 `main` → **Run workflow**。
3. 等十几秒，点进这次运行，展开 **Collect live data** 步骤，看日志。成功时长这样：

   ```
   [live-data] douyin: 未开播，粉丝 12345
   ```
   或者正在直播时：
   ```
   [live-data] douyin: 直播中，粉丝 12345
   ```

   **只要出现 `粉丝 数字`，就说明 Cookie 生效了。** 如果看到：

   ```
   [live-data] douyin: 采集失败(...（请配置仓库 Secret DOUYIN_COOKIE）)
   ```

   说明 Cookie 没读到或已失效，回第 2、3 步检查（重点：名称是否拼错、是否粘到了别的仓库）。

### 方式二：看数据文件有没有变化

Cookie 生效后，采集会**每天至少写一次**抖音粉丝快照并自动提交（快照写入间隔是 12 小时，
但每天的第一条总会写入），于是：

- 仓库 **Commits** 里出现 `chore(data): 更新直播数据 ...`；
- 打开 `src/data/live/followers.json`，`series` 下会多出 `douyin` 段（`total` 是当前粉丝数）。

页面侧：等这次提交触发的重新部署完成（约 3~5 分钟），抖音那张柱状图就会开始有数据点。

---

## 5. 本地调试时怎么用

本地跑采集脚本时，直接从环境变量传进去即可（**PowerShell**）：

```powershell
# 用单引号：Cookie 里可能有 $ 等字符，单引号可以避免被 PowerShell 解释
$env:DOUYIN_COOKIE = 'ttwid=xxx; odin_tt=xxx; msToken=xxx; passport_csrf_token=xxx'

# 先干跑一次，确认抖音能取到数据（不会写文件）
node scripts/live-data/collect.mjs --dry-run

# 取不到时打印接口原始返回，用来排查字段/错误
node scripts/live-data/collect.mjs --dump
```

期望输出：

```
[live-data] bilibili: 未开播，粉丝 69386
[live-data] douyin: 未开播，粉丝 12345
[live-data] 直播状态无变化，未改动 streams.json
```

用完后清掉这个环境变量（或直接关掉终端）：

```powershell
Remove-Item Env:\DOUYIN_COOKIE
```

> ⚠️ `--dump` 会打印接口**原始返回**，里面有你的昵称、主页信息等，贴给别人看之前先删掉敏感内容。
> 工作流里**没有**用 `--dump`，不用担心 CI 日志泄露出这些。
>
> 抖音的 `roomId` 可以留空：amagi 要求 `room_id` 非空，采集脚本在没填时会用 `webRid` 顶替
> （实际请求以 `web_rid` 为准），所以只要填了 `webRid` 就能取直播标题。

---

## 6. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 日志里 `你的抖音ck可能已经失效` | Cookie 没配、名字拼错、配错了仓库，或者已经过期。按第 2、3 步重来一次 |
| 粉丝数能取到，但直播标题总是空 | 只带了 `www.douyin.com` 的 Cookie。再打开 `live.douyin.com/<webRid>` 导出一次并合并（第 2 步第 7 条） |
| 粉丝数一直是 0 | 抖音返回结构变了。本地 `--dump` 看返回体，把真实字段名补进 `scripts/live-data/collect.mjs` 里 `collectDouyin()` 的 `deepFind` 候选列表 |
| 昨天还好好的，今天失败 | Cookie 过期（尤其无痕窗口的会话、或你在别处退出了登录）。重新导出即可 |
| 页面抖音部分一直空 | 数据要在重新部署后才显示：确认提交发生了（Commits 里有 `chore(data): ...`），再等一次部署完成 |
| B站也不动了 | 和抖音 Cookie 无关：看 `bilibili:` 那行日志；B站 不需要 Cookie |

---

## 7. 安全与维护（务必读一下）

1. **这段 Cookie 等同于登录凭据**，谁拿到就能以你的账号身份访问抖音（包括私信、关注等）。
   请像对待密码一样：不要提交进仓库、不要贴到 issue / 聊天 / 截图里。
2. 仓库里的 Secret 是加密存储、日志里也会自动打码（`***`），**采集脚本只会从环境变量读取**，
   不会写进任何数据文件或输出。
3. 建议用**无痕窗口**或一个专用账号导出，方便判断过期时间，也降低主账号风险。
4. 在任何设备上**退出抖音登录**、或清理浏览器 Cookie，都会让这份 Cookie 立即失效 —— 重新导出一次即可。
5. Cookie 会自然过期（通常几周到几个月），所以采集偶尔失败是正常现象；脚本对失败是「跳过本次、不影响 B站」的处理。
6. 配好之后如果要更换，直接在同一个 Secret 上 **Update**（覆盖）即可，无需改代码。

---

## 8. 相关文件

| 文件 | 作用 |
| --- | --- |
| `src/config/live-report.config.json` | 抖音的 `secUid` / `webRid` 填在这里（Cookie 不放这里） |
| `scripts/live-data/collect.mjs` | 采集脚本，`collectDouyin()` 里是抖音的取值逻辑与 `deepFind` 候选字段 |
| `.github/workflows/live-data.yml` | 把 Secret 注入环境变量：`DOUYIN_COOKIE: ${{ secrets.DOUYIN_COOKIE }}` |
| `docs/live-report.md` | 直播数据页面的总文档（配置、部署、排错） |
