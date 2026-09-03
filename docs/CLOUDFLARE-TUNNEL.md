# 通过 Cloudflare Tunnel（cloudflared）穿透访问 dsh-remote

> [English](CLOUDFLARE-TUNNEL.en.md) | 中文
>
> 本文是**部署指南**：用 Cloudflare Tunnel 把 `dsh web` 安全暴露到公网，无需公网 IP、无需
> 开防火墙端口、无需自备 TLS 证书。步骤给出每步命令与**预期输出**，可直接交给 AI agent
> 执行（文末附「部署任务书」，整段复制给 agent 即可）。
>
> 相关文档：[README](../README.md) · [完整配置参考](./REFERENCE.md) · [更新记录](../CHANGELOG.md)

## 原理与架构

```
外部浏览器 ──HTTPS──▶ Cloudflare 边缘 ◀──出站隧道── cloudflared（跑在 dsh 宿主机上）
                        （自动 TLS）                │ 明文 HTTP，仅本机
                                                    ▼
                                        127.0.0.1:3080  dsh web + dsh-remote 门禁
```

- `cloudflared` 从宿主机**主动出站**连接 Cloudflare 边缘，宿主机不开任何入站端口；
- TLS 在 Cloudflare 边缘自动终结（证书自动签发续期），cloudflared 到 dsh 之间是本机明文，
  无暴露面；
- dsh-remote 的登录门禁、MFA、会话照常生效——隧道只解决「怎么进来」，认证仍由插件负责；
- dsh 自身只监听 loopback，恰好匹配隧道的本机回源方式。

## 前置条件

- 一个已托管在 Cloudflare 的域名（免费计划即可；方案 A 快速隧道不需要域名）；
- 宿主机可运行 `dsh web`（默认 `127.0.0.1:3080`），且已安装并配置好 dsh-remote
  （能出现登录页即可，见 [README 快速开始](../README.md#快速开始)）；
- 宿主机能访问外网（cloudflared 需要出站连接）。

> 下文统一用 `dsh.example.com` 指代你要用的公网域名、`3080` 指代 dsh web 端口，替换成你的实际值。

## 方案 A：快速隧道（5 分钟试用）

无需域名、无需登录 Cloudflare，适合先验证链路通不通。**域名随机且重启会变，勿长期使用。**

```sh
# 在 dsh 宿主机上执行（cloudflared 安装见下文 B0）
cloudflared tunnel --url http://127.0.0.1:3080
```

预期输出中出现一行：

```
+--------------------------------------------------------------+
|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
|  https://xxxx-yyyy-zzzz.trycloudflare.com                    |
+--------------------------------------------------------------+
```

浏览器打开该地址 → 应出现 dsh-remote 登录页。验证通过后 `Ctrl+C` 停止，转方案 B/C。

## 方案 B：命名隧道（生产推荐，本地配置文件）

### B0. 安装 cloudflared

```sh
# macOS (brew)
brew install cloudflared

# Debian/Ubuntu（Cloudflare 官方 apt 源）
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install -y cloudflared

# Windows (管理员 PowerShell)
winget install --id Cloudflare.cloudflared
```

验证：`cloudflared --version` 能打印版本号。

### B1. 登录 Cloudflare

```sh
cloudflared tunnel login
```

会输出一个授权 URL 并尝试打开浏览器——在浏览器中登录 Cloudflare、选择你的域名完成授权。
预期：`~/.cloudflared/cert.pem` 生成（Windows 为 `C:\Users\<你>\.cloudflared\cert.pem`）。

> 宿主机没有浏览器？把输出的 URL 复制到任意有浏览器的机器上完成授权即可。

### B2. 创建隧道

```sh
cloudflared tunnel create dsh
```

预期输出：

```
Created tunnel dsh with id 6ff42ae2-765d-4adf-8684-xxxxxxxxxxxx
```

记下这个 **Tunnel UUID**，并确认 `~/.cloudflared/6ff42ae2-….json` 凭据文件已生成。

### B3. 写配置文件

创建 `~/.cloudflared/config.yml`（Windows 为 `C:\Users\<你>\.cloudflared\config.yml`）：

```yaml
tunnel: 6ff42ae2-765d-4adf-8684-xxxxxxxxxxxx          # 替换为 B2 输出的 UUID
credentials-file: /home/USER/.cloudflared/6ff42ae2-765d-4adf-8684-xxxxxxxxxxxx.json  # 替换为实际路径

ingress:
  - hostname: dsh.example.com                          # 替换为你的公网域名
    service: http://127.0.0.1:3080                     # dsh web 本机地址（按实际端口改）
    originRequest:
      # 可选：把发往 dsh 的 Host 头改回公网域名（默认会被改写为 127.0.0.1:3080）。
      # 不设置也能正常工作；设置后插件的「远程」判定与日志更准确，详见下文「可选调优」。
      httpHostHeader: dsh.example.com
  - service: http_status:404                           # 必须保留的兜底规则
```

### B4. 绑定域名（自动创建 CNAME）

```sh
cloudflared tunnel route dns dsh dsh.example.com
```

预期：Cloudflare DNS 里出现一条指向 `<UUID>.cfargotunnel.com` 的 CNAME 记录（ proxied 状态）。

### B5. 启动（前台试跑）

```sh
cloudflared tunnel run dsh
```

预期日志出现 `Registered tunnel connection` 字样（通常 4 条）。此时浏览器打开
`https://dsh.example.com` 应能看到登录页。确认无误后 `Ctrl+C`，进入服务化。

### B6. 安装为系统服务（开机自启）

```sh
# Linux (systemd) / macOS (launchd) / Windows（管理员）
sudo cloudflared service install        # macOS 无需 sudo；Windows 用管理员 PowerShell
```

预期：服务注册成功并立即启动。之后随系统开机自动拉起隧道。
管理命令：`sudo systemctl status cloudflared`（Linux）／`brew services list`（brew 安装场景）／
Windows 服务管理器。

## 方案 C：Dashboard 远程托管隧道（不想管配置文件）

全程在网页上点选，配置保存在 Cloudflare 侧（适合多台连接器统一管理）：

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/) →
   **Zero Trust** → **Networks → Tunnels** → **Create a tunnel**，类型选 **Cloudflared**；
