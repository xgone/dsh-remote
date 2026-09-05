# dsh-remote

<p align="center">
  <a href="https://www.npmjs.com/package/@xgone/dsh-remote"><img src="https://img.shields.io/npm/v/%40xgone%2Fdsh-remote?logo=npm&label=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@xgone/dsh-remote"><img src="https://img.shields.io/npm/dm/%40xgone%2Fdsh-remote?logo=npm&label=downloads" alt="npm monthly downloads"></a>
  <a href="https://github.com/xgone/dsh-remote/actions/workflows/test.yml"><img src="https://github.com/xgone/dsh-remote/actions/workflows/test.yml/badge.svg?branch=main" alt="CI status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/xgone/dsh-remote?label=license" alt="MIT license"></a>
</p>

<p align="center"><strong>中文</strong> · <a href="README.en.md">English</a></p>

**让 DeepSeek Harness Web UI 可以被安全地远程访问**：在 `dsh web` 前增加登录门禁、MFA/TOTP、角色权限和远程文件预览。外部浏览器登录后即可使用完整功能，同时不在宿主机上弹出原生窗口。

> 适用于已经能在本机运行 `dsh web` 的环境。插件默认只监听本机回环地址；公网访问仍需 HTTPS 反向代理或安全隧道。

## 目录

