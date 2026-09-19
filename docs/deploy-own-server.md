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
- **备案审核期间可以先做的事**（本站的部署、Nginx、证书、自动同步全都能先做完）：

  ```bash
  # 1) 在服务器本机验证 Nginx 配置和站点内容（不经过阿里云的域名拦截）
  curl -I -H "Host: myqian-bao.top" http://127.0.0.1/
  # 2) 从外网用 IP 访问验证（IP 访问不受未备案域名拦截影响）
  #    需要把 IP 写进 server_name，或让这个 server 块作为 default_server
  #    http://118.31.184.73/
  # 3) 想用域名验证，就临时加一个非标准端口的 server 块（如 8443），
  #    60/443 以外的端口不受备案拦截影响；备案通过后再切回标准端口
  ```

  注意：域名解析已经指向这台服务器了，**备案通过前不要把 80/443 的站点地址到处发** —— 未备案域名
  走 80 端口会被阿里云阻断，访客看到的是超时，而不是你的页面。

> 如果这台 ECS 的备案主体不是你本人（比如公司账号），或者你不想备案，那就只能用非标准端口，
> 且随时可能被拦——这点要先想清楚再往下做。

## 2. 服务器体检（SSH 上去跑一遍）

```bash
free -h          # 看内存还剩多少（AstrBot + TS3 之外还有多少余量）
df -h            # 看磁盘（站点只占 23MB）
ss -lntp         # 看端口占用：80/443 有没有被别的服务占着
systemctl status nginx 2>/dev/null || echo "没装 nginx"
ls /www/server/nginx 2>/dev/null && echo "看起来装了宝塔"   # 宝塔默认用 OpenResty
dmesg -T | grep -i "out of memory"   # 过去有没有被 OOM 杀过进程 ← 判断要不要加 swap 的关键
docker stats --no-stream 2>/dev/null # AstrBot 是 docker 起的就能看到它吃多少内存
```

### 2.1 要不要加 swap（先判断，再决定）

**swap 不是"再加 2G 内存"**，它是硬盘上的应急溢出区：

| | 内存（RAM） | swap（硬盘上的文件） |
| --- | --- | --- |
| 速度 | 极快 | 慢一个数量级（普通云盘几 MB/s ~ 几十 MB/s） |
| 作用 | 真正干活的地方 | 内存不够时把"暂时不用的页"挪过去 |

**平时它一动都不动，不加也不减性能。** 只有物理内存快满时才有区别：

- **没有 swap** → 内核直接杀进程（OOM Killer），被杀的可能正是 AstrBot、TS3，或者 nginx（站点 502）
- **有 swap** → 挪到硬盘，机器变慢但不崩

所以它是"保险丝"而不是"扩容"。真正拖慢机器的是**频繁换页（thrashing）**：如果内存长期不够、数据在内存和硬盘之间反复搬，
AstrBot 会卡、TS3 语音会抖 —— 那是内存真的不够，该做的是给内存大户设上限（见下），而不是加更多 swap。

**判断方法**：上面 `dmesg` 有 OOM 记录 → 确实该加；`free -h` 里 available 还有 800MB+ 且没有 OOM 记录 → 可以不加，
或者只加 1G 意思一下。磁盘紧张（`df -h` 剩余 < 20G）就用 1G。

```bash
# 加 1G（够当保险丝；想按常规"swap ≈ 内存"来就写 2G）
sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
# 只在内存真正吃紧时才用 swap（默认 60 太激进，会提前把数据挪出去）
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf && sudo sysctl -p
free -h && swapon --show
```

**比加 swap 更根本的做法**：管住内存大户 AstrBot 的上限，别让它无限涨。

```bash
# Docker 起的话，重建容器时加内存限制
docker run --memory=800m --memory-swap=1g ...
# systemd 服务则加 MemoryMax
# [Service]
# MemoryMax=800M
```

这样即使 AstrBot 抽风，也不会把 nginx / TS3 一起拖下水。站点本身（nginx 托管静态文件）只占 10~20MB，
不是内存压力的来源。

## 3. 装 Web 服务（两条路，选一条）

### 路线 A：原生 Nginx（推荐，占用最小）

| | 常驻内存 | 说明 |
| --- | --- | --- |
| **原生 Nginx** | **约 5–15 MB** | 1–2 个 worker，静态站几乎不吃 CPU，没有额外守护进程；证书用 certbot，同样一条命令 |
| 宝塔面板 | 约 60–150 MB + OpenResty 10 MB | 面板 Python 守护进程常驻，还会开 8888 端口、默认劝你装 MySQL/PHP |

这台机器只有 2G，还要跑 AstrBot（可能 300MB~1G）+ TS3（~100MB），**宝塔那 60~150MB 不划算**，
而且面板端口暴露在公网多一个攻击面。以后真要图形化管 MySQL/多站点再装也不迟（装时只勾 Nginx，
别勾 PHP/MySQL）。

```bash
# Ubuntu / Debian
sudo apt update && sudo apt install -y nginx
# Alibaba Cloud Linux / CentOS
sudo yum install -y nginx && sudo systemctl enable --now nginx

sudo mkdir -p /var/www/myqian-bao.top

# ⚠️ 关键一步：把站点配置放进去，否则你打开网址看到的是 nginx 自带的 "Welcome to nginx!"
#    CentOS / Alibaba Cloud Linux → /etc/nginx/conf.d/myqian-bao.top.conf
#    Ubuntu / Debian            → /etc/nginx/conf.d/myqian-bao.top.conf（或 sites-available +软链到 sites-enabled）
#    配置内容见第 6 节「阶段一：先用 HTTP 跑通」。写完必须 reload：
sudo nginx -t && sudo systemctl reload nginx

# 证书等备案通过、域名能走 80 之后再申请（见第 6 节阶段二）
sudo apt install -y certbot python3-certbot-nginx   # 或 yum install -y certbot python3-certbot-nginx
```