2. 命名（如 `dsh`）→ 保存后页面给出**带 token 的安装命令**，在 dsh 宿主机上原样执行
   （各平台命令页面都会给出），连接器即上线；
3. 在该隧道的 **Public Hostname** 标签页添加路由：
   - Subdomain：`dsh`，Domain：`example.com`（下拉选择）；
   - Service：Type `HTTP`，URL `127.0.0.1:3080`；
   - （可选）Additional application settings → HTTP → HTTP Host Header：`dsh.example.com`；
4. 保存后 DNS 记录自动创建，浏览器访问 `https://dsh.example.com` 验证。

## dsh-remote 侧配置

编辑 `~/.dsh/profiles/web/cordis.patch.yml`，只需一处调整，其余保持默认：

```yaml
- id: remote
  config:
    enabled: true
    session:
      secure: true        # 唯一建议项：公网走 HTTPS，会话 Cookie 加 Secure 标记
```

**其他项为什么不用改：**

- `trustProxy`（默认 `true`）：认证通过后插件会把 Host/Origin 归一化为本机回环，DSH 的
  loopback 信任围栏才会放行特权方法——隧道场景必须保持开启；
- `browserAuth`（默认 `true`）：dsh ≥ 0.1.2-alpha 必需的 `dsh-auth-*` Cookie 铸造，自动生效
  （插件 ≥ 0.3.1；升级后**重新登录一次**）；
- `gzip`（默认开）：无论 cloudflared 是否保留公网 Host，Cloudflare 边缘都会对文本类响应做
  压缩，两端不会冲突；
- 插件已给带哈希的静态资源下发 `Cache-Control: immutable` 与 `CDN-Cache-Control`，与
  Cloudflare 默认缓存策略天然兼容（HTML / API 默认不缓存，登录页不会被缓存）。

改完**重启 `dsh web`** 生效（Web 表面禁用 HMR）。

> **可选调优（`httpHostHeader`）**：cloudflared 默认把发往源站的 `Host` 头改写为回源地址
> （`127.0.0.1:3080`），链路完全可用；若按 B3/C-3 设置 `httpHostHeader` 为公网域名，dsh
> 看到的 Host 更真实——插件的 `gzip.remoteOnly`「远程」判定、`files` 面板拦截判定与访问日志
> 都会更准确，推荐设置。

## 验证清单

按顺序执行，每步都有明确预期（适合 agent 逐条断言）：

```sh
# 1. 隧道在线：应返回 200
cloudflared tunnel info dsh
curl -s -o /dev/null -w '%{http_code}\n' https://dsh.example.com/        # 期望 200（登录页）

# 2. 认证面暴露正确：未登录时 /auth/me 应可见且未认证
curl -s https://dsh.example.com/auth/me
# 期望 {"authEnabled":true,"bootstrap":false,"authenticated":false, ...}

# 3. 门禁拦截：/api 未认证必须 403
curl -s -o /dev/null -w '%{http_code}\n' https://dsh.example.com/api     # 期望 403

# 4. 首个管理员引导仅限本机：公网 bootstrap 应被拒
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://dsh.example.com/auth/bootstrap  # 期望 403
```

浏览器验证（人工一步）：

1. 打开 `https://dsh.example.com` → 登录页出现，且显示 HTTPS 锁标；
2. 登录（密码 + MFA）→ 进入工作台；
3. DevTools → Network → WS：`/api/remote.mux`（或 `events.mux`）状态为 101/持续 connected，
   会话消息实时滚动；
4. 点击一个文件路径 → 右侧文件面板正常渲染（远程文件面板功能）。

## 排错速查

