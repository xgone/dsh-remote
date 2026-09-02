# dsh-remote 技术参考（AI agent / 贡献者向）

> 本文件面向 AI agent 与贡献者，收录完整实现细节、内部机制与完整配置 / 端点参考。
> 普通用户请看 [README](../README.md)；版本历史见 [CHANGELOG](../CHANGELOG.md)。
> 内容与 `lib/` 源码同步维护，改动实现时请同步更新本文件。

## 1. 项目定位与宿主约束

- dsh-remote 是 `dsh web` 之前的**认证层**：全量门禁（HTTP + WebSocket）+ 账号 / 会话 / MFA，
  并打通外网部署（反向代理后远程浏览器可用全部功能，宿主机不弹原生窗口）。
- DSH 宿主的关键事实（决定了许多设计）：
  - `webServer` 路由模型是「精确表 → 前缀表 → fallback」，**没有中间件钩子**；
  - 内置浏览器信任围栏（`dsh-client-connection`）把 `host.pickDirectory`、`settings.*`、
    `credentials.*` 等特权方法硬编码钉死在 loopback（官方注明「直到真正的认证层出现」）；
  - 对远程（非 loopback）浏览器，整个设置面被切成 memory 模式（见 §15）；
  - Web 表面**禁用 HMR**，bundle 补丁不能热重载，改动后必须重启 `dsh web`；
  - DSH 核心是单租户（`$DSH_HOME` 进程级共享），插件层无法做多租户数据隔离（见 §16）。
- 插件形态：**Cordis 双半区包 + bundle 补丁**。安装后 `dsh plugin` 自动把包追加进 profile 的
  `dsh.profile.bundles`（因为 package.json 声明 `dsh.bundle.patch`），随下次 composition 生效。

## 2. 仓库结构

```
dsh-remote/
├── cordis.patch.yml   # bundle 补丁：插入 remote 行；禁用原生目录选择器并替换为 browse 后端
├── lib/
│   ├── index.js       # 宿主半区：门禁、会话、限速、角色、trustProxy、/auth/* 路由、gzip、文件服务
│   ├── store.js       # 账号存储（scrypt 哈希、受保护标记、TOTP 状态、备用码哈希）
│   ├── totp.js        # RFC 6238 TOTP / base32 / otpauth URI / 备用码（零依赖）
│   ├── login-page.js  # 自包含登录页（密码 → 动态码 → 绑定引导，含二维码），zh/en
│   ├── files-store.js # 允许目录的持久化（dsh-remote-files.json，0600 原子写入）
│   └── client.js      # 浏览器半区：重登浮层、设置页「登录与账号」、远程文件侧栏、语言持久化
├── test/              # node --test：gzip / remote-file / role-gate / files-store / browser-auth
└── package.json       # dsh.bundle.patch + dsh.client 声明 + ./client 导出
```

- 宿主半区以 `inject: ["webServer"]` 激活；浏览器半区由客户端模块系统扫描进
  `window.__DSH_BOOT__`，挂到 `settings.section` slot 与覆盖层。
- 浏览器半区**零打包**：手写 `window.__ModuleLoader__.load({id, factory})` 格式（与官方包一致），
  经 `require("react")` / `react-dom/client` 挂载。

## 3. 门禁（lib/index.js）

通过「包装路由注册方法 + 就地包装已注册表项」实现全量门禁：

- 包装 `register` / `registerUpgrade` / `registerFallback` 三个方法，并对
  `webServer.exact / prefixes / upgrades` 与 `fallback` 中**已注册**的每一项逐个包装：
  `Symbol` 标记防止重复包装；`WeakMap` 记录原始处理器，卸载时还原。
- 包装后的 HTTP 处理器流程：
  `/auth/*` 放行 → 无有效会话时页面请求返回登录页、其余 403 → 通过后**先归一化
  Host/Origin 再交给下层**（trustProxy，见 §5）→ 浏览器认证 Cookie 自愈补发（见 §6）。
- WebSocket 升级握手：无 Cookie 直接销毁 socket。
- 角色门禁（`enforceRoles` 开启且会话非 admin 时）：读取 RPC 信封（上限 16 MiB），按
  `method` 查拒绝表，命中返回 403；放行时用可重放请求体（`Readable` + `Proxy`）交给下层；
  admin 会话零开销。