### 路线 B：宝塔面板（想用图形化界面时）

```bash
# 阿里云 CentOS/Alibaba Cloud Linux
yum install -y wget && wget -O install.sh https://download.bt.cn/install/install_6.0.sh && sh install.sh
# Ubuntu/Debian 用官方对应脚本
```

装的时候**只选 Nginx**，不要勾 MySQL/PHP（静态站用不上）。然后：

1. 面板 → **网站** → 添加站点：域名填 `myqian-bao.top`，根目录 `/www/wwwroot/myqian-bao.top`，PHP 版本选「纯静态」
2. 站点 → **SSL** → Let's Encrypt → 勾选域名 → 申请 → 打开「强制 HTTPS」
3. 站点 → **配置文件**，把第 6 节的缓存/压缩规则贴进去
4. 面板 → 安全 → 放行 80/443（同时确认阿里云安全组也放行了），并把 8888 端口限制成只允许你的 IP

## 4. 上传站点（手把手，先手动跑通再做自动化）

### 4.0 先把"域名这件事"分清楚

| 事项 | 现状 | 要做的 |
| --- | --- | --- |
| DNS 解析（域名 → 服务器 IP） | ✅ `myqian-bao.top` 已经指向 `118.31.184.73` | **不用做**；想用 `www.myqian-bao.top` 再补一条记录 |
| 阿里云安全组 / 防火墙 | ❌ 80、443 从外网不通 | **放行 80/443**（见 1.1） |
| ICP 备案 | ❌ 还在审核 | 等；审核期间用 IP 验证（见 1.2） |

所以顺序是：**放行端口 → 传站点 → 用 IP 验证 → 备案通过后域名自动就能走 80/443**。
域名绑定（DNS）早就做好了，卡住的是端口和备案。

### 4.1 本地构建产物

在 Windows 本地（`D:\AAAQian_bao\Firefly_Blog`）：

```powershell
cd D:\AAAQian_bao\Firefly_Blog
$env:PUBLIC_SITE_URL="https://myqian-bao.top"   # canonical / sitemap / RSS 用
$env:PUBLIC_BASE_PATH="/"                       # 根路径，别写成 /xxx
$env:NODE_OPTIONS="--use-system-ca"             # 这台机器拉字体需要（Actions 上不用）
corepack pnpm build
```

构建完确认一下：

```powershell
Test-Path .\dist\index.html          # 必须是 True
(Get-ChildItem .\dist -Recurse -File | Measure-Object).Count   # 大约 336 个文件
```

> ⚠️ 不设 `PUBLIC_SITE_URL` 的话，页面里的 canonical / sitemap / RSS 会指向 `fire0king.github.io`。

### 4.2 方式一：WinSCP 图形化上传（推荐给你，不易出错）

1. 下载安装 WinSCP（<https://winscp.net/>，免费）
2. 新建会话：
   - 文件协议 `SFTP`，主机名 `118.31.184.73`，端口 `22`
   - 用户名 `root`（或你的登录用户），密码就是你 SSH 登录用的密码
   - 首次连接会问"是否信任该主机密钥" → 接受
3. 左侧切到本地 `D:\AAAQian_bao\Firefly_Blog\dist`，右侧进到 `/var/www/myqian-bao.top`
4. 在左侧全选（Ctrl+A）→ 拖到右侧 → 传输方式选"二进制"（默认即可）
5. 传完在右侧确认能看到 `index.html`、`_astro/`、`live/`、`pagefind/` 等

### 4.3 方式二：命令行 scp（Windows 10/11 自带）

先把内容打成一个 zip，避免 Windows 通配符的坑：

```powershell
Compress-Archive -Path .\dist\* -DestinationPath .\dist.zip -Force
scp .\dist.zip root@118.31.184.73:/tmp/
```

然后在服务器上解包（没有 `unzip` 就先装：`apt install -y unzip` 或 `yum install -y unzip`）：

```bash
sudo mkdir -p /var/www/myqian-bao.top
cd /var/www/myqian-bao.top && sudo unzip -o /tmp/dist.zip && rm /tmp/dist.zip
find /var/www/myqian-bao.top -type f | wc -l      # 应该 336 左右
```

### 4.4 设权限（403 Forbidden 基本都是这里没做对）

```bash
# 先看 nginx 是以哪个用户跑的：第一列就是用户名
ps aux | grep nginx | head -3

# Debian / Ubuntu 一般是 www-data
sudo chown -R www-data:www-data /var/www/myqian-bao.top
# Alibaba Cloud Linux / CentOS 一般是 nginx
# sudo chown -R nginx:nginx /var/www/myqian-bao.top

sudo find /var/www/myqian-bao.top -type d -exec chmod 755 {} \;
sudo find /var/www/myqian-bao.top -type f -exec chmod 644 {} \;
```

### 4.5 验证（备案前用 IP，别用域名）

