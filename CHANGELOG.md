# 更新记录（Changelog）

用户指南见 [README](README.md)；实现细节见 [docs/REFERENCE.md](docs/REFERENCE.md)。

## 0.3.3 (2026-09-02)

- **文件面板按类型渲染**：不再一视同仁地按纯文本/Markdown 展示，改为按扩展名选择策略——
  - 代码 / 配置（ts/js/py/go/rs/java/c/cpp/c#/swift/sh/yaml/toml/html/css 等）：改用 shell 自带的
    `CodeBlock`——shiki 语法高亮、复制按钮、懒加载语法、跟随明暗主题，语言提示与 DSH read 卡片
    同一映射，未知语言回落纯等宽（缺 primitives 包时同样回落）；
  - Markdown（.md/.markdown/.mdx）：保持现有渲染样式不变；
  - JSON：格式化后按 json 语法高亮（非法 JSON 原样展示）；
  - 纯文本（txt/log/csv/tsv/ini/env/gitignore 等）：保持等宽换行阅读；
  - 图片 / PDF / 视频：保持内联；新增音频内联播放；
  - **Word（.docx）**：新增服务端纯文本提取——`.docx` 按 ZIP 解析中央目录、zlib 解压
    `word/document.xml`、剥离 XML 得到正文（段落转换行，解码实体），零新依赖；源文件 ≤64MB、
    提取文本 ≤2MB，结构异常返回 415 让面板回落下载卡片。旧 `.doc`（OLE 二进制）不支持，仍走
    下载；`.xlsx` / `.pptx` 暂不支持内联预览。
  - **不可预览类型点击直接下载**：压缩包、旧版 Office、未知二进制等点击后不再打开「仅下载」
    面板卡片，而是立即触发浏览器下载（同源 `/auth/file`，沿用服务端 Content-Disposition 文件名）。
  - **修复：含代码围栏的 Markdown 打开即崩溃**——`MarkdownText` 的 `labels` 是必填项（fence
    复制按钮读 `labels.code.copyLabel`），此前未传导致渲染到代码围栏时抛
    `Cannot read properties of undefined (reading 'code')`、整个面板树被卸载（侧栏闪现即消失）。
    现已传入本地化 labels，并为面板体加错误边界：单个面板渲染异常只在该面板内提示，不再拖垮
    整个侧栏与登录浮层。
  - 超长文本 / 代码在 40 万字符处截断并提示；
  - 服务端 `/auth/file` 的 MIME 表补齐文本 / 代码类型（text/plain），修复这些文件「在新标签页
    打开」变成下载的问题。
- 升级后重启 `dsh web` 生效；远程浏览器无需重新登录。

## 0.3.2 (2026-09-02)

- **适配 dsh ≥ 0.1.2-alpha（issue #11）：远程文件侧栏在新版 dsh 上完全失效**。两层原因，均已修复：
  1. 新版把原生打开 RPC 从 `host.openPath`（点号端点，`payload.path`）整个换成了
     `session.openWorkspacePath`（斜杠端点 `/api/session/openWorkspacePath`，参数包在
     `payload.args.request.path`），客户端 fetch 拦截只匹配旧形状，永远拦不到。拦截器现在
     同时匹配两代端点形状（`args` 按方法参数名泛化查找 `path`），同一份 bundle 继续同时
     服务 rc 与 alpha。
  2. 新版 UI 新增客户端门闩：产物文件「打开」入口只在 `ctx.remote.$host.isLoopback` 为真时
     渲染（`canOpenPath = isLoopback && hostCanOpenPath`），远程浏览器根本不渲染按钮，拦截
     无从谈起。插件在远程页面把 connection 事实源翻转为可达（客户端半区的 `trustProxy`：
     门禁层已放行认证请求，服务端角色门禁仍是执行点），入口恢复渲染、点击进侧栏。
- 随附：设置平面在远程浏览器改走与 loopback 相同的 host 持久化路径（受服务端角色门禁约束，
  非 admin 的 settings 写入依旧拒绝）；角色门禁拒绝表补齐 alpha 新名（`session.openWorkspacePath`、
  `settings.openSettingsDocument`、`settings.openAgentPresetDirectory`），非 admin 依旧无法
  触发宿主机桌面打开。
- **升级插件并重启 `dsh web` 后，远程浏览器无需重新登录。**

## 0.3.1 (2026-09-02)

- **适配 dsh ≥ 0.1.2-alpha（issue #10）**：新版 dsh 的 `client-connection` 额外要求绑定请求 Host 的 `dsh-auth-*` 持久化签名 Cookie，远程浏览器拿不到，导致登录成功后所有 `/api` 返回 401（index.html 也可能 401）。插件现在在登录 / MFA / 引导成功时用核心同款算法铸造并下发两枚 Cookie（分别绑定归一化 loopback 与原始公网 Host），并在门禁层自愈补发。**升级插件后重新登录一次即可**；升级前创建的旧会话在下一次请求时自动修复，无需重新登录。
- 浏览器半区 RPC 自适应 alpha 的 `namespace/method` 斜杠端点（404 时回落旧点号形状并按页面缓存），同一份 bundle 同时服务 rc 与 alpha；服务端角色门禁把斜杠方法名归一化后再匹配拒绝表，非管理员限制在两代 dsh 上同样生效。

## 0.3.0 (2026-08-31)