- **角色门禁只作用于 `type: "client-request"` 封包**：`/api/respond` 等应答封包没有 `method`
  字段，不能按方法判定。被拒的 client-request 返回符合 RPC 契约的 `server-response` 错误封包
  （回显 rpcId），浏览器按业务错误处理而不是传输故障（v0.2.7 修复）。
- 方法名归一化：dsh alpha 用 `namespace/method`（斜杠），rc 用点号；服务端先把斜杠归一化为
  点号再匹配拒绝表，两代 dsh 限制一致。

## 4. 会话与口令

- **会话 Cookie**：`v1.<base64url payload>.<HMAC-SHA256 sig>`，payload `{sub, role, iat, exp}`；
  验证时重算签名并常量时间比较，且账号必须仍存在（删除即失效）。
- **MFA 挑战令牌**：`mfa.<payload>.<sig>`，5 分钟有效、一次性（nonce 消费集合防重放）。
- **口令**：scrypt（`node:crypto`，`N=16384,r=8,p=1`），异步验证 + 常量时间比较，绝不落盘明文。
- **限速**：内存表按「IP + username」计数（默认 15 分钟窗口 5 次）；密码步骤与 MFA 步骤用
  不同键（MFA 失败计数不会被成功密码步骤清掉）。
- **首个账号**：`protected: true`，不可删除、不可改角色，仅可重置密码；bootstrap 仅限
  loopback 提交，防止远程抢先注册。

## 5. trustProxy 与 DSH 信任围栏

DSH 围栏校验：`Host`（loopback 或 `trustedHosts`）、`Origin` 与 Host 一致、`sec-fetch-site`
非 cross-site，且特权方法硬编码 loopback。插件在**认证通过后**把请求的 `Host`/`Origin`
归一化为 `127.0.0.1:<端口>`（保留原 scheme）再交给下层——围栏判定为 loopback，特权方法对
外部浏览器放行。未认证请求仍被门禁 403，围栏的 DNS-rebinding 语义在 Cookie 之后不再需要。
默认 `trustProxy: true`；`false` 时可用 dsh 原生 `--trusted-host <域名>` 放行围栏
（此时 browserAuth 只铸造绑定原始公网 Host 的 Cookie，见 §6）。

## 6. dsh ≥ 0.1.2-alpha 适配：dsh-auth-* Cookie 铸造（issue #10）

- 背景：alpha 起 `client-connection` 在围栏之外还要求一个**绑定请求 Host** 的持久化签名
  Cookie（`dsh-auth-<sha256(Host)>`，HMAC-SHA256，密钥在 `$DSH_HOME/.credentials.yaml` 的
  `client-connection/browser-session` 记录），`/api`、流式 WebSocket（`/api/remote.mux`）与
  index.html 都校验。它只能由 dsh 自己的 `?token=<启动令牌>` 流程铸造，远程浏览器两者皆不可得，
  登录后所有 `/api` 401。
- 插件适配（默认开启，`browserAuth.enabled`）：
  - **登录 / MFA / 引导成功时**读取 client-connection 的持久化签名密钥，用核心同款算法铸造
    两枚 Cookie：绑定**归一化 loopback authority**（供 `/api` 与 WebSocket）+ 绑定**原始公网
    Host**（供 index.html / 静态回退）；
  - **自愈补发**：每个经过门禁的请求校验 Cookie 是否在位且有效（含核心自铸的），缺失或失效时
    在当前响应上补发——旧会话、被清理过 Cookie 的会话下一次请求自动修复；
  - **旧版兼容**：读不到凭证记录（或运行时无 `credentials` 服务）时自动关闭，行为与 0.3.0 一致。
- 约束：Cookie 有效窗口不超过 `client-connection` 的 `cookieMaxAgeDays`（默认 30 天），
  插件自动收敛到该上限；部署调低 `cookieMaxAgeDays` 时需同步调低 `browserAuth.cookieTtlSeconds`。
- **浏览器半区 RPC 形状自适应**：alpha 端点改名 `namespace/method` 且信封收窄为单一 `args`
  字段（`settings.describe` → `settings/describe`）。客户端先试新形状、404 回落旧点号形状并按
  页面缓存——同一份 bundle 同时服务 rc 与 alpha。

## 7. 存储格式

### `$DSH_HOME/auth/store.json`（0600，原子写入）

