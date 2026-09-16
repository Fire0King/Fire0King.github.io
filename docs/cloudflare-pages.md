# 用 Cloudflare Pages 部署（加速访问）

本文把当前部署在 GitHub Pages 的站点，在 **Cloudflare Pages** 上再部署一份，
用 Cloudflare 的边缘网络加速访问。仓库侧已经准备好了，你只要在 Cloudflare 面板点几下。

> 相关文档：站点部署总览、直播数据采集、GitHub Pages 细节见 [`live-report.md`](./live-report.md) 第 4 节。

---

## 0. 先搞清楚三件事

1. **Cloudflare 不能直接给 `fire0king.github.io` 加速。** 那个域名属于 GitHub，不在你的 Cloudflare 账号里，
   无法套 CDN。Cloudflare Pages 会给你一个自己的免费域名 `https://<项目名>.pages.dev`，
   这个域名本身就跑在 Cloudflare 边缘上 —— 我们要用的就是它。
2. **不需要 Worker，也不要设 `CF_WORKERS`。** 站点是纯静态输出（`astro build` → `dist/`），
   Pages 直接托管静态文件即可。`astro.config.mjs` 里只有设置了 `CF_WORKERS` 才启用 Cloudflare Workers
   适配器，一旦设了，产物会变成 Worker 入口，Pages 反而用不了。
3. **大陆访问的预期要摆正。** Cloudflare 免费版**没有中国大陆节点**，免费流量一般走香港 / 新加坡 /
   圣何塞等。对大陆访客通常是「比 github.io 更稳」（github.io 经常被限速、抽风），但别指望秒开；
   对海外、港澳台访客提升明显。要真正加速大陆访问只有国内 CDN + 备案（见第 6 节）。

---

## 1. 前置检查（仓库侧已经就绪）

| 项目 | 状态 |
| --- | --- |
| 构建产物 | 纯静态 `dist/`，无需服务端 |
| 构建命令 | `pnpm build`（内部依次跑 LQIP、字体子集、Pagefind 搜索索引，约 1~3 分钟） |
| Node 要求 | `engines.node >= 22.23.0`（`package.json`） |
| pnpm 版本 | `packageManager: pnpm@11.22.0`（`.npmrc` 设了 `manage-package-manager-versions`，会自动用这个版本） |
| 子路径 | 不需要设 `PUBLIC_BASE_PATH`，默认就是根路径 `/` |
| 站点域名 | 不设 `PUBLIC_SITE_URL` 时会**自动**用 Cloudflare 注入的 `CF_PAGES_URL`，canonical / sitemap / RSS 都是对的 |
| 边缘缓存 | `public/_headers` 已给 `/_astro/*`、`/pagefind/*` 设了长缓存 |

> 唯一会「失败但无害」的构建步骤：`scripts/generate-github-card-data.ts` 会去拉 GitHub API 更新友链卡片数据，
> 拿不到时自动用仓库里已有的缓存数据，不影响构建成功。

---

## 2. 在 Cloudflare 建 Pages 项目（逐步）

### 2.1 准备工作

1. 打开 <https://dash.cloudflare.com/>，没有账号就注册（邮箱验证，免费版就够）。
2. 确认你能登录 GitHub 上的 `Fire0King` 账号（下一步要授权 Cloudflare 读仓库）。

### 2.2 连接仓库

1. 左侧栏点 **Workers & Pages** → 右上 **Create**（老界面是 **Create application**）→ 选 **Pages** 标签页。
2. 点 **Connect to Git**。
3. 第一次会让你授权 GitHub：点 **Install & Authorize**（只授权 `Fire0King/Fire0King.github.io` 一个仓库也行，
   选 **Only select repositories** 更安全）。
4. 回到 Cloudflare，从列表里选中 **`Fire0King/Fire0King.github.io`** → **Begin setup**。

> 注意选的是**用户站仓库**（当前主站就是它）。仓库列表里如果还有旧的 `Firefly_Blog`，别选错。

### 2.3 填写构建设置

| 字段 | 填什么 |
| --- | --- |
| Project name | `fire0king-blog`（决定免费域名 `https://fire0king-blog.pages.dev`，只能小写字母/数字/连字符，建好后可改项目名但域名会跟着变） |
| Production branch | `main` |
| Framework preset | `Astro` |
| Build command | `pnpm build` |
| Build output directory | `dist` |
| Root directory | **留空** |

### 2.4 加环境变量

展开 **Environment variables (advanced)**，**Production** 和 **Preview** 都加上：

| 变量 | 值 | 说明 |
| --- | --- | --- |
| `NODE_VERSION` | `22` | 仓库要求 ≥ 22.23，写 `22` 会拿最新的 22.x |
| `PNPM_VERSION` | `11.22.0` | 与 `package.json` 的 `packageManager` 保持一致 |

