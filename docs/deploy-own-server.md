# 部署到自己的云服务器（阿里云 `118.31.184.73` + `myqian-bao.top`）

把直播站再部署一份到自己的服务器上，和现有的 AstrBot / TS3 共存。
仓库产物是**纯静态**（23 MB / 336 个文件），服务器只需要一个 Web 服务托管它，不需要 Node 运行环境。

## 0. 已确认的环境

| 项 | 现状 |
| --- | --- |
| 服务器 | `118.31.184.73`（阿里云，2 核 2G，跑着 AstrBot + TS3），**22 端口开放** |
| 域名 | `myqian-bao.top`，NS 在阿里云（`dns15/16.hichina.com`），`@` 已解析到 `118.31.184.73` |
| `www.myqian-bao.top` | **还没有解析记录**（要用就加一条 CNAME/A） |
| 80 / 443 / 8888 | 从外网**都不通** → 要么阿里云安全组没放行，要么还没装 Web 服务 |
| 站点产物 | 纯静态 `dist/`，无需 Node/PHP 运行环境 |

## 1. 先确认两件事（不然会白忙一晚）

### 1.1 阿里云安全组放行 80 / 443

阿里云控制台 → 云服务器 ECS（或轻量应用服务器）→ 找到这台实例 → **安全组 / 防火墙** → 添加入方向规则：

| 协议 | 端口 | 授权对象 |
| --- | --- | --- |
| TCP | 80 | 0.0.0.0/0 |
| TCP | 443 | 0.0.0.0/0 |

（22 已开放，保持原样。轻量服务器在「防火墙」页，ECS 在「安全组」页。）

### 1.2 备案（关键，决定你能不能走 80/443）

大陆服务器 + 域名对外提供网站服务，**必须 ICP 备案**。阿里云对未备案域名会**拦截 80 端口**；
443 端口通常暂时还能用，但同样不合规、随时可能被拦，别当长期方案。

- 查：阿里云控制台 → **备案** → 我的备案。没有记录就是没备案。
- 办：首次备案免费，需要这台实例**剩余时长 ≥ 3 个月**（阿里云会给「备案服务码」），全程 7~20 个工作日。
  `.top` 属于可备案后缀，没问题。
- 备案期间想先看效果：临时用非标准端口（如 8443）访问，或先用 IP + 端口验证，等备案通过再切 80/443。

> 如果这台 ECS 的备案主体不是你本人（比如公司账号），或者你不想备案，那就只能用非标准端口，
> 且随时可能被拦——这点要先想清楚再往下做。

## 2. 服务器体检（SSH 上去跑一遍）

```bash
free -h          # 看内存还剩多少（AstrBot + TS3 之外还有多少余量）
df -h            # 看磁盘（站点只占 23MB）
ss -lntp         # 看端口占用：80/443 有没有被别的服务占着
systemctl status nginx 2>/dev/null || echo "没装 nginx"
ls /www/server/nginx 2>/dev/null && echo "看起来装了宝塔"   # 宝塔默认用 OpenResty
```

### 2.1 加 2G swap（2G 内存的保命操作，强烈建议）

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h   # 确认 Swap 那行有 2.0Gi
```

这样 AstrBot 抽风吃内存时，不会把 nginx 一起 OOM 掉（站点挂了你自己可能还不知道）。

## 3. 装 Web 服务（两条路，选一条）

### 路线 A：宝塔面板（可视化，推荐）

```bash
# 阿里云 CentOS/Alibaba Cloud Linux
yum install -y wget && wget -O install.sh https://download.bt.cn/install/install_6.0.sh && sh install.sh
# Ubuntu/Debian 用官方对应脚本
```

装完：

1. 面板 → **网站** → 添加站点：域名填 `myqian-bao.top`，根目录 `/www/wwwroot/myqian-bao.top`，PHP 版本选「纯静态」
2. 站点 → **SSL** → Let's Encrypt → 勾选域名 → 申请 → 打开「强制 HTTPS」
3. 站点 → **配置文件**，把第 6 节的缓存/压缩规则贴进去（宝塔的配置文件里加 `location` 段）
4. 面板 → 安全 → 放行 80/443（同时确认阿里云安全组也放行了）

### 路线 B：命令行 Nginx

```bash
# Ubuntu / Debian
sudo apt update && sudo apt install -y nginx
# Alibaba Cloud Linux / CentOS
sudo yum install -y nginx && sudo systemctl enable --now nginx