```jsonc
{
  "version": 1,
  "secret": "<base64url 32B>",          // 会话/MFA 令牌签名密钥（空配置时自动生成并持久化）
  "accounts": [{
    "username": "admin",
    "role": "admin",
    "passwordHash": "scrypt$<salt>$<hash>",
    "protected": true,                  // 首个账号：不可删/不可改角色
    "totp": { "secret": "<base32>", "verified": true, "createdAt": 0 },  // 未启用则为空
    "backupCodes": [{ "hash": "<sha256>", "usedAt": 0 }],                // 备用码仅存哈希
    "createdAt": 0, "updatedAt": 0, "lastLoginAt": 0
  }]
}
```

迁移：老存储无 `protected` 字段时，按 `createdAt` 最早的账号自动标记为受保护并落盘。
删除该文件 = 清空账号回到引导模式（逃生通道）。

### `$DSH_HOME/dsh-remote-files.json`（0600，原子写入）

设置页管理的「允许的目录」列表（见 §13 `files` 节）。配置文件提供的根目录（DSH 主目录 +
dsh 进程工作目录、旧配置 `files.roots`）只读并列展示，不受设置页管理。

## 8. TOTP（lib/totp.js，零依赖）

- base32 编解码（RFC 4648）、`otpauth://` URI 构造；
- TOTP = HMAC-SHA1(secret, 8 字节大端计数器) 动态截断取 6 位，30 秒周期；验证支持 ±window
  步长（默认 ±1）；已用 RFC 6238 SHA-1 附录测试向量（T=0..5）验证；
- 备用码：10 个 8 位无歧义字符码，仅存 SHA-256 哈希，每个可用一次。

## 9. 登录页（lib/login-page.js）

由被包装的 fallback 在未认证时直接内联输出，**零外部资源**。阶段机：
`password → (code | offer) → setup`：

- 密码步骤 → 有 MFA 进入动态码步骤（「有效剩余 N 秒」倒计时、6 位自动提交；备用码含字母，
  仍手动确认）；无 MFA 展示「绑定双重验证」引导（可跳过）；
- 绑定步骤：二维码（`/auth/mfa/setup` 返回 SVG data URL）+ 手动密钥 + otpauth + 备用码 +
  验证输入，成功跳转 `next`；
- 表单 `novalidate` + JS 手动校验（避免隐藏必填控件阻塞提交）；
- 服务端渲染时语言取 `$DSH_HOME/settings.yaml` 的 `locale.preference`，未设置回落浏览器
  `Accept-Language`。

## 10. 浏览器半区（lib/client.js）

- **重登浮层**：`/auth/me` 轮询（15s + focus），未认证且启用认证时全屏覆盖登录（支持 MFA
  第二步）。
- **设置 → 登录与账号**（`settings.section` slot，用户图标；CSS 隐藏 shell 默认齿轮）：
  状态、MFA 自服务（开启/关闭）、账号卡片列表（重置密码 / 禁用 MFA / 删除）、允许的目录管理、
  退出登录。所有数据走 `fetch("/auth/*")`（同源 Cookie），不依赖 settings 域（第三方代码无法
  在该域注册）。
- **远程文件侧栏**：拦截远程（非 loopback，按 `location.hostname` 判定）浏览器的原生打开
  RPC（含 `type: "server-response"` 的合规假响应），改为流式加载 `/auth/file` 面板，按文件
  类型选择渲染策略：Markdown 用界面同款渲染器；代码 / JSON / YAML 等用 shell 自带的
  `CodeBlock`（shiki 高亮 + 复制按钮 + 懒加载语法，语言提示与 read 卡片同表，未知语言回落
  纯等宽）；纯文本等宽换行；图片内联；PDF 内嵌；视频 / 音频内联；`.docx` 走服务端纯文本提取
  （见 `/auth/file` 的 `format=text`）；其余类型提供下载兜底卡片。超长文本 / 代码在 40 万字符
  处截断并提示；多面板上下等分、面板最大化 / 关闭、侧栏左缘拖拽调宽、Esc 关闭最上 / 放大面板。
  文件读取做 realpath 校验，符号链接逃逸与 `..` 穿越一律拒绝；范围外路径报 `outside-roots`
  （提示含 `allowedRoots`，指向设置页）。loopback 访问不拦截，保持 DSH 原生行为。
  两代 dsh 的端点形状不同，拦截器同时匹配：rc 为 `/api/host.openPath`（`payload.path`），
  dsh ≥ 0.1.2-alpha 为 `/api/session/openWorkspacePath`（`payload.args.<参数名>.path`，
  按参数名泛化查找）。alpha 还把打开入口的渲染钉在 `ctx.remote.$host.isLoopback` 上
  （`canOpenPath = isLoopback && hostCanOpenPath`），插件因此在远程页面把 `ctx.connection`
  的 `isLoopback` 事实翻转为真——客户端半区的 `trustProxy`：门禁层已放行认证请求，服务端
  角色门禁仍是执行点（`session.openWorkspacePath` 等原生打开方法对非 admin 拒绝）。