```bash
# ① 服务器本机（不经过阿里云对未备案域名的拦截）
curl -I http://127.0.0.1/                 # 期望 200 或 301
curl -s http://127.0.0.1/ | head -c 120   # 能看到 HTML

# ② 你自己的电脑浏览器打开（IP 访问不受备案影响）
#    http://118.31.184.73/
```

逐项对照：

| 现象 | 原因 |
| --- | --- |
| 连接被拒 / 超时 | 阿里云安全组没放行 80（见 1.1） |
| 403 Forbidden | 4.4 的属主/权限没设对，或 nginx 的 `root` 指错了目录 |
| 404 | `root` 目录里没有 `index.html`（解包路径错了，套多了一层目录） |
| 502 / 500 | nginx 配置写错：`sudo nginx -t` 看提示 |
| 页面能开但样式/图片全丢 | 构建时 `PUBLIC_BASE_PATH` 不是 `/` |

### 4.6 以后怎么更新

- **手动**：重复 4.1 + 4.2（或 4.3）
- **自动（推荐）**：按 **5.5 节**装一次"服务器侧拉取"。之后 push 或数据更新，服务器会在 2 分钟内自己更新，
  你不用做任何事，也**不需要开放入站 SSH**
- **自动（旧方式）**：5.1–5.4 的 CI 推送（rsync）。已改成只能手动触发，留作应急兜底

## 5. 自动部署（两种方式）

| 方式 | 原理 | 评价 |
| --- | --- | --- |
| **5.5 服务器侧拉取** | CI 只发布构建产物，服务器定时主动来下载 | **推荐**：不需要入站 SSH、不会有异地登录告警、部署私钥也不必放 GitHub |
| 5.1–5.4 CI 推送（rsync） | CI 用 SSH 登录服务器把文件推上去 | 旧的推送式部署，已改成只能手动触发，留作应急兜底 |

建议先把 **5.5** 跑通；确认侧拉取稳定后，再按 5.5.6 清理旧方式（删 Secrets、删工作流、收紧 22 端口）。

### 5.1 配置部署专用的 SSH 密钥（手把手）

**先分清两个文件**（90% 的失败都出在这里）：

| 文件 | 内容特征 | 放到哪里 |
| --- | --- | --- |
| `deploy_blog`（**私钥**） | 首行是 `-----BEGIN OPENSSH PRIVATE KEY-----` | **GitHub Secret `SSH_KEY`** |
| `deploy_blog.pub`（**公钥**） | 一行 `ssh-ed25519 AAAA…` | **服务器**的 `~/.ssh/authorized_keys` |

#### ① 在服务器上生成一对专用密钥

```bash
# -N "" 表示不设口令：CI 里没法交互输入口令，必须为空
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/deploy_blog -N ""
```

（提示文件已存在就覆盖，或换个名字如 `deploy_blog2`。）

#### ② 把公钥装到"工作流要登录的那个用户"名下

工作流里的 `SSH_USER` 是谁，就装到谁的 `authorized_keys`：

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
cat ~/.ssh/deploy_blog.pub >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

权限不对 sshd 会直接拒绝（服务器日志里是 `Authentication refused: bad ownership or modes`）。

#### ③ 装完先在服务器上自测（别急着动 GitHub）

```bash
# ① 私钥能否解析（不提示输入口令才算合格）
ssh-keygen -y -f ~/.ssh/deploy_blog

# ② 公钥确实在 authorized_keys 里（应输出 1）
grep -c "$(ssh-keygen -y -f ~/.ssh/deploy_blog)" ~/.ssh/authorized_keys

# ③ 用私钥能免密登录（应打印 OK，且不问密码）
ssh -i ~/.ssh/deploy_blog -o StrictHostKeyChecking=accept-new root@118.31.184.73 "echo OK; hostname"
```

三条都过 → 密钥没问题；③ 若还问密码 → 公钥没装对或用户不对。

#### ④ 把私钥**全文**填进 GitHub Secret

```bash
cat ~/.ssh/deploy_blog
```

**要复制**：从 `-----BEGIN OPENSSH PRIVATE KEY-----` 到最后一行 `-----END OPENSSH PRIVATE KEY-----` 的**全部内容**
（这两行本身就是密钥格式的一部分，少一行 ssh 就无法解析；中间的 base64 行一行都不能漏）。

**不要复制**：命令提示符那一行（如 `root@izbp…:~# cat …`）、公钥那行（`ssh-ed25519 AAAA…`）、前后其它命令的输出。

**粘贴前先本地自检**（Windows 自带 `ssh-keygen`）：把要粘的内容存成文件，然后

```powershell
ssh-keygen -y -f C:\Users\你\deploy_blog
```

- 打印出一行 `ssh-ed25519 AAAA…`（应与服务器上 `cat ~/.ssh/deploy_blog.pub` 一致）→ 格式正确
- 报 `invalid format` / `error in libcrypto` → 复制不完整或粘成了公钥
- 提示 `Enter passphrase` → 私钥带口令，不能用于 Actions（用 `-N ""` 重新生成）

终端复制容易漏最后一行，更稳的是用 WinSCP（选项 → 面板 → 显示隐藏文件）把 `/root/.ssh/deploy_blog`
拖到 Windows，用记事本打开全选复制。

仓库 → Settings → Secrets and variables → Actions → 更新 `SSH_KEY`。

#### ⑤ 重跑验证（不用推代码）

Actions → **Deploy to own server** → **Run workflow**。日志开头应出现：

```
SSH_KEY 首行：-----BEGIN OPENSSH PRIVATE KEY-----
SSH_KEY 行数：7
私钥格式 OK，指纹：SHA256:…
```