sudo mkdir -p /var/www/myqian-bao.top
# 配置见第 6 节，存到 /etc/nginx/conf.d/myqian-bao.top.conf
sudo nginx -t && sudo systemctl reload nginx

# 免费证书（自动续期）
sudo apt install -y certbot python3-certbot-nginx   # 或 yum install -y certbot python3-certbot-nginx
sudo certbot --nginx -d myqian-bao.top
```

## 4. 上传站点（先手动跑通，再做自动化）

先手动传一份，确认整条链路通了再上自动化：

```bash
# 本地（Windows PowerShell）打包
pnpm build                                  # 产物在 dist/
tar -czf blog-dist.tgz -C dist .            # 或直接用 WinSCP / 宝塔面板上传 dist 里的文件
# 上传后解到站点根目录
tar -xzf blog-dist.tgz -C /www/wwwroot/myqian-bao.top
chown -R www:www /www/wwwroot/myqian-bao.top   # 宝塔用 www 用户；纯 nginx 一般是 nginx 或 www-data
```

## 5. 自动部署：GitHub Actions → rsync

以后 push 一次就自动同步到服务器。

### 5.1 在服务器上生成部署专用密钥

```bash
ssh-keygen -t ed25519 -C "deploy-blog" -f ~/.ssh/deploy_blog -N ""
cat ~/.ssh/deploy_blog.pub >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
cat ~/.ssh/deploy_blog          # ← 把这段私钥内容复制走，填进 GitHub Secret
```

### 5.2 仓库里加 5 个 Secrets

GitHub 仓库 → Settings → Secrets and variables → Actions → New repository secret：

| 名称 | 值 |
| --- | --- |
| `SSH_HOST` | `118.31.184.73` |
| `SSH_PORT` | `22` |
| `SSH_USER` | 你的登录用户（宝塔一般用 `root`，建议新建一个普通用户） |
| `SSH_KEY` | 上面 `deploy_blog` 私钥的**完整内容** |
| `SSH_TARGET` | `/www/wwwroot/myqian-bao.top`（站点根目录） |

### 5.3 新增工作流 `.github/workflows/deploy-server.yml`

```yaml
name: Deploy to own server

on:
  workflow_dispatch:
  push:
    branches: [main]
    paths-ignore:
      - "docs/**"
      - "**.md"

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 11.22.0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - run: pnpm install --frozen-lockfile
      - name: Build
        env:
          PUBLIC_SITE_URL: https://myqian-bao.top
          PUBLIC_BASE_PATH: /
        run: pnpm build

      - name: Rsync to server
        uses: burnett01/rsync-deployments@7.0.2
        with:
          switches: -avzr --delete --exclude='.user.ini'
          path: dist/
          remote_path: ${{ secrets.SSH_TARGET }}
          remote_host: ${{ secrets.SSH_HOST }}
          remote_port: ${{ secrets.SSH_PORT }}
          remote_user: ${{ secrets.SSH_USER }}
          remote_key: ${{ secrets.SSH_KEY }}