- **允许的目录可在设置页管理**：管理员在 Settings → 登录与账号 → 允许的目录 添加 / 删除，即时生效、无需重启、持久化到 `$DSH_HOME/dsh-remote-files.json`；配置文件提供的根目录转为只读展示，旧配置项 `files.roots` 兼容保留。
- 修复 `host.openPath` 拦截响应缺少 `type: "server-response"` 导致的客户端解析错误。

## 0.2.8 (2026-08-24)

- 界面跟随 DSH 浅色 / 深色主题：全部界面改用官方设计令牌（`--dsw-alias-*`）取色，自动跟随 DSH 外观设置，无需插件自身主题配置（PR #7）。

## 0.2.7 (2026-08-22)

- 角色门禁只对 `client-request` 封包按方法判定，其余 wire 协议消息（`/api/respond` 的 server-request 应答等）一律放行；被拒的 client-request 返回符合 RPC 契约的错误封包（回显 rpcId）。修复非 admin 角色下宿主挂起的流式请求失败、WebSocket 反复重连、工作区 / 会话基线被重置。

## 0.2.6 (2026-08-22)

- 为远程浏览器播种 settings describe mirror：新版 DSH 把所有设置读取改经共享的 `SettingsDescribeMirror`（远程构造为 memory 模式，`view` 恒为 undefined），远程打开「设置 → 模型」报 "加载提供方目录失败"。插件用官方 `settings.describe` RPC 读取设置文档并经官方 `store.set` 注入 view，Models 目录远程正常加载。

## 0.2.5 (2026-08-20)

- 测试：目录大小写不敏感用例适配大小写敏感的 CI 主机。

## 0.2.4 (2026-08-20)

- Windows 下路径 / 根目录比较做大小写折叠（`E:\code` 与 `E:\CODE` 等价）。

## 0.2.3 (2026-08-20)

- 文件面板被拒（`outside-roots`）时，提示中直接列出当前允许的目录（`allowedRoots`）。

## 0.2.2 (2026-08-20)

- 文件面板拦截判定改由 `location.hostname` 决定，修复本机经非 loopback 主机名访问时被误拦截。

## 0.2.1 (2026-08-20)

- 修复浏览器半区 `connection` 依赖的 inject 声明顺序。

## 0.2.0 (2026-08-20)

- **远程文件面板**：DSH 点击文件路径原本在宿主机桌面打开（远程用户不可见），现在远程浏览器改为在右侧边栏面板中显示——Markdown 按界面排版渲染、图片 / PDF / 视频内联、文本等宽预览、目录逐级浏览；支持多面板上下等分分割、面板最大化、侧栏拖拽调宽、Esc 关闭（PR #3）。

## 0.1.9 (2026-08-20)

- 响应 gzip 压缩：认证后的 HTML / CSS / JS / JSON / SVG 等自动压缩（默认仅远程），带 rev 的静态资源加 `Cache-Control: immutable`（PR #1）。
- 移动端输入框 Enter 换行而非发送（PR #2）。

## 0.1.8 (2026-08-18)

- 修复欢迎声明补丁的 inject 读取路径（顶层 `entry.inject`）；移除诊断日志。

## 0.1.7 (2026-08-18)

- 内部诊断版本（定位 0.1.6 修复的失效原因），无用户可见变化。

## 0.1.6 (2026-08-18)

- 远程浏览器不再反复弹出「内测声明」：对已持久化确认的用户，经官方 `settings.describe` / `store.update` 回放确认态。纯远程首次用户维持原行为。
- README 增加登录页 / 设置页截图。

## 0.1.5 (2026-08-17)

- 修复远程浏览器「设置 → 插件」配置卡片空白：DSH 对远程把所有 settings scope 切成 memory 模式（读写在客户端被丢弃），插件启动时解除该限制并触发全量刷新；原始 settings.yaml 文档编辑器仍保持仅限本机。
- 修复 DSH rc.7 启动崩溃（移除 schemastery `.optional()`）。

## 0.1.4 (2026-08-17)

- 无浏览器服务器（headless）：支持用 `bootstrap` 配置节在启动时预置首个管理员（幂等，账号库非空即忽略）。

## 0.1.3 (2026-08-17)

- npm 检索元数据：关键词、包描述补充 MFA 与本地化信息。

## 0.1.2 (2026-08-17)

- **中英双语**：登录页与全部应用内界面提供 zh / en，跟随 DSH 应用语言（Settings → General → Language）实时切换；新增英文 README。
- 远程浏览器语言偏好持久化：语言切换经官方 `settings.mutate` RPC 落盘 `settings.yaml`，修复 DSH 原生机制下远程刷新即丢的问题。

## 0.1.1 (2026-08-17)

首个公开发布：

- 登录门禁（未登录任何路径 → 登录页；`/api` 与 WebSocket 要求会话 Cookie）；
- 账号体系：scrypt 哈希、HMAC-SHA256 签名会话、登录限速、首个管理员 loopback 引导且受保护、adminOnly 默认开启（可选 admin/user/guest 三角色）；
- MFA（TOTP，RFC 6238）：扫码绑定、手动密钥、10 个一次性备用码（仅存哈希）、管理员恢复；
- 工作区目录选择器替换为浏览器内对话框（不弹宿主机原生窗口）；
- trustProxy：认证后归一化 Host/Origin，放行 DSH 钉死在 loopback 的特权方法；
- 反向代理部署指引与 npm 发布流水线。