接着是**预检**（rsync 是否存在、目标目录是否存在且可写），最后才 rsync 同步。

#### 常见错法对照

| 现象 | 原因 |
| --- | --- |
| 首行是 `ssh-ed25519 AAAA…` | 粘的是**公钥** `.pub` |
| `ssh-keygen -y` 提示输入口令 | 私钥**带 passphrase** → 用 `-N ""` 重新生成 |
| 首行对但行数偏少 / 末尾没有 END 行 | 复制**不完整** |
| 首行是 `-----BEGIN PRIVATE KEY-----`（PKCS#8）或 `.ppk` | 格式不对 → 重新用 `ssh-keygen` 生成 OpenSSH 格式 |

#### 可选：不用 root，建一个只用于发布的用户

用 root 意味着这个密钥在服务器上有全部权限。想收窄：

```bash
useradd -m -s /bin/bash deploy
mkdir -p /home/deploy/.ssh && chmod 700 /home/deploy/.ssh
cat ~/.ssh/deploy_blog.pub >> /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys && chown -R deploy:deploy /home/deploy/.ssh
# 让 deploy 能写站点目录，nginx（www-data）仍能读
chown -R deploy:www-data /var/www/myqian-bao.top
chmod -R 755 /var/www/myqian-bao.top
```

然后把 Secret `SSH_USER` 改成 `deploy`（`SSH_TARGET` 不变）。不放心就先不动，root 也能跑通。

### 5.2 仓库里加 5 个 Secrets

GitHub 仓库 → Settings → Secrets and variables → Actions → New repository secret：

| 名称 | 值 |
| --- | --- |
| `SSH_HOST` | `118.31.184.73` |
| `SSH_PORT` | `22` |
| `SSH_USER` | 你的登录用户（宝塔一般用 `root`，建议新建一个普通用户） |
| `SSH_KEY` | 上面 `deploy_blog` 私钥的**完整内容** |
| `SSH_TARGET` | `/var/www/myqian-bao.top`（站点根目录；用宝塔的话是 `/www/wwwroot/myqian-bao.top`） |

### 5.3 工作流已经内置：`.github/workflows/deploy-server.yml`

仓库里已经有这个文件，**默认只能手动触发**（Actions 页面 → Deploy to own server → Run workflow），
所以在 Secrets 配好之前它不会运行、也不会影响 GitHub Pages 的自动部署。它做的事：

1. 先检查 5 个 Secrets 是否齐全，缺了就直接报错并提示看本文档（不会跑到一半才失败）
2. `pnpm install` + `pnpm build`（注入 `PUBLIC_SITE_URL` / `PUBLIC_BASE_PATH=/`）
3. rsync `dist/` 到 `SSH_TARGET`

两个手动参数：

| 参数 | 说明 |
| --- | --- |
| `site_url` | 构建时注入的站点地址，默认 `https://myqian-bao.top` |
| `prune` | 是否删除服务器上多余的文件（`--delete`）。**首次部署建议 false**，核对目录无误后再开 |

**想改成 push 就自动同步**：把文件里 `push:` 那几行注释去掉即可（建议先手动跑通一次）。

> ⚠️ `prune` 打开时 `--delete` 会删掉目标目录里 rsync 没同步到的文件，所以 `SSH_TARGET` 必须是
> **这个站点专属的目录**（例如 `/var/www/myqian-bao.top`），不要指向 `/var/www` 之类的上级目录。
> 宝塔环境下的 `.user.ini` 已经在 workflow 里用 `--exclude` 排除。

### 5.4 关于构建环境变量

- `PUBLIC_SITE_URL=https://myqian-bao.top` → canonical / sitemap / RSS 都指向新域名
- `PUBLIC_BASE_PATH=/` → 站点在根路径（**不要**设成 `/xxx`，否则样式和链接全 404）
- 本地构建时若遇到拉字体失败，可以加 `NODE_OPTIONS=--use-system-ca`（这台开发机的证书链问题，Actions 上不需要）

### 5.5 推荐：服务器侧拉取（不用入站 SSH，也就没有异地登录告警）

**为什么换成这个**：5.1–5.4 的方向是"CI 登录服务器推文件"，而 GitHub 的运行器在国外机房（Azure），
阿里云会把这种 root 登录判成**异地登录**并告警；同时部署私钥必须放进 GitHub Secrets、22 端口对全网开放。
侧拉取把方向反过来 —— 服务器自己出站去取：

```
你 push / 采集机器人提交数据
        ↓
GitHub Actions：pnpm build → 打包 site.tar.gz → 发布到 Release（tag: site-latest）
        ↓（服务器主动下载，出站 HTTPS，不需要任何入站端口）
systemd timer（每 2 分钟）→ 有新版本才下载 → 解包校验 → rsync 到站点根目录
```

好处：服务器上不再出现任何"外部 IP 登录"；CI 手里不再持有服务器私钥。
代价：不是秒级发布，最坏要等 2 分钟（频率可调，见 5.5.7）。

新增的文件：

| 文件 | 作用 |
| --- | --- |
| `.github/workflows/publish-site.yml` | 构建 → 打包 → 发布滚动 Release（每次构建覆盖上传附件） |
| `deploy/server/pull-site.sh` | 服务器侧拉取脚本（比对版本 → 下载 → 校验 → 同步 → 清理旧版本） |
| `deploy/server/site-pull.service`、`deploy/server/site-pull.timer` | systemd 单元（每 2 分钟检查一次） |
| `deploy/server/install.sh` | 一键安装脚本 |