- **主题**：全部界面用官方设计令牌 `--dsw-alias-*` 取色，自动跟随 DSH 浅色 / 深色 / 跟随系统。
- **语言**：接入官方 `@deepseek-ai/dsh-client-locale`（`ctx.locale`），注册 zh/en 字典实时切换。

## 11. 目录选择器替换（cordis.patch.yml）

补丁行不能改名（`name mismatch` 会被跳过），因此用「禁用 + 插入」：

```yaml
- id: directory-picker        # 禁用 auto 选择器（loopback 下解析成 native、在宿主弹窗）
  disabled: true
- insert:
    - id: directory-picker-browse      # browse 宿主后端（host.listDirectory / createDirectory）
      name: '@deepseek-ai/dsh-host-directory-picker-browse'
      config: { maxEntries: 1000 }
    - id: directory-picker-browse-ui   # 浏览器端目录对话框（双栏 + 面包屑 + 新建文件夹）
      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'
```

恢复原生选择器：反转 `disabled` 标记并删除 `insert` 块。

## 12. 安全模型（威胁分析）

| 攻击面 | 防护 |
|---|---|
| 未认证访问 `/api` / 静态页 / WebSocket | 门禁 403 / 登录页 / 握手拒绝 |
| 密码爆破 | scrypt + 限速（IP+用户名） |
| 会话伪造 / 篡改 | HMAC 签名 + 过期 + 常量时间比较 + 账号存在性校验 |
| 会话重放（MFA 第二步） | 一次性 nonce + 5 分钟 TTL |
| 远程抢先注册管理员 | bootstrap 仅 loopback |
| 误删唯一管理员 | 受保护账号 + 最后管理员保护 |
| 跨站请求（CSRF） | HttpOnly + SameSite=lax；跨站请求带不上 Cookie，门禁即 403 |
| DNS rebinding | 认证层已接管围栏语义；未认证请求不会到达围栏 |
| 任意文件读取 | realpath 校验 + 允许目录白名单 + 符号链接 / `..` 拒绝 |

## 13. 完整配置参考（cordis.patch.yml）

`~/.dsh/profiles/web/cordis.patch.yml`（覆盖 remote 行的整份 config，缺省键回落默认值）：

```yaml
- id: remote
  config:
    enabled: true            # false = 完全关闭门禁（逃生通道）
    accounts: []             # 种子账号（明文密码启动时转 scrypt；或直接给 scrypt$<salt>$<hash>）
    secret: ''               # 空 = 自动生成并持久化到 store.json
    session:
      cookieName: dsh_session
      ttlSeconds: 604800     # 7 天
      secure: false          # HTTPS 部署建议 true
      sameSite: lax
    enforceRoles: true       # admin/user/guest 方法级权限
    adminOnly: true          # 仅管理员账号（默认）；false 启用多角色与账号管理
    trustProxy: true         # 认证后归一化 Host/Origin（见 §5）
    bootstrap:               # 无浏览器服务器预置首个管理员（账号库为空时生效，幂等）
      username: admin
      password: '...'        # 至少 6 位，违规启动报错
    mfa:
      enabled: true
      issuer: DeepSeek Harness
      window: 1              # ±1 个 30 秒步长
      backupCodes: 10
    rateLimit:
      maxAttempts: 5
      windowMs: 900000       # 15 分钟
    gzip:
      enabled: true          # 响应 gzip 总开关
      remoteOnly: true       # 仅对远程（非 loopback Host）压缩
      minBytes: 1024         # 已知 Content-Length 小于此值不压缩
    files:
      enabled: true          # 远程文件面板（/auth/file）总开关
      maxListing: 500        # 目录索引每页最多条目
      # files.roots: []      # 旧配置：兼容生效但只读展示，新增目录请用设置页（§10）
    browserAuth:
      enabled: true          # dsh-auth-* Cookie 铸造总开关（见 §6）
      cookieTtlSeconds: 0    # 0 = 跟随 session.ttlSeconds；上限 client-connection.cookieMaxAgeDays
```

