# dsh-remote

[![npm version](https://img.shields.io/npm/v/@xgone/dsh-remote.svg)](https://www.npmjs.com/package/@xgone/dsh-remote)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](README.en.md) | **中文**

**让 DeepSeek Harness 可以被安全地远程访问**：在 `dsh web` 前增加账号密码 + MFA（两步验证）
门禁，外网浏览器登录后即可使用完整功能——全程不在宿主机上弹出任何原生窗口。

### 界面预览

| 登录门禁（未登录访问任何路径） | 设置 → 登录与账号 |
|:---:|:---:|
| ![登录页](docs/login-zh.png) | ![账号管理设置页](docs/settings-zh.png) |

## 功能特性

- **远程访问**：经反向代理（nginx / ssh 隧道 / Tailscale / Frp 等）暴露后，外部浏览器登录即用
  全部功能；选择 / 新建工作区是浏览器内的目录对话框，不会在宿主机弹窗；WebSocket 事件流全通。
- **登录门禁**：未登录访问任何路径都是登录页，`/api` 与 WebSocket 全部要求有效会话；密码
  scrypt 加密存储、登录失败限速、首个管理员仅限本机创建。
- **MFA 两步验证（TOTP）**：兼容 Google Authenticator / 1Password / Authy 等标准认证器，扫码
  绑定 + 10 个一次性备用码；忘记动态码时管理员可代为关闭。
- **远程文件面板**：点击文件路径不再在宿主机桌面打开，而是在右侧边栏预览（Markdown / 图片 /
  PDF / 文本 / 目录浏览），默认仅允许 DSH 主目录与工作目录，可在设置页添加允许的目录。
- **多账号（可选）**：默认仅管理员；关闭 `adminOnly` 后支持 admin / user / guest 三级权限。
- **界面跟随 DSH**：浅色 / 深色主题自动跟随，中英双语跟随 DSH 应用语言。
- **远程访问更快**：响应自动 gzip 压缩（默认仅远程），静态资源配合边缘缓存。

## 快速开始

### 1. 安装

```sh
dsh plugin --profile web add @xgone/dsh-remote
```

### 2. 重启 `dsh web`

补丁不支持热重载，必须重启才生效：

```sh
dsh web
```

### 3. 创建首个管理员

在本机浏览器打开 `http://127.0.0.1:3080`，登录页处于引导模式：输入用户名和密码（至少 6 位）
创建首个管理员，创建成功即登录。

> 服务器没有本地浏览器？见下方 [无浏览器服务器](#无浏览器服务器headless)。

### 4. 绑定 MFA（推荐）

进入 **设置 → 登录与账号 → 双重验证 (MFA) → 启用**，用认证器扫码并输入 6 位动态码即可。
**请先保存页面上的 10 个备用码。**

### 5. 远程访问

`dsh web` 只监听本机，请用反向代理暴露（需转发 WebSocket）：

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

`ssh -R` 隧道、Tailscale、Frp 等同样适用。HTTPS 部署请在配置中把 `session.secure` 设为
`true`。

## 配置

编辑 `~/.dsh/profiles/web/cordis.patch.yml` 中 `remote` 行的 config。常用项：

```yaml
- id: remote
  config:
    enabled: true          # false = 关闭门禁（被锁在门外时的逃生通道）
    session:
      secure: false        # HTTPS 部署改为 true
    adminOnly: true        # false = 启用多角色（admin/user/guest）与账号管理
    bootstrap:             # 可选：预置首个管理员（仅账号库为空时生效）
      username: admin
      password: '换成一个强密码'
```

默认值即开箱可用；完整配置项（会话、MFA、限速、gzip、文件面板等）见
[docs/REFERENCE.md](docs/REFERENCE.md#13-完整配置参考cordispatchyml)。

### 无浏览器服务器（headless）

在 `cordis.patch.yml` 中加 `bootstrap` 配置节（见上），重启即预置首个管理员，等价于本机
引导。首次登录后建议移除明文密码并绑定 MFA。

## 常见问题

| 现象 | 处理 |
|---|---|
| 安装后没有登录页 | 重启 `dsh web`；确认 bundles 列表里有 `@xgone/dsh-remote` |
| 创建管理员时报 403 | 首个管理员仅限本机创建：在本机浏览器操作，或 `ssh -L` 后访问 `127.0.0.1`；无本地浏览器用 `bootstrap` 配置 |
| 被锁在门外 | `cordis.patch.yml` 设 `enabled: false` 重启；或删除 `$DSH_HOME/auth/store.json` 重新引导 |
| 忘记 MFA / 丢手机 | 管理员登录后：设置 → 登录与账号 → 该账号 → 禁用 MFA |
| 文件面板提示 `outside-roots` | 设置 → 登录与账号 → 允许的目录，添加该目录（即时生效，无需重启） |
| 升级 dsh 后登录成功但 `/api` 全部 401 | 升级本插件（≥ 0.3.1）并**重新登录一次**，见 [CHANGELOG](CHANGELOG.md) |
| 升级 dsh 后点文件路径没反应 / 不再进侧边栏 | 升级本插件（≥ 0.3.2）并重启 `dsh web`，见 [CHANGELOG](CHANGELOG.md) |
| 升级 dsh 后远程设置页异常 / 反复弹窗 | 先升级本插件——新版 DSH 的远程兼容修复随版本内置，见 [CHANGELOG](CHANGELOG.md) |

## 文档

- **更新记录**：[CHANGELOG.md](CHANGELOG.md) —— 每个版本的变更与「升级 dsh 后」兼容修复；
- **技术细节**：[docs/REFERENCE.md](docs/REFERENCE.md) —— 架构、实现机制、完整配置与端点
  参考（供 AI agent 与贡献者查阅）。

## 卸载

```sh
dsh plugin --profile web remove @xgone/dsh-remote
```

重启 `dsh web` 后门禁消失；账号数据保留在 `$DSH_HOME/auth/store.json`（彻底清除可手动删除）。

## 已知限制

- 改配置后必须重启 `dsh web`（Web 表面禁用 HMR）；
- 多账号共享同一份工作区与会话数据——DSH 核心是单租户，插件层无法隔离；需要隔离请每人一个
  profile 实例（`dsh --profile alice --port 3081`）。