#### 5.5.1 三个前提（30 秒确认）

```bash
# ① 服务器能访问 GitHub —— 侧拉取的前提
curl -fsI https://github.com | head -n1        # 期望看到 HTTP/2 200 之类

# ② 站点根目录存在（沿用现在的目录即可）
ls -ld /var/www/myqian-bao.top

# ③ 产物已经发布过：能打开这个页面说明发布工作流跑过了
#    https://github.com/Fire0King/Fire0King.github.io/releases/tag/site-latest
```

#### 5.5.2 一键安装（复制粘贴两条命令）

```bash
curl -fsSL https://github.com/Fire0King/Fire0King.github.io/releases/download/site-latest/install.sh -o /tmp/site-install.sh
sudo bash /tmp/site-install.sh
```

脚本做的事（出问题就按这个顺序查）：

1. 检查并补齐 `curl / tar / rsync / flock`
2. 验证服务器能访问 `github.com`（不通会直接提示，并指向 5.5.5）
3. 从 Release 下载 `pull-site.sh` 和两个 systemd 单元，装到 `/usr/local/bin`、`/etc/systemd/system`
4. 把配置写进 `/etc/default/site-pull`（仓库、站点根目录、目录属主、保留版本数）
5. **立刻同步一次**（前台执行，你直接能看到结果）
6. 启用 `site-pull.timer`：开机 3 分钟后首跑，之后每 2 分钟检查一次

**目录/属主不是默认值时**（宝塔环境、或 nginx 用户）：

```bash
sudo SITE_WEB_ROOT=/www/wwwroot/myqian-bao.top SITE_WEB_USER=www bash /tmp/site-install.sh
```

> 只想先看会发生什么：`sudo env SITE_DRY_RUN=1 /usr/local/bin/site-pull.sh`
> 它会把产物解包到 `/var/lib/site-pull/releases/<提交号>` 但**不碰线上目录**。

#### 5.5.3 验证

```bash
journalctl -u site-pull.service -n 50 --no-pager     # 这次同步的完整日志
cat /var/lib/site-pull/current-sha                   # 当前线上的提交号
curl -I http://127.0.0.1/                            # 站点正常响应（本机，绕开备案拦截）
systemctl list-timers site-pull.timer                # 下一次检查时间
```

想验证"自动更新"整条链：随便改点内容 push（或等采集机器人提交数据），然后在服务器上

```bash
journalctl -u site-pull.service -f
```

2 分钟内应看到 `发现新版本 xxx → 已同步到 … → ✅ 发布完成`。

#### 5.5.4 手动操作与回滚

```bash
sudo /usr/local/bin/site-pull.sh                  # 手动同步一次（没有新版本就不动）
sudo env SITE_FORCE=1 /usr/local/bin/site-pull.sh # 强制按最新产物重同步一遍
sudo systemctl disable --now site-pull.timer      # 临时停用自动更新

# 回滚：服务器保留了最近 3 个版本
ls -1dt /var/lib/site-pull/releases/*/            # 最新的在最上面
rsync -a --delete /var/lib/site-pull/releases/<要回滚的提交号>/ /var/www/myqian-bao.top/
```

#### 5.5.5 服务器访问不了 GitHub（国内机房常见）

```bash
getent hosts github.com                  # 有没有解析结果
curl -vI https://github.com 2>&1 | tail -n 5
```

- 只是**慢**：不用管，脚本自带 `--retry 3` 和最长 10 分钟超时。
- 完全**不通**：换个下载源即可，脚本支持 `SITE_BASE_URL` 指向任意前缀。最省事的是阿里云 OSS
  （与 ECS 同地域，走内网地址还免流量费）：CI 里加一步把 `site.tar.gz`、`version.json` 传到 OSS，然后

```bash
sudo nano /etc/default/site-pull
#   SITE_BASE_URL=https://<你的bucket>.oss-cn-hangzhou-internal.aliyuncs.com/site
sudo systemctl restart site-pull.timer
```

- ⚠️ **不要**用公共的"GitHub 加速/代理"站点做部署链路：产物会经过第三方，静态站被注入一段 JS 就会影响所有访客。

#### 5.5.6 收尾：把入站依赖真正去掉（确认稳定后再做）

1. 删除 GitHub 的 5 个 Secrets（`SSH_HOST` / `SSH_PORT` / `SSH_USER` / `SSH_KEY` / `SSH_TARGET`）
   —— 侧拉取不需要它们，GitHub 上少存一份服务器私钥更安全
2. 删除 `.github/workflows/deploy-server.yml`（旧的推送式部署）
3. 阿里云安全组：把 22 端口的来源限制成你自己的常用 IP（此时 CI 已经不需要连服务器了）
4. sshd 加固：`PasswordAuthentication no`、`PermitRootLogin prohibit-password`，并装 fail2ban
5. 阿里云历史告警：云安全中心 → **安全告警** → 云工作负载保护平台(CWPP) → 告警类型选 **异常登录**
   → 选中旧告警 → **加白名单** 或 **忽略**

#### 5.5.7 顺带回答"怎么让阿里云不告警"

- **根因消除（推荐）**：换成侧拉取后，服务器上不会再出现 GitHub 运行器（国外 IP）的登录事件
- **阿里云侧静音**：云安全中心 → **防护配置 > 主机防护 > 规则管理** → **常用登录管理**，
  在 **常用登录地 / 常用登录IP** 里把你允许的来源加进去；不想收短信就去 **系统配置 > 通知设置**
  取消短信（保留站内信，仍然能看到告警）