- [功能概览](#功能概览)
- [界面预览](#界面预览)
- [快速开始](#快速开始)
- [远程访问](#远程访问)
- [配置](#配置)
- [无浏览器服务器](#无浏览器服务器headless)
- [常见问题](#常见问题)
- [文档](#文档)
- [开发与测试](#开发与测试)
- [卸载](#卸载)
- [已知限制](#已知限制)

## 功能概览

- **登录门禁**：未登录访问任何路径都会进入登录页；`/api` 和 WebSocket 全部要求有效会话。密码使用 scrypt 加密存储，登录失败限速，首个管理员仅限本机创建。
- **MFA 两步验证**：兼容 Google Authenticator、1Password、Authy 等标准 TOTP 认证器；支持扫码绑定和 10 个一次性备用码，管理员可以为账号关闭 MFA。
- **会话与权限**：签名会话 Cookie；默认管理员专用，可选启用 `admin` / `user` / `guest` 三级角色。
- **远程文件面板**：在右侧边栏预览代码、Markdown、图片、PDF、视频、音频、文本、目录和 `.docx` 提取文本；不支持预览的文件直接下载。默认只允许 DSH 主目录与工作目录，可在设置中添加目录。
- **远程访问**：适配 nginx、SSH 隧道、Tailscale、Frp、Cloudflare Tunnel 等方式，并完整转发 WebSocket 事件流。
- **浏览器内工作区**：选择或新建工作区使用浏览器内目录对话框，不调用宿主机原生文件窗口。
- **界面与性能**：跟随 DSH 的浅色 / 深色主题和中英文语言；远程响应默认自动 gzip 压缩，静态资源可配合边缘缓存。

## 界面预览

| 登录门禁（未登录访问任何路径） | 设置 → 登录与账号 |
|:---:|:---:|
| ![登录页](docs/login-zh.png) | ![账号管理设置页](docs/settings-zh.png) |

## 快速开始

### 1. 安装

```sh
dsh plugin --profile web add @xgone/dsh-remote
```

### 2. 重启 `dsh web`

补丁不支持热重载，安装或升级后必须重启：

```sh
dsh web
```

### 3. 创建首个管理员

在本机浏览器打开 `http://127.0.0.1:3080`。首次访问会进入引导模式：输入用户名和密码（至少 6 位）创建首个管理员，创建成功后自动登录。

> 服务器没有本地浏览器？见[无浏览器服务器](#无浏览器服务器headless)。

### 4. 绑定 MFA（推荐）

进入 **设置 → 登录与账号 → 双重验证（MFA）→ 启用**，用认证器扫码并输入 6 位动态码。请先保存页面上的 10 个备用码。

### 5. 开放远程访问

确认本机登录和 MFA 工作正常后，按下方[远程访问](#远程访问)配置反向代理或隧道。外部访问必须转发 WebSocket；HTTPS 部署还要设置 `session.secure: true`。

## 远程访问

`dsh web` 默认只监听本机回环地址，请通过反向代理或隧道暴露，不要直接把未加密的服务端口暴露到公网。

下面是 nginx 示例，重点是保留 WebSocket 升级头：

```nginx
server {
  listen 8443 ssl;
  server_name dsh.example.com;
  ssl_certificate     /etc/letsencrypt/live/dsh.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/dsh.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:3080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header Origin $http_origin;
  }
}
```

`ssh -R` 隧道、Tailscale、Frp 和 Cloudflare Tunnel 同样适用。HTTPS 部署请在配置中把 `session.secure` 设为 `true`。

## 配置

编辑 `~/.dsh/profiles/web/cordis.patch.yml` 中 `remote` 行的 `config`。常用配置如下：

```yaml
- id: remote
  config:
    enabled: true          # false = 关闭门禁（被锁在门外时的逃生通道）
    session:
      secure: false        # HTTPS 部署改为 true
    adminOnly: true        # false = 启用 admin/user/guest 多角色
    bootstrap:             # 可选：仅在账号库为空时预置首个管理员
      username: admin
      password: '换成一个强密码'
```

| 配置项 | 默认值 | 作用 |
|---|---:|---|
| `enabled` | `true` | 启用或关闭登录门禁；修改后需重启 `dsh web`。 |
| `session.secure` | `false` | HTTPS 部署时设为 `true`，让会话 Cookie 只通过安全连接发送。 |
| `adminOnly` | `true` | 保持管理员专用；设为 `false` 后启用多账号和角色权限。 |
| `bootstrap` | 未设置 | 无浏览器服务器预置首个管理员；首次登录后应移除明文密码。 |

完整配置项（会话、MFA、限速、gzip、文件面板和允许目录）见 [docs/REFERENCE.md](docs/REFERENCE.md#13-完整配置参考cordispatchyml)。

### 无浏览器服务器（headless）

在 `cordis.patch.yml` 中加入上面的 `bootstrap` 配置节，重启后即可预置首个管理员，效果等同于本机引导。首次登录后请移除明文密码并绑定 MFA。

## 常见问题

| 现象 | 处理 |
|---|---|
| 安装后没有登录页 | 重启 `dsh web`；确认 bundles 列表里有 `@xgone/dsh-remote`。 |
| 创建管理员时报 403 | 首个管理员仅限本机创建：在本机浏览器操作，或通过 `ssh -L` 访问 `127.0.0.1`；无本地浏览器使用 `bootstrap`。 |
| 被锁在门外 | 将 `cordis.patch.yml` 的 `enabled` 设为 `false` 后重启；或删除 `$DSH_HOME/auth/store.json` 重新引导。 |
| 忘记 MFA / 丢手机 | 管理员进入 **设置 → 登录与账号 → 该账号**，禁用 MFA。 |
| 文件面板提示 `outside-roots` | 进入 **设置 → 登录与账号 → 允许的目录** 添加该目录，立即生效，无需重启。 |
| 升级 dsh 后登录成功但 `/api` 全部 401 | 升级本插件（≥ 0.3.1）并**重新登录一次**，见 [CHANGELOG](CHANGELOG.md)。 |
| 升级 dsh 后点文件路径没反应 / 不再进侧边栏 | 升级本插件（≥ 0.3.2）并重启 `dsh web`，见 [CHANGELOG](CHANGELOG.md)。 |
| 升级 dsh 后远程设置页异常 / 反复弹窗 | 先升级本插件；新版 DSH 的远程兼容修复随版本内置，见 [CHANGELOG](CHANGELOG.md)。 |

## 文档

- **更新记录**：[CHANGELOG.md](CHANGELOG.md) —— 每个版本的变更与升级兼容修复。
- **技术参考**：[docs/REFERENCE.md](docs/REFERENCE.md) —— 架构、实现机制、完整配置和端点参考。
- **Cloudflare Tunnel 部署**：[docs/CLOUDFLARE-TUNNEL.md](docs/CLOUDFLARE-TUNNEL.md) —— 免公网 IP、免开端口的隧道部署指南。
- **npm 包**：[@xgone/dsh-remote](https://www.npmjs.com/package/@xgone/dsh-remote)。

## 开发与测试

```sh
pnpm install
pnpm check
pnpm test
```

`pnpm test` 会执行 Node 语法检查和完整测试集。GitHub Actions 会在 Node.js 20、22、24 上运行同一套测试。

## 卸载

```sh
dsh plugin --profile web remove @xgone/dsh-remote
```

重启 `dsh web` 后门禁消失；账号数据默认保留在 `$DSH_HOME/auth/store.json`，彻底清除时再手动删除该文件。

## 已知限制

- 修改配置后必须重启 `dsh web`，Web 表面禁用 HMR。
- 多账号共享同一份工作区与会话数据。DSH 核心是单租户，插件层无法隔离；需要隔离时请为每人运行一个 profile 实例，例如 `dsh --profile alice --port 3081`。

## License

[MIT](LICENSE)