**不要**加这些：

- ❌ `CF_WORKERS`（加了就变成 Worker 产物，Pages 用不了）
- ❌ `PUBLIC_BASE_PATH`（Cloudflare 是根路径；设成 `/Firefly_Blog` 会导致样式和链接全 404）
- ⏳ `PUBLIC_SITE_URL`：现在先不用加（会自动用 `CF_PAGES_URL`）；等第 5 节绑了自定义域名再加

### 2.5 部署

点 **Save and deploy**。第一次构建大约 **3~6 分钟**（要装依赖 + 跑 astro build + 生成搜索索引）。

---

## 3. 部署完成后自检

打开 `https://fire0king-blog.pages.dev/`（换成你自己的项目名），按下面清单过一遍：

| 检查项 | 期望 |
| --- | --- |
| 首页 | 正常显示，壁纸/头像/logo 都在 |
| `/live/` | 封面视频能播、月历和粉丝图正常（数据来自仓库里的 JSON） |
| 控制台 | 没有 404 / 500（尤其别出现 `/_image/?href=...` 这类地址） |
| 页面源码 `<link rel="canonical">` | 指向 `https://<项目名>.pages.dev/...` |
| `/sitemap-index.xml`、`/rss.xml` | 里的域名同样是 `pages.dev` |
| 搜索 | 按 `Ctrl+K` 能搜到文章（Pagefind 索引在 `dist/pagefind/`） |
| 手机打开 | 首屏开场动画正常，取景是左侧主体 |

如果某条不对，看第 7 节排错表。

---

## 4. 以后怎么更新

| 触发方式 | 结果 |
| --- | --- |
| 往 `main` 推送代码 | 自动构建 + 部署（和 GitHub Pages 那条 `deploy.yml` 并行跑，互不影响） |
| 直播数据提交（`chore(data): 更新直播数据 …`） | 同样触发构建，页面数据几分钟内更新 |
| 别的分支推送 | 生成**预览部署**（`<分支名>.<项目名>.pages.dev`），不覆盖线上 |
| 面板里改环境变量 | 会自动触发一次新构建 |
| 手动重跑 | Deployments → 选一次部署 → **Retry deployment**；回滚点 **Rollback to this deployment** |

**构建次数**：免费版 **500 次/月**、同时只能跑 1 个构建。按现在的采集策略（只在开播/下播/标题变化时提交，
标题变化有 30 分钟节流），一个月大约 200~360 次，够用但不宽裕。想压低：

1. `live-report.config.json` 里把 `followerSnapshotIntervalHours` 改成 `24`，轮询 `intervalMinutes` 改成 `15`；
2. 或者在数据提交的 commit message 里加 `[CI Skip]`（Cloudflare Pages 会跳过这次构建），
   只让「开播/下播」这类提交触发构建。

---

## 5. 缓存与加速说明

- `public/_headers` 已经给带内容哈希的目录设了长缓存，这是最安全也最有效的一档：
  - `/_astro/*`（CSS / JS / 优化后的图片）→ `max-age=31536000, immutable`
  - `/pagefind/*`（搜索索引）→ `max-age=86400`
  - 图片 / 视频 / 字体**故意没写死长缓存**，免得你换了素材之后访客还在看旧文件。
- HTML 由 Cloudflare 默认处理（不缓存），所以内容更新能立刻生效。
- 想强制清缓存：Dashboard → 选你的域名/项目 → **Caching → Configuration → Purge Everything**
  （Pages 项目也有 Purge 入口；清缓存的代价只是下一次回源变慢，不会丢数据）。
- 想在正式切换前先测速：用 `pages.dev` 域名和 `fire0king.github.io` 各跑一次
  <https://www.itdog.cn/http/> 或 <https://www.boce.com/> 的多地测速，看你的受众地区谁更快。

---

## 6. 绑定自定义域名（等你测速满意再做）

### 6.1 先理解限制

Cloudflare 只能给「**已经托管在你 Cloudflare 账号里的域名**」绑定自定义域名。你现在的 `twoleaf.cn`
的 NS 在 **DNSPod**（`f1g1ns1/2.dnspod.net`），所以：

| 想法 | 可行吗 |
| --- | --- |
| 把 `blog.twoleaf.cn` 绑到 Pages，但域名继续留在 DNSPod | ❌ 免费版不行（Cloudflare 的 CNAME setup 要 Business 套餐）。Pages 的自定义域名默认走 Cloudflare 自己的 NS |
| 把 `twoleaf.cn` 整个迁到 Cloudflare，再绑子域 | ✅ 可行，免费，但整域解析都要搬过去 |
| 用已经在 Cloudflare 上的别的域名 | ✅ 最省事 |