- **别把"异常登录"整类关掉**：真被人爆破时，它是唯一的提醒

##### 5.5.8 排错表

| 现象 | 原因 / 处理 |
| --- | --- |
| 安装时报 `404` | `publish-site.yml` 还没成功跑过，Release 未生成 → 去 Actions 看那次运行为什么失败 |
| 日志 `拉取 version.json 失败` | 服务器访问不了 GitHub（见 5.5.5），或 Release 被人删了 |
| 日志 `缺少命令 flock` | `apt install -y util-linux`（install.sh 会自动装） |
| 日志说发布完成，但页面没变 | ① `curl -I http://127.0.0.1/` 确认服务器文件确实变了；② 浏览器强刷 Ctrl+F5；③ `nginx -T \| grep root` 确认 nginx 的 `root` 就是 `SITE_WEB_ROOT` |
| 页面 403 | 属主不对：`SITE_WEB_USER` 要与 nginx 运行用户一致（Ubuntu 是 `www-data`） |
| 想改成 5 分钟检查一次 | `sudo systemctl edit site-pull.timer` → 写 `[Timer]` 和 `OnUnitActiveSec=5min` → `systemctl daemon-reload && systemctl restart site-pull.timer` |
| 服务器上残留了旧文件没被删 | 脚本保留了 `.user.ini`（宝塔用）和 `.well-known`（ACME 用），属预期行为 |
| 磁盘被历史版本占满 | `SITE_KEEP` 默认保留 3 个版本，可在 `/etc/default/site-pull` 调小 |

## 6. Nginx 配置（分两个阶段，别一次写完）

### 阶段一：先用 HTTP 跑通（备案审核期间用 IP 验证）

把下面这段存成 `/etc/nginx/conf.d/myqian-bao.top.conf`（Debian/Ubuntu 放 `sites-available` 再软链到
`sites-enabled` 也行），然后 `sudo nginx -t && sudo systemctl reload nginx`：

```nginx
server {
    listen 80;
    listen [::]:80;
    # 必须把服务器 IP 也写进来：备案通过前你是用 http://118.31.184.73/ 访问的，
    # 只写域名的话 IP 请求会落到 nginx 自带的默认站点 → 显示 "Welcome to nginx!"
    server_name myqian-bao.top www.myqian-bao.top 118.31.184.73;

    root /var/www/myqian-bao.top;   # 宝塔路线则是 /www/wwwroot/myqian-bao.top
    index index.html;

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

顺便把 nginx 自带的示例站关掉，免得它抢请求：

```bash
# CentOS / Alibaba Cloud Linux
sudo rm -f /etc/nginx/conf.d/default.conf
# Debian / Ubuntu
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

### 阶段二：备案通过后加 HTTPS

**备案通过前不要写 80 → 443 的跳转**：那时候还没有证书，跳过去只会看到证书错误。
等备案通过（域名能正常走 80）后，用 certbot 自动改配置：

```bash
sudo certbot --nginx -d myqian-bao.top            # 会自动申请证书并写入 ssl_certificate
sudo certbot --nginx -d myqian-bao.top -d www.myqian-bao.top
# 想强制 HTTPS：certbot 会问是否 redirect，选 2（Redirect）
```

certbot 会把证书路径、443 server 块、80→443 跳转都加好，缓存/压缩规则保留不动。
之后 `systemctl list-timers | grep certbot` 可以确认自动续期。

### 6.1 已经跑过 certbot 的机器：一个文件直接复制

如果你之前已经 `certbot --nginx` 过（机器上已经有 443/certbot 的配置），**不要直接再新建一份**
—— 会出现同一个 `server_name` 出现在两个文件里，nginx 只认先加载的那个（表现为"改了没生效"）。

**先备份并移走旧配置**（包括 nginx 自带的默认站点，它是 80 的 default_server）：

```bash
ls -l /etc/nginx/conf.d/ /etc/nginx/sites-enabled/ 2>/dev/null
grep -rln "myqian-bao.top" /etc/nginx/          # 看看你的配置在哪些文件里
sudo mkdir -p /root/nginx-backup
sudo mv /etc/nginx/sites-enabled/default       /root/nginx-backup/ 2>/dev/null   # Debian/Ubuntu 默认站
sudo mv /etc/nginx/sites-enabled/myqian-bao.top /root/nginx-backup/ 2>/dev/null  # 之前写的那份
sudo mv /etc/nginx/conf.d/default.conf          /root/nginx-backup/ 2>/dev/null  # CentOS 默认站
sudo certbot certificates                       # 确认证书路径（下面配置里要用）
```