## 14. HTTP 端点一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/auth/login` | 登录；有 MFA 时返回 `{mfaRequired, mfaToken}`（不签 Cookie） |
| POST | `/auth/mfa/login` | 第二步：`{mfaToken, code}`（动态码或备用码） |
| POST | `/auth/logout` | 清除 Cookie |
| GET | `/auth/me` | `{authEnabled, bootstrap, authenticated, username, role, mfa, adminOnly}` |
| POST | `/auth/bootstrap` | 首个管理员引导（仅 loopback、仅空存储） |
| POST | `/auth/mfa/setup` | 生成密钥 + otpauth + 二维码 + 备用码（pending 状态） |
| POST | `/auth/mfa/verify` | 用动态码确认 pending 设置 |
| POST | `/auth/mfa/disable` | 关闭本账号 MFA（需密码 + 有效动态码/备用码） |
| POST | `/auth/accounts` | 管理员：`{action: list\|upsert\|remove\|disable-mfa, ...}` |
| GET | `/auth/file` | 远程文件面板的流式文件读取（受允许目录白名单约束）；`format=json` 供面板的目录浏览；`format=text` + `.docx` 返回服务端提取的纯文本（ZIP 解析 + zlib 解压 + XML 剥离，≤64MB 源 / 2MB 文本，结构异常返回 415 让面板回落下载卡片） |

## 15. 已处理的 DSH 远程浏览器怪癖（settings memory 模式系列）

DSH 对远程（非 loopback）浏览器把设置相关状态切成 memory 模式（读写在客户端被丢弃），
引发一系列问题，插件全部**只用官方 slots/store/RPC** 修复，不重写 DSH 内部方法、不改
persistence：

| 版本 | 怪癖 | 修复机制 |
|---|---|---|
| v0.1.5 | 所有 settings scope memory 模式 → 远程「设置 → 插件」配置卡片空白 | 启动时解除 scope 限制并触发全量刷新（settings.yaml 文档编辑器保持仅限本机，设计如此） |
| v0.1.6 | `WelcomeNoticeStore` memory 模式不读持久化确认 → 反复弹「内测声明」 | 经 `settings.describe` 读 `ui-onboarding.welcomeNoticeVersion`，有值时经 `store.update` 置 `acknowledged=true`；纯远程首次用户维持原行为 |
| v0.2.6 | 共享 `SettingsDescribeMirror` 远程为 memory（`view` 恒 undefined）→ Models 页报 "settings are unavailable" | `settings.describe` 读设置文档 → `ctx.settingsScope.describe()` 拿 mirror → `store.set` 注入 view |
| v0.1.2 | 语言偏好远程刷新即丢 | 读：启动经 `settings.describe` 取回并应用；写：切换经 `settings.mutate` 落盘 `settings.yaml`。loopback 访问不介入 |

## 16. 多账号边界（租户隔离做不到的事）

- **已实现**：多账号 + 角色（admin/user/guest）、集中管理、MFA、审计字段（创建/更新/最近登录）。
- **插件层做不到**：每用户独立工作区/会话（多租户数据隔离）——DSH 核心单租户（`$DSH_HOME`
  进程级共享），事件流、搜索、任务等全局泄漏无法在插件层隔离。
- **推荐**：每人一个 profile 实例（`dsh --profile alice --port 3081`）天然隔离；共享实例协作
  用角色体系。

## 17. 限制与逃生通道

- Web 表面禁用 HMR：改配置后**必须重启 `dsh web`**；
- 逃生：`cordis.patch.yml` 设 `enabled: false` 重启即恢复原生；删除
  `$DSH_HOME/auth/store.json` 重新引导；
- 恢复原生目录选择器：见 §11（反转 `disabled`）；
- 被锁在门外：见上两条；忘记 MFA：管理员可在设置页为任意账号禁用 MFA（需管理员密码）。

## 18. 开发与测试

- 语法检查：`npm run check`（`node --check lib/index.js`）；
- 测试：`npm test`（node:test：gzip / remote-file / role-gate / files-store / browser-auth）；
  `prepublishOnly` 同样执行，发版走 tag 触发的 CI；
- 浏览器半区无构建步骤（手写 ModuleLoader 模块），改动 `lib/client.js` 后需重启 `dsh web`
  并强刷浏览器验证。