### 6.2 迁 NS 的步骤（确认要做再动手）

1. **先导出 DNSPod 现有解析**（控制台里截图或导出），迁完后逐条补齐。
2. Cloudflare → **Add a domain** → 输入 `twoleaf.cn` → 选 **Free** 套餐 → 它会扫描并列出找到的记录。
3. 核对记录，重点补上：
   - `bed.twoleaf.cn` → `111.42.114.71`：**保持「仅 DNS」（灰色云）**。国内服务器一旦开橙色云代理，
     流量会绕到海外节点，反而更慢。
   - 邮箱相关记录（`MX` / `TXT` 里的 SPF、DKIM）：Cloudflare 扫描可能漏，务必手工对照 DNSPod 补全。
4. 到 DNSPod 把域名的 NS 改成 Cloudflare 给的两个地址，等待生效（通常几分钟到几小时）。
5. 回到 Pages 项目 → **Custom domains** → **Set up a custom domain** → 填 `blog.twoleaf.cn` → 按提示确认
   （因为域名 NS 已在 Cloudflare，它会自动加好记录）。
6. 证书是自动签发的，等状态变成 **Active**（几分钟）。
7. 回到 Pages 的环境变量，加 `PUBLIC_SITE_URL = https://blog.twoleaf.cn`，重新部署一次，
   canonical / sitemap / RSS 才会指向新域名。

### 6.3 两个站点并存 / 切换

可以一直并存，互不影响：

| | GitHub Pages | Cloudflare Pages |
| --- | --- | --- |
| 地址 | `https://fire0king.github.io/`（根路径） | `https://<项目名>.pages.dev/`，绑域名后是 `https://blog.twoleaf.cn/` |
| 构建方 | `deploy.yml`（GitHub Actions，会注入 `PUBLIC_SITE_URL` / `PUBLIC_BASE_PATH`） | Cloudflare 自己的构建（用 `CF_PAGES_URL` 或你设的 `PUBLIC_SITE_URL`） |
| 数据 | 同一份仓库里的 JSON，两边都会跟着重建 | 同左 |

确认 Cloudflare 那边一切正常后，如果你想让 `github.io` 也跳过去，最简单的是把 GitHub Pages 保留当备份，
在站点里不做跳转；想强制跳转就在 Cloudflare 加一条 **Redirect Rule**（或者反过来，看你把哪个当主站）。

---

## 7. 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 构建失败，日志里是 `Unsupported engine` / Node 版本不够 | 环境变量没设 `NODE_VERSION=22`（要 ≥ 22.23） |
| 构建失败，`pnpm install` 报 `ERR_PNPM_BAD_PM_VERSION` 之类 | 环境变量补 `PNPM_VERSION=11.22.0`，和 `package.json` 里的 `packageManager` 一致 |
| 构建日志里有 `Failed to refresh CuteLeaf/Firefly; keeping cached data` | 正常提示：拉 GitHub API 失败时用仓库里的缓存数据，不影响构建 |
| 部署后样式/图片全丢、链接点到 404 | 多半是设了 `PUBLIC_BASE_PATH`，删掉它（Pages 是根路径） |
| 打开是 Worker 而不是网站 / 报 `Could not find assets` | 设了 `CF_WORKERS`，删掉它 |
| 页面里出现 `/_image/?href=...` 并且 404 | 说明产物不是纯静态或构建被中断，重新部署一次；本地 dev 里的 `MissingSharp` 是另一回事（重启 dev server） |
| canonical / sitemap 还指向 github.io | 环境变量 `PUBLIC_SITE_URL` 没设且 `CF_PAGES_URL` 没生效；手动加上 `PUBLIC_SITE_URL=https://你的域名` 再重新部署 |
| 免费构建次数用超 | 按第 4 节压低提交频率，或给非关键提交加 `[CI Skip]` |
| 想回滚 | Deployments → 选一个历史部署 → **Rollback to this deployment** |
| 想彻底退出 | 项目 Settings 底部 **Delete project**；GitHub Pages 一直是主站，不受影响 |

---

## 8. 检查清单（照抄版）

```
Project name:            fire0king-blog
Production branch:       main
Framework preset:        Astro
Build command:           pnpm build
Build output directory:  dist
Root directory:          (留空)
Environment variables (Production & Preview):
  NODE_VERSION = 22
  PNPM_VERSION = 11.22.0
  # 绑了自定义域名之后再加：
  # PUBLIC_SITE_URL = https://你的域名
不要设置：CF_WORKERS、PUBLIC_BASE_PATH
```