再新建 `/etc/nginx/conf.d/myqian-bao.top.conf`，**整段复制**下面内容（HTTP 和 HTTPS 都覆盖了，
所以不管备案走到哪一步、用 IP 还是域名都能访问）：

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name myqian-bao.top www.myqian-bao.top 118.31.184.73;

    root /var/www/myqian-bao.top;
    index index.html;

    gzip on;
    gzip_comp_level 5;
    gzip_min_length 1024;
    gzip_types text/plain text/css application/javascript application/json
               image/svg+xml application/xml application/rss+xml;

    location /_astro/ { expires 1y; add_header Cache-Control "public, immutable"; }
    location /pagefind/ { expires 1d; }
    location ~* \.(?:woff2?|ttf|otf)$ { expires 1y; add_header Cache-Control "public, immutable"; }
    location ~* \.(?:webp|avif|png|jpe?g|gif|svg|mp4|webm)$ { expires 1h; }
    location / {
        add_header Cache-Control "no-cache";
        try_files $uri $uri/index.html $uri.html =404;
    }
    error_page 404 /404.html;

    # 备案通过、域名能正常走 80 之后，取消下一行注释即可强制跳 HTTPS
    # return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    # nginx ≥ 1.25.1 用这个（Ubuntu 24.04 自带的就是 1.24+/1.28）；
    # 更老的版本改成 `listen 443 ssl http2;` 并删掉这一行
    http2 on;
    server_name myqian-bao.top www.myqian-bao.top 118.31.184.73;

    # 路径以 `sudo certbot certificates` 的输出为准
    ssl_certificate     /etc/letsencrypt/live/myqian-bao.top/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/myqian-bao.top/privkey.pem;

    root /var/www/myqian-bao.top;
    index index.html;

    # nginx 的 server 块之间不继承，所以 gzip 和 location 段要再写一遍
    gzip on;
    gzip_comp_level 5;
    gzip_min_length 1024;
    gzip_types text/plain text/css application/javascript application/json
               image/svg+xml application/xml application/rss+xml;

    location /_astro/ { expires 1y; add_header Cache-Control "public, immutable"; }
    location /pagefind/ { expires 1d; }
    location ~* \.(?:woff2?|ttf|otf)$ { expires 1y; add_header Cache-Control "public, immutable"; }
    location ~* \.(?:webp|avif|png|jpe?g|gif|svg|mp4|webm)$ { expires 1h; }
    location / {
        add_header Cache-Control "no-cache";
        try_files $uri $uri/index.html $uri.html =404;
    }
    error_page 404 /404.html;
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx

# 验证
curl -I -H "Host: myqian-bao.top" http://127.0.0.1/    # 期望 200 或 301
curl -s http://127.0.0.1/ | head -c 120                # 应出现你自己的 HTML，而不是 Welcome to nginx
```

> 证书用的是域名，所以 **`https://118.31.184.73/` 一定会报证书错误**（证书不覆盖 IP）—— 用 IP 测就测 HTTP。

### 6.2 Ubuntu / Debian 上的路径对照（本机实测：nginx 1.28.3 on Ubuntu）

| 项 | 位置 |
| --- | --- |
| 你的站点配置 | `/etc/nginx/conf.d/myqian-bao.top.conf`，或 `sites-available/` + 软链到 `sites-enabled/`（两种都会被 `nginx.conf` 加载） |
| nginx **自带默认站** | `/etc/nginx/sites-enabled/default` → 就是它 `listen 80 default_server` + `root /var/www/html` 导致看到 "Welcome to nginx!"；`sudo rm -f /etc/nginx/sites-enabled/default` 去掉这个**软链**即可（原文件还在 `sites-available/`，随时能恢复） |
| nginx 运行用户 | `www-data` → 目录属主用 `chown -R www-data:www-data /var/www/myqian-bao.top` |
| 配置检查 / 重载 | `sudo nginx -t && sudo systemctl reload nginx` |
| 出错日志 | `sudo tail -n 50 /var/log/nginx/error.log`（改完配置看不到效果先看这里） |
| HTTP/2 | 1.25.1+ 用 server 块里的 `http2 on;`；老版本用 `listen 443 ssl http2;` |


## 7. 回滚

发布前留一份备份，出问题直接覆盖回去：

```bash
# 每次部署前先备份（先 mkdir -p /root/backup；也可以加进 workflow）
tar -czf /root/backup/blog-$(date +%Y%m%d-%H%M).tgz -C /var/www/myqian-bao.top .
# 回滚
tar -xzf /root/backup/blog-20260918-1200.tgz -C /var/www/myqian-bao.top
```

用**服务器侧拉取**（5.5 节）时更省事，服务器上就留着最近 3 个版本，直接覆盖回去即可：

```bash
ls -1dt /var/lib/site-pull/releases/*/     # 最新的在最上面
rsync -a --delete /var/lib/site-pull/releases/<要回滚的提交号>/ /var/www/myqian-bao.top/
```

## 8. 排错

| 现象 | 排查方向 |
| --- | --- |
| 打开是 **"Welcome to nginx!"** | 请求被 nginx 自带默认站点接走了。自查三步：① `grep -rln "myqian-bao.top" /etc/nginx/` 看你的配置文件在哪、`nginx -T \| grep -nE "server_name\|root "` 看**你的块里 `root` 是否指向上传目录**（很多人是 `/var/www/html`，那是欢迎页目录）；② 用 IP 访问时 `server_name` 里必须写进服务器 IP（只有域名匹配不上就落到 `default_server`）；③ 改完必须 `nginx -t && systemctl reload nginx` |
| 外网打不开，服务器上 `curl -I http://127.0.0.1` 正常 | 阿里云**安全组**没放行 80/443；或未备案被拦（见 1.2） |
| 403 Forbidden | 站点目录权限/属主不对：`chown -R www:www 目录`（宝塔）或 `nginx/www-data` |
| 页面能开但样式/图片全丢 | 构建时 `PUBLIC_BASE_PATH` 不是 `/` |
| 分享卡片/canonical 还是 github.io | 构建时没设 `PUBLIC_SITE_URL` |
| 内页 404 | 少了 `try_files $uri $uri/index.html $uri.html` 这一段 |
| 用 IP 访问提示证书错误 | 证书是按域名签发的，不覆盖 IP；备案前用 `http://IP`，或者直接用域名访问 |
| 502 / 站点时好时坏 | 内存不足：看 `free -h`、`dmesg -T \| tail`，确认 swap 生效 |
| rsync 报 Permission denied | 目标目录属主与 `SSH_USER` 不一致，或私钥没配对（`authorized_keys` 权限 600） |
| 打开很慢 | 服务器带宽只有几 Mbps；图片/视频建议继续放图床；后续可加国内 CDN |