| 现象 | 原因 | 处理 |
|---|---|---|
| 浏览器报 Cloudflare 错误 1033 | cloudflared 没在跑 / 隧道名或 UUID 配错 | `cloudflared tunnel run dsh` 看日志；服务化后查 `systemctl status cloudflared` |
| 530 / 1016 | DNS 记录缺失或未指向隧道 | 重跑 `cloudflared tunnel route dns dsh <域名>`；Dashboard 方式检查 Public Hostname |
| 登录后所有 `/api` 返回 401 | dsh ≥ 0.1.2-alpha 的 `dsh-auth-*` Cookie 要求，插件版本 < 0.3.1 | 升级插件到 ≥ 0.3.1 并**重新登录一次**（旧会话下个请求自动修复），见 [CHANGELOG](../CHANGELOG.md) |
| MFA 动态码总是验证失败 | 宿主机时钟漂移（TOTP 按 30 秒步长计时） | 宿主机校时：`sudo timedatectl set-ntp true`（或对应平台的 NTP 服务） |
| 登录页能开，但登录后立刻弹回 / Cookie 不生效 | `session.secure: true` 但经非 HTTPS 地址访问 | 确认从 `https://` 域名访问；本地回环访问在现代浏览器下兼容 Secure Cookie |
| WebSocket 反复断开重连 | 边缘对长时间空闲连接有回收策略 | 属正常现象，DSH 客户端会自动重连；若频繁出现，升级插件与 dsh 后再观察 |
| 上传大文件失败 | Cloudflare 免费计划单请求上传上限 100 MB | 与本插件无关，避免经公网上传超大文件 |
| 公网域名无法访问（仅 `route dns` 成功） | 域名 DNSSEC/代理状态异常 | 检查该 CNAME 是否为「已代理」（橙色云朵）；隧道域名必须开启代理 |

## 附：给 AI agent 的部署任务书

把下面整段复制给 AI agent（在 dsh 宿主机上有执行权限的），替换尖括号变量即可：

```text
目标：在这台机器上为 dsh web（127.0.0.1:3080）部署 Cloudflare Tunnel，公网域名
<dsh.example.com>，并把 cloudflared 装成开机自启服务。要求逐步执行并校验。

约定：
1. 每一步先给出要执行的命令，运行后核对"预期"再继续；失败就停下报告，不要自行改写目标；
2. 只修改 ~/.cloudflared/ 下的文件与系统服务，不要改动 dsh 与 dsh-remote 的任何配置；
3. 全程不要创建或推送任何 git tag（本仓库 push tag 会自动发布 npm）。

步骤：
1. 检查 dsh web：curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3080/
   预期 200 或 401/403（有登录门禁即正常）。失败则停止。
2. 安装 cloudflared（按平台选择 brew / 官方 apt 源 / winget），cloudflared --version 验证。
3. cloudflared tunnel login；若机器无浏览器，把授权 URL 打印出来等我完成授权，
   然后 ls ~/.cloudflared/cert.pem 确认。
4. cloudflared tunnel create dsh；记录输出的 UUID，确认 ~/.cloudflared/<UUID>.json 存在。
5. 写 ~/.cloudflared/config.yml：
   tunnel: <UUID>
   credentials-file: <绝对路径>/.cloudflared/<UUID>.json
   ingress:
     - hostname: <dsh.example.com>
       service: http://127.0.0.1:3080
       originRequest:
         httpHostHeader: <dsh.example.com>
     - service: http_status:404
6. cloudflared tunnel route dns dsh <dsh.example.com>
7. cloudflared tunnel run dsh 前台试跑，确认日志出现 Registered tunnel connection，
   然后 Ctrl+C。
8. sudo cloudflared service install && systemctl enable --now cloudflared（按平台调整），
   cloudflared tunnel info dsh 确认连接器在线。
9. 验证：
   a. curl -s -o /dev/null -w '%{http_code}' https://<dsh.example.com>/ → 200
   b. curl -s https://<dsh.example.com>/auth/me → authenticated:false 的 JSON
   c. curl -s -o /dev/null -w '%{http_code}' https://<dsh.example.com>/api → 403
   三条都符合才算完成。
10. 提醒我完成人工步骤：在 cordis.patch.yml 把 session.secure 改为 true 并重启 dsh web；
    浏览器登录 + 绑定 MFA。
```

## 安全注意事项

- 登录门禁 + MFA 是**唯一认证层**：请务必绑定 MFA，并把 `session.ttlSeconds` 控制在合理
  范围（默认 7 天）；
- 域名可发现性：Cloudflare 会扫描常见子域，不要认为「域名没人知道就安全」——门禁必须可靠，
  这正是 dsh-remote 存在的意义；
- 想再加一层 SSO／IP 限制，可在 Cloudflare Zero Trust 给该域名套 **Cloudflare Access**
  （浏览器访问前多一次 Cloudflare 登录）——与本插件的登录门禁叠加生效，互不冲突；
- 登录失败限速（IP + 用户名，默认 15 分钟 5 次）在插件内生效，经隧道依然有效；经隧道看到的
  客户端 IP 是 cloudflared 回源地址，限速按连接器维度聚合，如需放宽可调大
  `rateLimit.maxAttempts`；
- 快速隧道（trycloudflare.com）仅供试用，生产请用命名隧道 + 自己的域名。