```

> ⚠️ `--delete` 会删掉目标目录里 rsync 没同步到的文件，所以 `SSH_TARGET` 必须是**这个站点专属的目录**，
> 不要指向 `/www/wwwroot` 之类的上级目录；宝塔的 `.user.ini` 已用 `--exclude` 排除。
> 想稳妥点可以先去掉 `--delete` 跑几次，确认没问题再加上。

### 5.4 关于构建环境变量

- `PUBLIC_SITE_URL=https://myqian-bao.top` → canonical / sitemap / RSS 都指向新域名
- `PUBLIC_BASE_PATH=/` → 站点在根路径（**不要**设成 `/xxx`，否则样式和链接全 404）
- 本地构建时若遇到拉字体失败，可以加 `NODE_OPTIONS=--use-system-ca`（这台开发机的证书链问题，Actions 上不需要）

## 6. Nginx 配置（压缩 + 缓存）

```nginx
server {
    listen 80;
    server_name myqian-bao.top www.myqian-bao.top;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name myqian-bao.top www.myqian-bao.top;

    root /www/wwwroot/myqian-bao.top;
    index index.html;

    ssl_certificate     /path/to/fullchain.pem;   # 宝塔会在站点配置里自动写好这两行
    ssl_certificate_key /path/to/privkey.pem;

    # 压缩
    gzip on;
    gzip_comp_level 5;
    gzip_min_length 1024;
    gzip_types text/plain text/css application/javascript application/json
               image/svg+xml application/xml application/rss+xml;

    # 带内容哈希的资源：长缓存（文件名变了才会重新下载）
    location /_astro/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
    location /pagefind/ { expires 1d; }
    location ~* \.(?:woff2?|ttf|otf)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
    # 图片/视频可能被同名替换，缓存短一点，免得你看不到新素材
    location ~* \.(?:webp|avif|png|jpe?g|gif|svg|mp4|webm)$ {
        expires 1h;
    }

    # 页面 HTML 不缓存，保证内容更新立刻生效；trailingSlash: always → 目录式路由
    location / {
        add_header Cache-Control "no-cache";
        try_files $uri $uri/index.html $uri.html =404;
    }

    error_page 404 /404.html;
}
```

## 7. 回滚

发布前留一份备份，出问题直接覆盖回去：

```bash
# 每次部署前（可以加进 workflow）
tar -czf /www/backup/blog-$(date +%Y%m%d-%H%M).tgz -C /www/wwwroot/myqian-bao.top .
# 回滚
tar -xzf /www/backup/blog-20260918-1200.tgz -C /www/wwwroot/myqian-bao.top
```

## 8. 排错

| 现象 | 排查方向 |
| --- | --- |
| 外网打不开，服务器上 `curl -I http://127.0.0.1` 正常 | 阿里云**安全组**没放行 80/443；或未备案被拦（见 1.2） |
| 403 Forbidden | 站点目录权限/属主不对：`chown -R www:www 目录`（宝塔）或 `nginx/www-data` |
| 页面能开但样式/图片全丢 | 构建时 `PUBLIC_BASE_PATH` 不是 `/` |
| 分享卡片/canonical 还是 github.io | 构建时没设 `PUBLIC_SITE_URL` |
| 内页 404 | 少了 `try_files $uri $uri/index.html $uri.html` 这一段 |
| 502 / 站点时好时坏 | 内存不足：看 `free -h`、`dmesg -T \| tail`，确认 swap 生效 |
| rsync 报 Permission denied | 目标目录属主与 `SSH_USER` 不一致，或私钥没配对（`authorized_keys` 权限 600） |
| 打开很慢 | 服务器带宽只有几 Mbps；图片/视频建议继续放图床；后续可加国内 CDN |

## 9. 和 GitHub Pages 并存

两边可以同时在线，互不影响：

| | GitHub Pages | 自己的服务器 |
| --- | --- | --- |
| 地址 | `https://fire0king.github.io/` | `https://myqian-bao.top/` |
| 构建 | `deploy.yml`（Actions） | `deploy-server.yml`（Actions）或手动 |
| 数据 | 同一份仓库 JSON，两边都会跟着重建 | 同左 |

想只用一边也行：把对应的工作流删掉/停用即可。