### 8.2 GitHub Actions 部署到服务器失败怎么定位

工作流按顺序跑这些步骤，**哪一步红就直接看那一行的日志**（Actions → 点开这次运行）：

| 步骤 | 失败含义 | 处理 |
| --- | --- | --- |
| 检查 Secrets 是否就绪 | 某个 Secret 没配（日志会列出缺哪个） | 按 5.2 补齐 |
| 安装依赖 / 构建 | 代码或依赖问题，和服务器无关 | 本地 `pnpm build` 复现 |
| **写入部署私钥** | `SSH_KEY` 不是有效的未加密 OpenSSH 私钥 | 见 5.1 ④：要复制 `-----BEGIN…END-----` 全文；首行若是 `ssh-ed25519 AAAA…` 说明粘成了公钥；提示 passphrase 说明私钥带口令 |
| **预检（SSH / rsync / 目标目录）** | 退出码 3 = 服务器没装 rsync（`sudo apt install -y rsync`）；4 = 目标目录不存在（`mkdir -p`）；5 = 目录不可写（`chown`） | 按日志提示在服务器上修 |
| 同步 dist/ 到服务器 | 一般是 SSH 用户名/权限问题（`Permission denied (publickey)`） | `SSH_USER` 必须是 `authorized_keys` 所属的那个用户；确认公钥已装（5.1 ②③） |

> 私钥改动后**不需要推代码**：Actions → Deploy to own server → **Run workflow** 即可重跑。

### 8.3 域名能解析、但访问 403（用 IP 却正常）

按这个顺序区分，**先判断是 nginx 的问题还是阿里云备案拦截**：

```bash
# ① 在服务器本机、带上域名的 Host 头请求自己 —— 这一步绕开了所有外部拦截
curl -I -H "Host: myqian-bao.top" http://127.0.0.1/     # 期望 200
```

- **① 返回 200** → 你的 nginx 配置没问题，问题在外部拦截，看下面 ②
- **① 不是 200** → 是 nginx 自身问题（`root` 指错目录 / 目录权限 / `try_files` 缺失）：
  ```bash
  sudo nginx -T | grep -nE "listen|server_name|root " | head -30
  ```
  修法：让**同一个** server 块的 `server_name` 同时包含域名和服务器 IP，`root` 指向站点目录：
  ```nginx
  server_name myqian-bao.top www.myqian-bao.top 118.31.184.73;
  root /var/www/myqian-bao.top;
  ```

```bash
# ② 从外网访问域名
curl -I http://myqian-bao.top/
```

| 现象 | 含义 | 处理 |
| --- | --- | --- |
| **403 且响应头是 `Server: Beaver`**（不是你的 nginx） | **阿里云对未备案域名的拦截** | 等 ICP 备案通过；期间用 IP 访问（IP 不受拦截） |
| 连接被重置 / 超时（`curl` 报 000、`Empty reply`） | 同上，备案拦截的另一种表现 | 同上 |
| 403 且响应头是 `Server: nginx` | nginx 的 `root`/权限问题（回到 ① 排查） | 修 nginx |

> 判断窍门：**同一个 IP，只把 Host 换成域名就 403**，而 IP 直连是 200 —— 说明拦的是"域名"，
> 即备案拦截，服务器本身没毛病。备案通过后域名会自动恢复，不需要改任何配置。


### 8.1 诊断"到底哪个 server 块在服务我"

```bash
# 1) 看最终生效的配置（含每个块的位置、listen、server_name、root）
sudo nginx -T | grep -nE "listen|server_name|root " | head -40

# 2) 用 Host 头区分：带 Host 正常、不带显示欢迎页 → server_name 没写 IP
curl -I -H "Host: myqian-bao.top" http://127.0.0.1/
curl -I http://127.0.0.1/

# 3) 你的配置和 nginx 自带默认站点分别在哪
grep -rln "myqian-bao.top" /etc/nginx/
grep -rln "default_server" /etc/nginx/
```

> ⚠️ 如果 `grep` 显示**你的域名和 `default_server` 在同一个文件里**（例如都写在 `sites-enabled/default`），
> 不要直接删这个文件 —— certbot 加的 443/证书配置可能也在里面。只改 `root`（指向上传目录）和
> `server_name`（把服务器 IP 写进去）即可：IP 请求命中你的块后，就不会再落到 `default_server`。


## 9. 和 GitHub Pages 并存

两边可以同时在线，互不影响：

| | GitHub Pages | 自己的服务器 |
| --- | --- | --- |
| 地址 | `https://fire0king.github.io/` | `https://myqian-bao.top/` |
| 构建 | `deploy.yml`（Actions） | `publish-site.yml` 发布产物，服务器的 `site-pull.timer` 再来拉取（见 5.5） |
| 数据 | 同一份仓库 JSON，两边都会跟着重建 | 同左 |

想只用一边也行：把对应的工作流删掉/停用即可。
