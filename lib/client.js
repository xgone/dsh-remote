/**
 * dsh-remote — browser half.
 *
 * Loaded by the shell's client module loader (`window.__ModuleLoader__.load`),
 * exactly like the shipped `dsh.client` bundles: one self-contained factory,
 * no imports, dependencies pulled through the provided `require`.
 *
 * Responsibilities:
 *   1. An in-app login overlay when /auth/me reports unauthenticated while
 *      the SPA is up (session expiry mid-use); supports the MFA second step.
 *   2. A Settings > 登录与账号 page: auth status, the current user's
 *      two-factor (TOTP) self-service, and — for admins — account management
 *      (add / remove / reset password / role / MFA recovery).
 *
 * NOTE on rendering: React's automatic runtime signature is
 * `jsx(type, props, key)` — children MUST live inside `props.children`. The
 * `h()` helper below folds variadic children into props for that reason.
 */
window.__ModuleLoader__.load({
	id: "@xgone/dsh-remote",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let react = require("react");
		let jsxRuntime = require("react/jsx-runtime");
		let reactDOMClient = require("react-dom/client");
		const { jsx } = jsxRuntime;

		/** Client-bundle version marker — keep in sync with package.json on
		 *  release; surfaced in the boot console line for remote debugging. */
		const PLUGIN_VERSION = "0.2.8-light";

		/** User icon + markdown renderer from the shell's primitives set (cosmetic / preview; optional). */
		let IconUserOutline16 = null;
		let MarkdownText = null;
		try {
			const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
			IconUserOutline16 = primitives.IconUserOutline16 ?? null;
			MarkdownText = primitives.MarkdownText ?? null;
		} catch (error) {
			// icons/markdown are enhancements — fall back to text-only rendering
		}

		/** jsx(type, props, ...children) — folds children into props.children. */
		function h(type, props, ...children) {
			if (children.length === 0) return jsx(type, props || {});
			if (children.length === 1) return jsx(type, { ...(props || {}), children: children[0] });
			return jsx(type, { ...(props || {}), children });
		}

		// ── tiny i18n (zh / en) ───────────────────────────────────────────────────
		const copy = {
			zh: {
				"settings.title": "登录与账号",
				"status.enabled": "认证已启用",
				"status.disabled": "认证未启用",
				"status.current": "当前登录",
				"status.bootstrap": "尚未创建账号：登录页处于首个管理员引导模式（仅本机可创建）。",
				"status.expired": "登录已过期，请重新登录。",
				"accounts.title": "账号管理（仅管理员）",
				"accounts.add": "添加账号",
				"accounts.username": "用户名",
				"accounts.password": "密码",
				"accounts.role": "角色",
				"accounts.roleAdmin": "admin（全部权限）",
				"accounts.roleUser": "user（禁止配置/凭据类操作）",
				"accounts.roleGuest": "guest（只读）",
				"accounts.addBtn": "添加",
				"accounts.reset": "重置密码",
				"accounts.remove": "删除",
				"accounts.newPassword": "新密码",
				"accounts.save": "保存",
				"accounts.none": "暂无账号",
				"accounts.lastLogin": "最近登录",
				"accounts.message": "已保存",
				"accounts.first": "首个账号",
				"accounts.protectedHint": "首个账号不可删除，仅可重置密码",
				"accounts.adminOnly": "仅允许管理员账号存在（添加账号已禁用）",
				"mfa.title": "双重验证 (MFA)",
				"mfa.enabled": "已启用",
				"mfa.disabled": "未启用",
				"mfa.unavailable": "插件配置已禁用 MFA",
				"mfa.enable": "启用双重验证",
				"mfa.disable": "禁用双重验证",
				"mfa.status": "当前账号的双重验证",
				"mfa.setup.intro": "用认证器 App（如 Google Authenticator、1Password、Authy）添加账号：",
				"mfa.setup.secret": "手动录入密钥",
				"mfa.setup.otpauth": "otpauth 链接",
				"mfa.setup.copy": "复制",
				"mfa.setup.copied": "已复制",
				"mfa.setup.backup": "一次性备用码（每个仅可使用一次，请妥善保存）",
				"mfa.setup.verify": "在认证器中输入当前 6 位验证码以启用：",
				"mfa.setup.verifyBtn": "验证并启用",
				"mfa.code": "验证码（或备用码）",
				"mfa.disable.hint": "禁用需要当前密码和一个有效验证码（或备用码）。",
				"mfa.adminDisable": "禁用 MFA",
				"mfa.adminDisable.confirm": "输入你的管理员密码以移除该账号的双重验证：",
				"mfa.on": "MFA 已开",
				"mfa.off": "MFA 未开",
				"mfa.pending": "设置中",
				"mfa.badCode": "验证码无效",
				"mfa.failed": "操作失败",
				"mfa.ttl": "有效剩余 {n} 秒",
				"login.title": "登录已过期",
				"login.subtitle": "会话已失效，请重新登录以继续。",
				"login.username": "用户名",
				"login.password": "密码",
				"login.button": "登录",
				"login.error": "用户名或密码错误",
				"login.busy": "正在登录…",
				"login.codeTitle": "两步验证",
				"login.codeSubtitle": "请输入认证器中的动态验证码（或一次性备用码）。",
				"login.codePlaceholder": "6 位验证码或备用码",
				"login.codeButton": "验证",
				"logout.label": "退出登录",
				"logout.title": "退出登录",
				"bootstrap.title": "创建首个管理员账号",
				"bootstrap.subtitle": "尚未配置账号。出于安全考虑，首个管理员账号只能在本机（loopback）创建。",
				"bootstrap.button": "创建",
				"bootstrap.short": "密码至少 6 位",
				"unknown": "未知",
				"viewer.openTab": "在新标签页打开",
				"viewer.empty": "空目录",
				"viewer.binary": "该文件类型无法在面板中预览",
				"viewer.download": "下载文件",
				"viewer.maximize": "放大",
				"viewer.restore": "还原",
				"viewer.close": "关闭",
				"viewer.resize": "拖拽调整宽度",
				"viewer.allowedRoots": "允许的根目录",
				"role.admin": "admin",
				"role.user": "user",
				"role.guest": "guest"
			},
			en: {
				"settings.title": "Auth & Accounts",
				"status.enabled": "Authentication enabled",
				"status.disabled": "Authentication disabled",
				"status.current": "Signed in as",
				"status.bootstrap": "No accounts yet: the login page is in first-admin bootstrap mode (loopback only).",
				"status.expired": "Session expired — please sign in again.",
				"accounts.title": "Account management (admin only)",
				"accounts.add": "Add account",
				"accounts.username": "Username",
				"accounts.password": "Password",
				"accounts.role": "Role",
				"accounts.roleAdmin": "admin (full access)",
				"accounts.roleUser": "user (no settings/credentials plane)",
				"accounts.roleGuest": "guest (read-only)",
				"accounts.addBtn": "Add",
				"accounts.reset": "Reset password",
				"accounts.remove": "Remove",
				"accounts.newPassword": "New password",
				"accounts.save": "Save",
				"accounts.none": "No accounts",
				"accounts.lastLogin": "Last login",
				"accounts.message": "Saved",
				"accounts.first": "First account",
				"accounts.protectedHint": "The first account cannot be removed — only its password can be reset.",
				"accounts.adminOnly": "Admin-only mode: account creation is disabled",
				"mfa.title": "Two-factor authentication (MFA)",
				"mfa.enabled": "Enabled",
				"mfa.disabled": "Not enabled",
				"mfa.unavailable": "MFA is disabled in the plugin configuration",
				"mfa.enable": "Enable two-factor",
				"mfa.disable": "Disable two-factor",
				"mfa.status": "Two-factor status for your account",
				"mfa.setup.intro": "Add the account in an authenticator app (Google Authenticator, 1Password, Authy, …):",
				"mfa.setup.secret": "Enter the key manually",
				"mfa.setup.otpauth": "otpauth link",
				"mfa.setup.copy": "Copy",
				"mfa.setup.copied": "Copied",
				"mfa.setup.backup": "One-time backup codes (each usable once — save them somewhere safe)",
				"mfa.setup.verify": "Enter the current 6-digit code from the authenticator to enable:",
				"mfa.setup.verifyBtn": "Verify & enable",
				"mfa.code": "Code (or backup code)",
				"mfa.disable.hint": "Disabling requires your password plus a valid code (or backup code).",
				"mfa.adminDisable": "Disable MFA",
				"mfa.adminDisable.confirm": "Enter your admin password to remove this account's two-factor:",
				"mfa.on": "MFA on",
				"mfa.off": "MFA off",
				"mfa.pending": "pending",
				"mfa.badCode": "Invalid code",
				"mfa.failed": "Operation failed",
				"mfa.ttl": "Valid for {n}s",
				"login.title": "Session expired",
				"login.subtitle": "Your session has expired — please sign in again.",
				"login.username": "Username",
				"login.password": "Password",
				"login.button": "Sign in",
				"login.error": "Invalid username or password",
				"login.busy": "Signing in…",
				"login.codeTitle": "Two-factor",
				"login.codeSubtitle": "Enter the code from your authenticator (or a one-time backup code).",
				"login.codePlaceholder": "6-digit code or backup code",
				"login.codeButton": "Verify",
				"logout.label": "Log out",
				"logout.title": "Log out",
				"bootstrap.title": "Create the first admin account",
				"bootstrap.subtitle": "No account is configured. For safety, the first admin can only be created locally (loopback).",
				"bootstrap.button": "Create",
				"bootstrap.short": "Password must be at least 6 characters",
				"unknown": "unknown",
				"viewer.openTab": "Open in new tab",
				"viewer.empty": "Empty directory",
				"viewer.binary": "This file type cannot be previewed in the panel",
				"viewer.download": "Download file",
				"viewer.maximize": "Maximize",
				"viewer.restore": "Restore",
				"viewer.close": "Close",
				"viewer.resize": "Drag to resize",
				"viewer.allowedRoots": "Allowed roots",
				"role.admin": "admin",
				"role.user": "user",
				"role.guest": "guest"
			}
		};

		// Two layers: when the framework locale service is available (web
		// profile), the dictionaries below are registered with it via
		// ctx.locale.register and t() resolves through ctx.locale.bind — so the
		// UI follows the app-level language preference (settings.yaml
		// locale.preference) and live switches. Standalone compositions fall
		// back to browser-derived detection.
		const NS = "dsh-remote";
		let localeT = null;
		let localeRuntime = null;

		function t(key, params) {
			if (localeT !== null) return localeT(key, params);
			const lang = String(
				(typeof document !== "undefined" && (document.documentElement?.lang || navigator.language)) || "en"
			).toLowerCase();
			const table = copy[lang.startsWith("zh") ? "zh" : "en"] ?? copy.en;
			const template = table[key] ?? copy.en[key] ?? key;
			if (!params) return template;
			return template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match);
		}

		/**
		 * Re-render on locale switches. t() resolves live against the framework
		 * snapshot, but a component only picks a new language up when it
		 * re-renders — uSES over the locale snapshot guarantees that the boot
		 * adoption (host preference replacing the provisional browser locale a
		 * few hundred ms after load) and any later manual switch both land.
		 */
		function useLocale() {
			const subscribe = react.useCallback(
				(onChange) => (localeRuntime ? localeRuntime.subscribe(onChange) : () => {}),
				[]
			);
			react.useSyncExternalStore(subscribe, () => (localeRuntime ? localeRuntime.getSnapshot() : null));
		}

		// ── remote settings scope unpin ─────────────────────────────────────────
		// DSH runs every settings scope in "memory" mode for non-loopback
		// browsers, and the memory-mode enqueue() drops reads AND writes, which
		// blanks every settings-backed row remotely — Settings → Plugins config
		// cards render nothing, and the language preference never persists
		// natively. This plugin IS the authentication layer those deployments
		// use (its gate already passes the settings RPCs through the loopback
		// fence), so unpin the scope queue: memory-mode scopes now perform their
		// describe/mutate calls exactly like host-backed ones. Loopback browsers
		// are untouched — the patch only removes the memory-mode early return.
		// The class is reached through the bundle loader's require (exported by
		// the ui-settings module); a future DSH that renames or removes the
		// class simply leaves the pin in place (status quo ante, still blank).
		let remoteSettingsUnpinned = false;
		function unpinRemoteSettingsScopes() {
			if (remoteSettingsUnpinned) return;
			try {
				const uiSettings = require("@deepseek-ai/dsh-client-ui-settings");
				const Controller = uiSettings && uiSettings.SettingsScopeController;
				if (typeof Controller?.prototype?.enqueue === "function") {
					Controller.prototype.enqueue = function (operation) {
						if (this.disposed) return Promise.resolve();
						const task = this.tail.then(async () => {
							if (this.disposed) return;
							await operation();
						});
						this.tail = task.catch(() => {});
						return task;
					};
					remoteSettingsUnpinned = true;
				}
			} catch (error) {
				// class unreachable (version drift / load order) — leave the pin
			}
		}

		// ── mobile Enter → newline (not send) ─────────────────────────────────────
		// On phones/tablets the on-screen keyboard's return key maps to Enter,
		// so tapping it in the chat composer sends the draft instantly instead
		// of inserting a newline — easy to fire accidentally and hard to undo.
		// On a coarse-pointer (touch) device, turn plain Enter in the composer
		// into a newline: the composer still sends via its send button (and via
		// any modifier+Enter, which a hardware keyboard attached to the same
		// coarse-pointer device can still use). Detected once and cached.
		let mobileEnterInstalled = false;
		function installMobileEnterNewline() {
			if (mobileEnterInstalled) return;
			mobileEnterInstalled = true;
			try {
				const media = window.matchMedia;
				if (typeof media !== "function") return;
				// Coarse pointer = the primary input is touch (phones/tablets).
				// Desktop touchscreens are hybrids (a keyboard is present) where
				// Enter-send stays ergonomic, so additionally require a
				// phone/tablet-sized viewport to keep those on Enter-send.
				const isCoarse = media("(pointer: coarse)").matches;
				const isPhoneOrTablet = media("(max-width: 1024px)").matches;
				if (!isCoarse || !isPhoneOrTablet) return;
				document.addEventListener("keydown", (event) => {
					// Only plain Enter in the chat composer — modifiers (Shift /
					// Ctrl / Meta / Alt) keep their existing meanings, and the
					// composer's own Enter (send / menu-pick) is what we replace.
					if (event.key !== "Enter") return;
					if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
					const target = event.target;
					if (!(target instanceof HTMLTextAreaElement)) return;
					// The chat composer's textarea lives inside [data-composer-card];
					// other textareas (login, settings, user-questions) keep Enter-send.
					if (target.closest("[data-composer-card]") === null) return;
					// Stop the event before it reaches React's delegated listener
					// (which would run onKeyDown → send), but do NOT preventDefault:
					// the textarea's own default action inserts the newline.
					event.stopImmediatePropagation();
				}, true);
			} catch (error) {
				// MatchMedia / listener failure — leave DSH's native behavior.
			}
		}

		// ── remote file display: intercept host.openPath ─────────────────────────
		// DSH's UI opens agent-produced files through the host.openPath RPC,
		// which hands the path to the HOST desktop's default application — the
		// remote user never sees it. For non-loopback browsers, intercept the
		// /api fetch carrying that RPC and instead open the in-app file viewer
		// (SidePanelHost below) backed by /auth/file on the host half: the
		// file displays INSIDE this browser — markdown rendered, images / PDF /
		// video inline, directories as a clickable listing. The RPC itself is
		// answered locally with the same ok envelope the host would have
		// returned, so callers' `.catch(() => {})` paths stay quiet. Loopback
		// browsers keep DSH's native behavior. Patched at the fetch layer (not
		// the runtime client) so every consumer (composer, artifacts, workspace
		// tree) is covered without reaching into module internals.

		/** Same loopback classification DSH's connection plugin uses — computed
		 *  from THIS page's location so the decision never depends on the
		 *  connection service being registered (or on plugin load order). */
		function isLoopbackPage() {
			try {
				const hostname = location.hostname;
				if (hostname === "localhost" || hostname === "[::1]" || hostname === "::1") return true;
				const parts = hostname.split(".");
				return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
			} catch (error) {
				return false;
			}
		}

		/** Tiny pub/sub the fetch patch uses to open panes without React. */
		let viewerSeq = 0;
		const fileViewerStore = {
			state: { panels: [], maximizedId: null },
			listeners: new Set(),
			publish() {
				for (const listener of fileViewerStore.listeners) listener();
			},
			/** Open a path as a pane; an already-shown path keeps its pane. */
			open(path) {
				if (fileViewerStore.state.panels.some((pane) => pane.path === path)) return;
				viewerSeq += 1;
				const pane = { id: viewerSeq, path };
				fileViewerStore.state = {
					panels: [...fileViewerStore.state.panels, pane],
					maximizedId: fileViewerStore.state.maximizedId
				};
				fileViewerStore.publish();
			},
			/** Close one pane; closing the maximized pane also clears maximize. */
			close(id) {
				const { panels, maximizedId } = fileViewerStore.state;
				if (!panels.some((pane) => pane.id === id)) return;
				fileViewerStore.state = {
					panels: panels.filter((pane) => pane.id !== id),
					maximizedId: maximizedId === id ? null : maximizedId
				};
				fileViewerStore.publish();
			},
			/** Toggle one pane between filling the host and the equal split. */
			toggleMaximize(id) {
				fileViewerStore.state = {
					panels: fileViewerStore.state.panels,
					maximizedId: fileViewerStore.state.maximizedId === id ? null : id
				};
				fileViewerStore.publish();
			},
			subscribe(listener) {
				fileViewerStore.listeners.add(listener);
				return () => fileViewerStore.listeners.delete(listener);
			},
			getSnapshot() {
				return fileViewerStore.state;
			}
		};

		let remoteFileOpenInstalled = false;
		function installRemoteFileOpen() {
			if (remoteFileOpenInstalled) return;
			remoteFileOpenInstalled = true;
			const originalFetch = window.fetch;
			if (typeof originalFetch !== "function") return;
			window.fetch = function (input, init) {
				try {
					const url = typeof input === "string" ? input : String(input && input.url !== undefined ? input.url : input);
					if (url.indexOf("/api/host.openPath") === -1) return originalFetch.apply(this, arguments);
					const body = init && init.body;
					if (typeof body !== "string") return originalFetch.apply(this, arguments);
					const envelope = JSON.parse(body);
					const path = envelope && typeof envelope.payload?.path === "string" ? envelope.payload.path : null;
					if (!path) return originalFetch.apply(this, arguments);
					fileViewerStore.open(path);
					return Promise.resolve(new Response(
						JSON.stringify({ rpcId: envelope.rpcId, result: { ok: true, value: { opened: true } } }),
						{ status: 200, headers: { "Content-Type": "application/json" } }
					));
				} catch (error) {
					return originalFetch.apply(this, arguments);
				}
			};
		}

		// ── right side panel host (Claude Desktop style) ─────────────────────────
		// DSH's native layout has a "details" right column, but it is a single
		// session-scoped slot owned by the conversation plugin — no multi-pane
		// splitting. This overlay host (fixed to the viewport's right edge,
		// beside/above the native details column) shows clicked files in one or
		// MORE panes: panes stack vertically (equal split), each with its own
		// maximize / open-in-tab / close controls and its file path on display;
		// the left edge of the host is draggable to resize, and maximizing a
		// pane expands it over its siblings (restore toggles back).

		const TEXT_PREVIEW_EXTS = new Set(["txt", "md", "markdown", "json", "js", "mjs", "cjs", "ts",
			"css", "html", "htm", "xml", "yml", "yaml", "toml", "ini", "cfg", "conf", "sh", "bash",
			"py", "rb", "go", "rs", "java", "c", "h", "cpp", "hpp", "sql", "log", "csv", "env", "gitignore"]);
		const MARKDOWN_EXTS = new Set(["md", "markdown"]);

		/** Load + classify one path through /auth/file (see FileBody below). */
		function useFileContent(path) {
			const [view, setView] = react.useState(null);
			react.useEffect(() => {
				let cancelled = false;
				let objectUrl = null;
				setView({ status: "loading" });
				(async () => {
					try {
						const response = await fetch("/auth/file?path=" + encodeURIComponent(path) + "&format=json", { credentials: "same-origin" });
						if (!response.ok) {
							const message = await response.json().catch(() => null);
							if (!cancelled) setView({
								status: "error",
								error: (message && message.error) || `HTTP ${response.status}`,
								allowedRoots: message && message.allowedRoots,
								hint: message && message.hint
							});
							return;
						}
						const type = String(response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
						const ext = (path.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() ?? "";
						if (type === "application/json") {
							const data = await response.json();
							if (!cancelled) setView(data && data.ok && Array.isArray(data.entries)
								? { status: "directory", data }
								: { status: "text", text: JSON.stringify(data, null, 2) });
							return;
						}
						if (type.startsWith("image/")) {
							objectUrl = URL.createObjectURL(await response.blob());
							if (!cancelled) setView({ status: "image", url: objectUrl });
							return;
						}
						if (type.startsWith("video/") || type === "application/pdf") {
							objectUrl = URL.createObjectURL(await response.blob());
							if (!cancelled) setView({ status: "embed", url: objectUrl, kind: type.startsWith("video/") ? "video" : "pdf" });
							return;
						}
						if (type.startsWith("text/") || TEXT_PREVIEW_EXTS.has(ext)) {
							const text = await response.text();
							if (!cancelled) setView({ status: "text", text, markdown: MARKDOWN_EXTS.has(ext) });
							return;
						}
						if (!cancelled) setView({ status: "binary" });
					} catch (error) {
						if (!cancelled) setView({ status: "error", error: String(error) });
					}
				})();
				return () => {
					cancelled = true;
					if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
				};
			}, [path]);
			return view;
		}

		/** Body renderer shared by every pane. */
		function FileBody({ path, view }) {
			const rawUrl = "/auth/file?path=" + encodeURIComponent(path);
			const fileName = path.replace(/^.*[\\/]/, "");
			if (view === null || view.status === "loading") return h("div", { style: mutedStyle }, "…");
			if (view.status === "error") {
				return h("div", null, [
					h("div", { style: { color: "var(--dsw-alias-state-error-primary, #f85149)" } }, view.error),
					view.hint ? h("div", { style: { ...mutedStyle, marginTop: "8px" } }, view.hint) : null,
					view.allowedRoots && view.allowedRoots.length
						? h("div", { style: { ...mutedStyle, marginTop: "6px" } }, t("viewer.allowedRoots") + ": " + view.allowedRoots.join(" · "))
						: null
				]);
			}
			if (view.status === "image") {
				return h("img", { src: view.url, alt: fileName, style: { maxWidth: "100%", maxHeight: "100%", objectFit: "contain", display: "block", margin: "0 auto", borderRadius: "8px" } });
			}
			if (view.status === "embed") {
				return view.kind === "video"
					? h("video", { src: view.url, controls: true, style: { width: "100%", maxHeight: "100%", display: "block", margin: "0 auto" } })
					: h("iframe", { src: view.url, title: fileName, style: { width: "100%", height: "100%", border: "0", borderRadius: "8px", background: "#fff" } });
			}
			if (view.status === "directory") {
				return h("div", { style: { display: "flex", flexDirection: "column", gap: "2px" } }, [
					view.data.parent !== null
						? h("button", { style: { ...ghostButtonStyle, textAlign: "left", alignSelf: "flex-start" }, onClick: () => fileViewerStore.open(view.data.parent) }, "⬆ ..")
						: null,
					view.data.entries.length === 0
						? h("div", { style: mutedStyle }, t("viewer.empty"))
						: view.data.entries.map((entry) =>
							h("button", {
								key: entry.path, style: {
									textAlign: "left", cursor: "pointer", background: "transparent",
									border: "0", color: "var(--dsw-alias-state-business-primary, #4c8bf5)",
									font: "inherit", padding: "4px 6px", borderRadius: "6px"
								},
								onClick: () => fileViewerStore.open(entry.path),
								onMouseEnter: (event) => { event.currentTarget.style.background = "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06))"; },
								onMouseLeave: (event) => { event.currentTarget.style.background = "transparent"; }
							}, (entry.isDirectory ? "📁 " : "📄 ") + entry.name + (entry.isDirectory ? "/" : "")))
				]);
			}
			if (view.status === "text" && view.markdown && MarkdownText) return jsx(MarkdownText, { text: view.text });
			if (view.status === "text") {
				return h("pre", { style: { margin: "0", whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "var(--dsw-font-mono, monospace)", fontSize: "12.5px" } }, view.text);
			}
			return h("div", { style: { textAlign: "center", padding: "32px 0" } }, [
				h("div", { style: mutedStyle }, t("viewer.binary")),
				h("a", { href: rawUrl, style: { ...ghostButtonStyle, display: "inline-block", marginTop: "10px", textDecoration: "none" } }, t("viewer.download"))
			]);
		}

		/** One file pane: header (name + path + maximize/tab/close) + body.
		 *  `collapsed` — another pane is maximized: keep mounted (content stays
		 *  loaded) but take no space. */
		function FilePane({ pane, maximized, collapsed, onMaximize, onClose }) {
			useLocale();
			const view = useFileContent(pane.path);
			const fileName = pane.path.replace(/^.*[\\/]/, "");
			return h("div", {
				style: {
					flex: collapsed ? "0 0 0" : "1 1 0", minHeight: "0",
					display: "flex", flexDirection: "column",
					borderBottom: collapsed ? "0" : "1px solid var(--dsw-alias-border-l2, #30363d)",
					overflow: "hidden", background: "var(--dsw-alias-bg-base, #0d1117)"
				}
			}, collapsed ? null : [
				h("div", {
					style: {
						display: "flex", alignItems: "center", gap: "6px",
						padding: "8px 10px", flex: "none",
						background: "var(--dsw-alias-bg-layer-3, #161b22)",
						borderBottom: "1px solid var(--dsw-alias-border-l2, #30363d)"
					}
				}, [
					h("div", { style: { flex: 1, minWidth: 0 } }, [
						h("div", {
							style: { fontSize: "13px", fontWeight: 600, color: "var(--dsw-alias-label-primary, #e6edf3)",
								overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
							title: pane.path
						}, fileName),
						h("div", {
							style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #8b949e)",
								overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", direction: "rtl", textAlign: "left" },
							title: pane.path
						}, pane.path)
					]),
					h("button", {
						style: ghostButtonStyle, title: t("viewer.openTab"),
						onClick: () => window.open("/auth/file?path=" + encodeURIComponent(pane.path), "_blank", "noopener")
					}, "↗"),
					h("button", {
						style: { ...ghostButtonStyle, color: maximized ? "var(--dsw-alias-state-business-primary, #4c8bf5)" : "var(--dsw-alias-label-secondary, #8b949e)" },
						title: maximized ? t("viewer.restore") : t("viewer.maximize"),
						onClick: onMaximize
					}, maximized ? "⤡" : "⤢"),
					h("button", {
						style: { ...ghostButtonStyle, color: "var(--dsw-alias-state-error-primary, #f85149)" },
						title: t("viewer.close"), onClick: onClose
					}, "✕")
				]),
				h("div", {
					style: { flex: 1, minHeight: 0, overflow: "auto", padding: "14px",
						color: "var(--dsw-alias-label-primary, #e6edf3)", fontSize: "13px", lineHeight: "1.7" }
				}, h(FileBody, { path: pane.path, view }))
			]);
		}

		/** The host: fixed right column, drag-resizable, vertical pane stack. */
		function SidePanelHost() {
			useLocale();
			const state = react.useSyncExternalStore(
				react.useCallback((onChange) => fileViewerStore.subscribe(onChange), []),
				() => fileViewerStore.getSnapshot()
			);
			const [width, setWidth] = react.useState(460);
			const startResize = react.useCallback((event) => {
				event.preventDefault();
				const startX = event.clientX;
				const startWidth = width;
				const onMove = (e) => {
					const next = Math.min(720, Math.max(300, startWidth + (startX - e.clientX)));
					setWidth(next);
				};
				const onUp = () => {
					window.removeEventListener("pointermove", onMove);
					window.removeEventListener("pointerup", onUp);
				};
				window.addEventListener("pointermove", onMove);
				window.addEventListener("pointerup", onUp);
			}, [width]);
			react.useEffect(() => {
				if (state.panels.length === 0) return undefined;
				const onKey = (event) => {
					if (event.key !== "Escape") return;
					if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
					// Esc closes the maximized pane, else the most recent one.
					const target = state.maximizedId !== null
						? state.maximizedId
						: state.panels[state.panels.length - 1]?.id;
					if (target !== undefined) fileViewerStore.close(target);
				};
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [state]);
			if (state.panels.length === 0) return null;
			return h("div", {
				style: {
					position: "fixed", top: "0", right: "0", bottom: "0",
					width: width + "px", zIndex: "2147482990", pointerEvents: "auto",
					display: "flex", flexDirection: "column",
					background: "var(--dsw-alias-bg-base, #0d1117)",
					borderLeft: "1px solid var(--dsw-alias-border-l2, #30363d)",
					boxShadow: "-8px 0 24px rgba(0,0,0,.25)"
				}
			}, [
				h("div", {
					style: {
						position: "absolute", left: "0", top: "0", bottom: "0", width: "5px",
						cursor: "ew-resize", zIndex: "1",
						background: "transparent", transition: "background .12s"
					},
					onPointerDown: startResize,
					onMouseEnter: (event) => { event.currentTarget.style.background = "var(--dsw-alias-state-business-primary, #4c8bf5)"; },
					onMouseLeave: (event) => { event.currentTarget.style.background = "transparent"; },
					title: t("viewer.resize")
				}),
				...state.panels.map((pane) =>
					h(FilePane, {
						key: pane.id, pane,
						maximized: state.maximizedId === pane.id,
						collapsed: state.maximizedId !== null && state.maximizedId !== pane.id,
						onMaximize: () => fileViewerStore.toggleMaximize(pane.id),
						onClose: () => fileViewerStore.close(pane.id)
					}))
			]);
		}

		// ── transport ─────────────────────────────────────────────────────────────
		async function fetchJson(path, body) {
			let res;
			try {
				res = await fetch(path, {
					method: body === undefined ? "GET" : "POST",
					credentials: "same-origin",
					headers: body === undefined ? undefined : { "Content-Type": "application/json" },
					body: body === undefined ? undefined : JSON.stringify(body)
				});
			} catch (error) {
				return null;
			}
			try {
				return await res.json();
			} catch {
				return { ok: false, status: res.status, error: "bad response" };
			}
		}

		async function copyText(text) {
			try {
				await navigator.clipboard.writeText(text);
				return true;
			} catch (error) {
				return false;
			}
		}

		/**
		 * Call one settings RPC through the standard /api client-request
		 * envelope. Returns the ok result object, or null on any failure —
		 * callers treat the settings plane as best-effort.
		 */
		async function settingsRpc(method, payload) {
			const envelope = await fetchJson(`/api/${method}`, {
				type: "client-request",
				rpcId: `dsh-remote-${Math.random().toString(36).slice(2)}`,
				method,
				payload
			});
			const result = envelope?.result;
			return result?.ok ? result : null;
		}

		// ── shared field styles ────────────────────────────────────────────────────
		/** Seconds left in the current 30s TOTP window, ticking once per second. */
		function useTotpCountdown() {
			const [remaining, setRemaining] = react.useState(() => 30 - (Math.floor(Date.now() / 1000) % 30));
			react.useEffect(() => {
				const timer = setInterval(() => {
					setRemaining(30 - (Math.floor(Date.now() / 1000) % 30));
				}, 1000);
				return () => clearInterval(timer);
			}, []);
			return remaining;
		}

		function TotpTtl({ remaining }) {
			if (remaining === null) return null;
			return h("div", {
				style: {
					marginTop: "6px",
					fontSize: "12px",
					color: remaining <= 5 ? "var(--dsw-alias-state-error-primary, #f85149)" : "var(--dsw-alias-label-tertiary, #8b949e)"
				}
			}, t("mfa.ttl", { n: remaining }));
		}

		const fieldStyle = {
			width: "100%",
			boxSizing: "border-box",
			padding: "8px 10px",
			borderRadius: "8px",
			border: "1px solid var(--dsw-alias-border-l2, #30363d)",
			background: "var(--dsw-alias-bg-layer-2, #0d1117)",
			color: "var(--dsw-alias-label-primary, #e6edf3)",
			fontSize: "13px",
			outline: "none"
		};
		const buttonStyle = {
			padding: "6px 12px",
			borderRadius: "8px",
			border: "0",
			background: "var(--dsw-alias-state-business-primary, #4c8bf5)",
			color: "#fff",
			fontSize: "13px",
			cursor: "pointer"
		};
		const ghostButtonStyle = {
			padding: "5px 10px",
			borderRadius: "8px",
			border: "1px solid var(--dsw-alias-border-l2, #30363d)",
			background: "transparent",
			color: "var(--dsw-alias-label-secondary, #8b949e)",
			fontSize: "12px",
			cursor: "pointer"
		};
		const chipStyle = {
			padding: "1px 7px",
			borderRadius: "5px",
			fontSize: "11px",
			background: "var(--dsw-alias-bg-layer-3, #21262d)",
			color: "var(--dsw-alias-label-secondary, #8b949e)"
		};
		const labelStyle = {
			display: "block",
			fontSize: "12px",
			color: "var(--dsw-alias-label-tertiary, #8b949e)",
			margin: "12px 0 4px"
		};
		const mutedStyle = {
			fontSize: "12px",
			color: "var(--dsw-alias-label-tertiary, #8b949e)"
		};

		// ── in-app login overlay (password + optional MFA step) ───────────────────
		function AuthGate() {
			const [me, setMe] = react.useState(null);
			const check = react.useCallback(() => {
				fetchJson("/auth/me").then((result) => {
					if (result === null) return;
					if (result.authEnabled === false) {
						setMe({ authenticated: true, authEnabled: false });
						return;
					}
					setMe(result);
				});
			}, []);
			react.useEffect(() => {
				check();
				const timer = setInterval(check, 15000);
				const onFocus = () => check();
				window.addEventListener("focus", onFocus);
				return () => {
					clearInterval(timer);
					window.removeEventListener("focus", onFocus);
				};
			}, [check]);
			if (me === null || me.authenticated || me.authEnabled === false) return null;
			return h(LoginOverlay, { me: me, onDone: check });
		}

		function LoginOverlay({ me, onDone }) {
			const bootstrap = me.bootstrap === true;
			const [step, setStep] = react.useState(bootstrap ? "bootstrap" : "password");
			const [username, setUsername] = react.useState("");
			const [password, setPassword] = react.useState("");
			const [code, setCode] = react.useState("");
			const [mfaToken, setMfaToken] = react.useState("");
			const [error, setError] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const remaining = useTotpCountdown();
			const submit = async (event, codeOverride) => {
				event?.preventDefault();
				setBusy(true);
				setError("");
				let result;
				if (step === "password" || step === "bootstrap") {
					result = await fetchJson(bootstrap ? "/auth/bootstrap" : "/auth/login", {
						username: username.trim(),
						password: password
					});
					if (result && result.ok) {
						location.reload();
						return;
					}
					if (result && result.mfaRequired && result.mfaToken) {
						setMfaToken(result.mfaToken);
						setStep("code");
						setBusy(false);
						return;
					}
				} else {
					const codeValue = codeOverride !== undefined ? codeOverride : code;
					result = await fetchJson("/auth/mfa/login", { mfaToken: mfaToken, code: codeValue.trim() });
					if (result && result.ok) {
						location.reload();
						return;
					}
				}
				setBusy(false);
				setError((result && (result.error || result.message)) ||
					(step === "bootstrap" ? t("bootstrap.short") : (step === "code" ? t("mfa.badCode") : t("login.error"))));
			};
			const onCodeInput = (event) => {
				const value = event.target.value;
				setCode(value);
				// Real-time verification: a complete 6-digit TOTP code submits
				// immediately (backup codes contain letters, so they still use
				// the button).
				if (/^\d{6}$/.test(value.trim())) submit(null, value);
			};
			const overlayStyle = {
				position: "fixed",
				inset: "0",
				zIndex: "2147483000",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				background: "var(--dsw-alias-bg-mask-3, rgba(8,10,14,.82))",
				backdropFilter: "blur(6px)",
				pointerEvents: "auto",
				padding: "24px"
			};
			const cardStyle = {
				width: "100%",
				maxWidth: "360px",
				boxSizing: "border-box",
				background: "var(--dsw-specific-menu, #161b22)",
				border: "1px solid var(--dsw-alias-border-l2, #30363d)",
				borderRadius: "12px",
				boxShadow: "var(--dsw-shadow-lv3, 0 12px 32px rgba(0,0,0,.35))",
				padding: "26px 24px"
			};
			const title = step === "bootstrap" ? t("bootstrap.title") : (step === "code" ? t("login.codeTitle") : t("login.title"));
			const subtitle = step === "bootstrap"
				? t("bootstrap.subtitle")
				: (step === "code" ? t("login.codeSubtitle") : t("login.subtitle"));
			return h("div", { style: overlayStyle },
				h("form", { onSubmit: submit, style: cardStyle },
					h("h2", { style: { margin: "0 0 6px", fontSize: "17px", color: "var(--dsw-alias-label-primary, #e6edf3)" } }, title),
					h("p", { style: { margin: "0 0 16px", fontSize: "13px", lineHeight: "1.6", color: "var(--dsw-alias-label-tertiary, #8b949e)" } }, subtitle),
					step === "code"
						? h("div", null, [
							h("label", { style: labelStyle }, t("mfa.code")),
							h("input", {
								style: fieldStyle,
								value: code,
								onChange: onCodeInput,
								inputMode: "numeric",
								autoComplete: "one-time-code",
								autoFocus: true
							}),
							h(TotpTtl, { remaining: remaining })
						])
						: h("div", null, [
							h("label", { style: labelStyle }, t("login.username")),
							h("input", {
								style: fieldStyle,
								value: username,
								onChange: (event) => setUsername(event.target.value),
								autoComplete: "username",
								autoFocus: true
							}),
							h("label", { style: labelStyle }, t("login.password")),
							h("input", {
								style: fieldStyle,
								type: "password",
								value: password,
								onChange: (event) => setPassword(event.target.value),
								autoComplete: "current-password"
							})
						]),
					error
						? h("div", { style: { marginTop: "12px", padding: "8px 10px", borderRadius: "8px", fontSize: "13px", color: "var(--dsw-alias-state-error-primary, #f85149)", background: "rgba(248,81,73,.12)", border: "1px solid rgba(248,81,73,.35)" } }, error)
						: null,
					h("button", {
						type: "submit",
						disabled: busy || (step === "code" ? !code.trim() : (!username.trim() || !password)),
						style: { ...buttonStyle, width: "100%", marginTop: "18px", padding: "9px 12px", opacity: busy || (step === "code" ? !code.trim() : (!username.trim() || !password)) ? 0.6 : 1 }
					}, busy
						? t("login.busy")
						: (step === "bootstrap" ? t("bootstrap.button") : (step === "code" ? t("login.codeButton") : t("login.button"))))
				)
			);
		}

		// ── MFA self-service block ────────────────────────────────────────────────
		function MfaSelfService({ me, onChanged }) {
			const [view, setView] = react.useState({ phase: "idle", setup: null, code: "", password: "", message: "" });
			const remaining = useTotpCountdown();
			const startSetup = async () => {
				// Empty body -> POST (fetchJson uses GET only when body is undefined).
				const result = await fetchJson("/auth/mfa/setup", {});
				if (result && result.ok) {
					setView({ phase: "setup", setup: result, code: "", password: "", message: "" });
				} else {
					setView((v) => ({ ...v, message: (result && result.error) || t("mfa.failed") }));
				}
			};
			const confirmSetup = async (event, codeOverride) => {
				event?.preventDefault();
				const codeValue = codeOverride !== undefined ? codeOverride : view.code;
				const result = await fetchJson("/auth/mfa/verify", { code: codeValue.trim() });
				if (result && result.ok) {
					setView({ phase: "idle", setup: null, code: "", password: "", message: t("accounts.message") });
					onChanged();
				} else {
					setView((v) => ({ ...v, message: (result && result.error) || t("mfa.badCode") }));
				}
			};
			const onSetupCodeInput = (event) => {
				const value = event.target.value;
				setView((v) => ({ ...v, code: value }));
				// Real-time verification once a complete 6-digit code is entered.
				if (/^\d{6}$/.test(value.trim())) confirmSetup(null, value);
			};
			const disable = async (event) => {
				event.preventDefault();
				const result = await fetchJson("/auth/mfa/disable", { password: view.password, code: view.code.trim() });
				if (result && result.ok) {
					setView({ phase: "idle", setup: null, code: "", password: "", message: t("accounts.message") });
					onChanged();
				} else {
					setView((v) => ({ ...v, message: (result && result.error) || t("mfa.failed") }));
				}
			};
			const copied = (event, text) => {
				event.preventDefault();
				copyText(text);
				const button = event.currentTarget;
				const original = button.textContent;
				button.textContent = t("mfa.setup.copied");
				setTimeout(() => { button.textContent = original; }, 1200);
			};

			if (me.mfaAvailable === false) {
				return h("div", null, [
					h("h3", { style: { margin: "0 0 6px", fontSize: "14px", color: "var(--dsw-alias-label-primary, #e6edf3)" } }, t("mfa.title")),
					h("div", { style: mutedStyle }, t("mfa.unavailable"))
				]);
			}
			if (view.phase === "setup" && view.setup) {
				const setup = view.setup;
				return h("div", null, [
					h("h3", { style: { margin: "0 0 6px", fontSize: "14px", color: "var(--dsw-alias-label-primary, #e6edf3)" } }, t("mfa.title")),
					h("div", { style: { fontSize: "13px", lineHeight: "1.7", color: "var(--dsw-alias-label-secondary, #c9d1d9)", marginBottom: "4px" } }, t("mfa.setup.intro")),
					setup.qr
						? h("div", { style: { display: "flex", justifyContent: "center", margin: "10px 0 4px" } },
							h("img", { src: setup.qr, alt: "QR", style: { width: "180px", height: "180px", imageRendering: "pixelated", borderRadius: "8px" } }))
						: null,
					h("label", { style: labelStyle }, t("mfa.setup.secret")),
					h("div", { style: { display: "flex", gap: "6px", alignItems: "center" } }, [
						h("code", { style: { flex: 1, padding: "8px 10px", borderRadius: "8px", background: "var(--dsw-alias-bg-layer-2, #0d1117)", border: "1px solid var(--dsw-alias-border-l2, #30363d)", fontFamily: "var(--dsw-font-mono, monospace)", fontSize: "12px", userSelect: "all" } }, setup.secret),
						h("button", { style: ghostButtonStyle, onClick: (e) => copied(e, setup.secret) }, t("mfa.setup.copy"))
					]),
					h("label", { style: labelStyle }, t("mfa.setup.otpauth")),
					h("div", { style: { display: "flex", gap: "6px", alignItems: "center" } }, [
						h("code", { style: { flex: 1, padding: "8px 10px", borderRadius: "8px", background: "var(--dsw-alias-bg-layer-2, #0d1117)", border: "1px solid var(--dsw-alias-border-l2, #30363d)", fontFamily: "var(--dsw-font-mono, monospace)", fontSize: "11px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, setup.otpauth),
						h("button", { style: ghostButtonStyle, onClick: (e) => copied(e, setup.otpauth) }, t("mfa.setup.copy"))
					]),
					h("div", { style: { ...mutedStyle, marginTop: "12px" } }, t("mfa.setup.backup")),
					h("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "6px" } },
						(setup.backupCodes || []).map((code) =>
							h("code", { key: code, style: { padding: "3px 8px", borderRadius: "6px", background: "var(--dsw-alias-bg-layer-3, #21262d)", fontFamily: "var(--dsw-font-mono, monospace)", fontSize: "12px" } }, code)
						)),
					h("form", { onSubmit: confirmSetup, style: { marginTop: "14px" } }, [
						h("label", { style: labelStyle }, t("mfa.setup.verify")),
						h("div", { style: { display: "flex", gap: "6px", alignItems: "center" } }, [
							h("input", { style: { ...fieldStyle, flex: 1 }, value: view.code, onChange: onSetupCodeInput, inputMode: "numeric", autoComplete: "one-time-code", autoFocus: true }),
							h("button", { type: "submit", disabled: view.code.trim().length < 6, style: buttonStyle }, t("mfa.setup.verifyBtn"))
						]),
						h(TotpTtl, { remaining: remaining }),
						view.message ? h("div", { style: { ...mutedStyle, marginTop: "8px" } }, view.message) : null
					])
				]);
			}
			return h("div", null, [
				h("h3", { style: { margin: "0 0 6px", fontSize: "14px", color: "var(--dsw-alias-label-primary, #e6edf3)" } }, t("mfa.title")),
				h("div", { style: { display: "flex", alignItems: "center", gap: "10px", fontSize: "13px", color: "var(--dsw-alias-label-secondary, #c9d1d9)" } }, [
					t("mfa.status"),
					h("span", { style: { ...chipStyle, background: me.mfa ? "rgba(63,185,80,.15)" : "var(--dsw-alias-bg-layer-3, #21262d)", color: me.mfa ? "#3fb950" : "var(--dsw-alias-label-secondary, #8b949e)" } },
						me.mfa ? t("mfa.enabled") : t("mfa.disabled"))
				]),
				me.mfa
					? h("form", { onSubmit: disable, style: { marginTop: "10px" } }, [
						h("div", { style: mutedStyle }, t("mfa.disable.hint")),
						h("div", { style: { display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "8px" } }, [
							h("input", { style: { ...fieldStyle, width: "160px" }, type: "password", placeholder: t("accounts.password"), value: view.password, onChange: (e) => setView((v) => ({ ...v, password: e.target.value })), autoComplete: "current-password" }),
							h("input", { style: { ...fieldStyle, width: "140px" }, placeholder: t("mfa.code"), value: view.code, onChange: (e) => setView((v) => ({ ...v, code: e.target.value })), inputMode: "numeric" }),
							h("button", { type: "submit", disabled: !view.password || view.code.trim().length < 6, style: { ...ghostButtonStyle, color: "var(--dsw-alias-state-error-primary, #f85149)" } }, t("mfa.disable"))
						]),
						view.message ? h("div", { style: { ...mutedStyle, marginTop: "8px" } }, view.message) : null
					])
					: h("div", { style: { marginTop: "10px" } }, [
						h("button", { style: buttonStyle, onClick: startSetup }, t("mfa.enable")),
						view.message ? h("div", { style: { ...mutedStyle, marginTop: "8px" } }, view.message) : null
					])
			]);
		}

		// ── Settings > 登录与账号 ─────────────────────────────────────────────────
		function AuthSection() {
			useLocale();
			const [view, setView] = react.useState({ status: "loading", me: null, accounts: [], message: "" });
			const [newUser, setNewUser] = react.useState("");
			const [newPassword, setNewPassword] = react.useState("");
			const [newRole, setNewRole] = react.useState("user");
			const [resetFor, setResetFor] = react.useState(null);
			const [resetPassword, setResetPassword] = react.useState("");
			const [mfaResetFor, setMfaResetFor] = react.useState(null);
			const [mfaResetPassword, setMfaResetPassword] = react.useState("");

			const load = react.useCallback(async () => {
				const me = await fetchJson("/auth/me");
				let accounts = [];
				if (me && me.authenticated && me.role === "admin") {
					const result = await fetchJson("/auth/accounts", { action: "list" });
					if (result && result.ok) accounts = result.accounts;
				}
				setView({ status: "ready", me, accounts, message: "" });
			}, []);

			react.useEffect(() => {
				load();
			}, [load]);

			const doAction = async (payload) => {
				const result = await fetchJson("/auth/accounts", payload);
				if (result && result.ok) {
					load();
					setView((v) => ({ ...v, message: t("accounts.message") }));
				} else {
					setView((v) => ({ ...v, message: (result && result.error) || "failed" }));
				}
			};

			const addAccount = (event) => {
				event.preventDefault();
				if (!newUser.trim() || !newPassword) return;
				doAction({ action: "upsert", username: newUser.trim(), password: newPassword, role: newRole });
				setNewUser("");
				setNewPassword("");
				setNewRole("user");
			};

			const resetSubmit = (event, username) => {
				event.preventDefault();
				if (!resetPassword) return;
				doAction({ action: "upsert", username, password: resetPassword });
				setResetFor(null);
				setResetPassword("");
			};

			const mfaResetSubmit = async (event, username) => {
				event.preventDefault();
				if (!mfaResetPassword) return;
				const result = await fetchJson("/auth/accounts", { action: "disable-mfa", username, password: mfaResetPassword });
				setMfaResetFor(null);
				setMfaResetPassword("");
				if (result && result.ok) {
					load();
					setView((v) => ({ ...v, message: t("accounts.message") }));
				} else {
					setView((v) => ({ ...v, message: (result && result.error) || "failed" }));
				}
			};

			if (view.status === "loading") {
				return h("div", { style: { color: "var(--dsw-alias-label-tertiary, #8b949e)", fontSize: "13px", padding: "12px 0" } }, "…");
			}
			const me = view.me || {};
			return h("div", { style: { display: "flex", flexDirection: "column", gap: "18px", maxWidth: "600px" } }, [
				h("div", null, [
					h("div", { style: { display: "flex", alignItems: "center", gap: "6px", marginBottom: "8px" } }, [
						IconUserOutline16 ? jsx(IconUserOutline16, { size: 16 }) : null,
						h("h3", { style: { margin: "0", fontSize: "14px", color: "var(--dsw-alias-label-primary, #e6edf3)" } }, t("settings.title"))
					]),
					h("div", { style: { fontSize: "13px", lineHeight: "1.8", color: "var(--dsw-alias-label-secondary, #c9d1d9)" } }, [
						me.authEnabled === false ? t("status.disabled") : t("status.enabled"),
						me.authenticated
							? h("span", null, " · " + t("status.current") + " " + (me.username || "") + " (" + (me.role || t("unknown")) + ")")
							: null,
						me.bootstrap === true ? h("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #8b949e)", marginTop: "4px" } }, t("status.bootstrap")) : null
					])
				]),
				me.authenticated ? h(MfaSelfService, { me: me, onChanged: load }) : null,
				me.authenticated && me.role === "admin"
					? h("div", null, [
						h("h3", { style: { margin: "0 0 4px", fontSize: "14px", color: "var(--dsw-alias-label-primary, #e6edf3)" } }, t("accounts.title")),
						me.adminOnly
							? h("div", { style: { ...mutedStyle, marginBottom: "6px" } }, t("accounts.adminOnly"))
							: null,
						!me.adminOnly
							? h("form", { onSubmit: addAccount, style: { display: "flex", gap: "8px", alignItems: "flex-end", flexWrap: "wrap", padding: "10px 0" } }, [
								h("div", { style: { flex: "1 1 140px" } }, [
									h("label", { style: labelStyle }, t("accounts.username")),
									h("input", { style: fieldStyle, value: newUser, onChange: (e) => setNewUser(e.target.value), autoComplete: "off" })
								]),
								h("div", { style: { flex: "1 1 140px" } }, [
									h("label", { style: labelStyle }, t("accounts.password")),
									h("input", { style: fieldStyle, type: "password", value: newPassword, onChange: (e) => setNewPassword(e.target.value), autoComplete: "new-password" })
								]),
								h("div", { style: { flex: "1 1 120px" } }, [
									h("label", { style: labelStyle }, t("accounts.role")),
									h("select", { style: fieldStyle, value: newRole, onChange: (e) => setNewRole(e.target.value) }, [
										h("option", { value: "admin" }, t("accounts.roleAdmin")),
										h("option", { value: "user" }, t("accounts.roleUser")),
										h("option", { value: "guest" }, t("accounts.roleGuest"))
									])
								]),
								h("button", { type: "submit", disabled: !newUser.trim() || !newPassword, style: buttonStyle }, t("accounts.addBtn"))
							])
							: null,
						view.accounts.length === 0
							? h("div", { style: { fontSize: "13px", color: "var(--dsw-alias-label-tertiary, #8b949e)", padding: "8px 0" } }, t("accounts.none"))
							: h("div", { style: { display: "flex", flexDirection: "column", gap: "10px", marginTop: "10px" } },
								view.accounts.map((account) =>
									h("div", { key: account.username, style: {
										background: "var(--dsw-alias-bg-layer-3, #161b22)",
										border: "1px solid var(--dsw-alias-border-l2, #30363d)",
										borderRadius: "12px",
										padding: "14px 16px",
										display: "flex",
										flexDirection: "column",
										gap: "10px"
									} }, [
										h("div", { style: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" } }, [
											h("span", { style: {
												width: "30px",
												height: "30px",
												borderRadius: "50%",
												flex: "none",
												background: "rgba(76,139,245,.16)",
												color: "var(--dsw-alias-state-business-primary, #4c8bf5)",
												display: "inline-flex",
												alignItems: "center",
												justifyContent: "center",
												fontSize: "13px",
												fontWeight: 600,
												userSelect: "none"
											} }, (account.username[0] || "?").toUpperCase()),
											h("span", { style: { fontWeight: 600, fontSize: "14px", color: "var(--dsw-alias-label-primary, #e6edf3)" } }, account.username),
											h("span", { style: { ...chipStyle, background: "rgba(76,139,245,.14)", color: "var(--dsw-alias-state-business-primary, #4c8bf5)" } },
												t("role." + account.role) || account.role),
											account.protected
												? h("span", { style: { ...chipStyle, background: "rgba(207,152,47,.14)", color: "#cf9832" } }, t("accounts.first"))
												: null,
											h("span", { style: { flex: 1 } }),
											h("span", {
												style: { ...chipStyle, background: account.mfa ? "rgba(63,185,80,.14)" : "transparent", color: account.mfa ? "#3fb950" : "var(--dsw-alias-label-tertiary, #8b949e)" }
											}, account.mfa ? t("mfa.on") : (account.mfaPending ? t("mfa.pending") : t("mfa.off")))
										]),
										h("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #8b949e)" } },
											t("accounts.lastLogin") + ": " + (account.lastLoginAt ? new Date(account.lastLoginAt).toLocaleString() : "—")),
										h("div", { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } }, [
											account.mfa && mfaResetFor === account.username
												? h("form", { key: "mfa-reset", onSubmit: (e) => mfaResetSubmit(e, account.username), style: { display: "flex", gap: "6px", alignItems: "center" } }, [
													h("input", { style: { ...fieldStyle, width: "190px", padding: "5px 8px" }, type: "password", placeholder: t("mfa.adminDisable.confirm"), value: mfaResetPassword, onChange: (e) => setMfaResetPassword(e.target.value), autoComplete: "current-password" }),
													h("button", { type: "submit", style: buttonStyle }, t("accounts.save"))
												])
												: (account.mfa
													? h("button", { style: ghostButtonStyle, onClick: () => setMfaResetFor(account.username) }, t("mfa.adminDisable"))
													: null),
											resetFor === account.username
												? h("form", { key: "reset", onSubmit: (e) => resetSubmit(e, account.username), style: { display: "flex", gap: "6px", alignItems: "center" } }, [
													h("input", { style: { ...fieldStyle, width: "150px", padding: "5px 8px" }, type: "password", placeholder: t("accounts.newPassword"), value: resetPassword, onChange: (e) => setResetPassword(e.target.value), autoComplete: "new-password" }),
													h("button", { type: "submit", style: buttonStyle }, t("accounts.save"))
												])
												: h("button", { style: ghostButtonStyle, onClick: () => setResetFor(account.username) }, t("accounts.reset")),
											h("span", { style: { flex: 1 } }),
											account.protected
												? h("span", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #8b949e)" } }, t("accounts.protectedHint"))
												: h("button", {
													style: { ...ghostButtonStyle, color: "var(--dsw-alias-state-error-primary, #f85149)" },
													onClick: () => doAction({ action: "remove", username: account.username })
												}, t("accounts.remove"))
										])
									])
								)),
						view.message
							? h("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #8b949e)" } }, view.message)
							: null
					])
					: null,
				me.authenticated
					? h("div", { style: { borderTop: "1px solid var(--dsw-alias-border-l2, #30363d)", paddingTop: "16px" } },
						h("button", {
							type: "button",
							onClick: async () => {
								await fetchJson("/auth/logout", {});
								location.reload();
							},
							style: { ...ghostButtonStyle, color: "var(--dsw-alias-state-error-primary, #f85149)", padding: "7px 14px", display: "inline-flex", alignItems: "center", gap: "6px" },
							title: t("logout.title")
						}, [
							h(LogoutIcon, { size: 16 }),
							t("logout.label")
						]))
					: null
			]);
		}

		// ── logout (rendered inside the Settings > 登录与账号 section) ────────────
		function LogoutIcon({ size = 16 }) {
			return h("svg", {
				width: size,
				height: size,
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: "1.5",
				strokeLinecap: "round",
				strokeLinejoin: "round"
			}, [
				h("path", { d: "M6.5 3.5H3.75a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h2.75" }),
				h("path", { d: "M9.5 5.5L12 8l-2.5 2.5" }),
				h("path", { d: "M11.5 8H6" })
			]);
		}

		// ── plugin entry ──────────────────────────────────────────────────────────
		const name = "remote";
		// "connection" must be declared so the framework orders this plugin's
		// apply AFTER the connection service exists — ctx.get("connection") in
		// apply() is read once with no retry, and the remote-only file-open
		// interception installs inside that branch.
		const inject = ["slots", "locale", "connection", "settingsScope"];

		function apply(ctx) {
			// On coarse-pointer (touch) devices, make plain Enter in the chat
			// composer insert a newline instead of sending — see
			// installMobileEnterNewline. Independent of remote/loopback and of
			// auth state, so it runs for every mobile client.
			installMobileEnterNewline();

			// Register our zh/en dictionaries with the framework locale service
			// and bind a live translator — the app-level language preference
			// (including switches made at runtime) drives every t() call.
			ctx.effect(() => {
				localeRuntime = ctx.locale;
				localeT = ctx.locale.bind(NS);
				const dispose = ctx.locale.register(NS, { zh: copy.zh, en: copy.en });
				return () => {
					dispose();
					localeT = null;
					localeRuntime = null;
				};
			}, "dsh-remote: locale dictionaries");

			// DSH pins the whole settings plane to loopback: non-loopback
			// (remote) browsers run their settings scopes in memory mode, so
			// the language preference neither persists across reloads nor is
			// re-adopted at boot — the UI boots on the browser-derived
			// provisional locale every time. This plugin is the authentication
			// layer for exactly those deployments, and its gate lets
			// authenticated requests through the loopback fence, so take over
			// both directions for remote browsers only (loopback keeps DSH's
			// native host-backed path untouched):
			//   read  — re-apply the persisted preference once at boot
			//   write — mirror every locale switch into settings.yaml
			// File-view interception is decided by THIS page's hostname (not the
			// connection service), so a remote browser always gets the side
			// panel regardless of plugin load order. The boot log makes the
			// loaded plugin version verifiable from the DevTools console.
			if (!isLoopbackPage()) {
				installRemoteFileOpen();
				console.info("[dsh-remote] " + PLUGIN_VERSION + ": remote browser detected — file panel active");
			}
			const connection = ctx.get("connection");
			if (connection !== void 0 && connection.isLoopback === false) {
				let lastPersisted = ctx.locale.getSnapshot().active;
				ctx.effect(() => ctx.locale.subscribe(() => {
					const active = ctx.locale.getSnapshot().active;
					if (active === lastPersisted) return;
					lastPersisted = active;
					settingsRpc("settings.mutate", {
						ns: "locale",
						ops: [{ op: "set", path: ["preference"], value: active }]
					});
				}), "dsh-remote: remote locale persistence");
				// Boot re-adoption: the memory-mode scope never loads the host
				// value, so fetch it ourselves and apply it. Harmless no-op when
				// the active locale already matches.
				settingsRpc("settings.describe", {}).then((result) => {
					const preference = result?.value?.namespaces
						?.find((entry) => entry.ns === "locale")?.value?.preference;
					if ((preference === "zh" || preference === "en") && preference !== ctx.locale.getSnapshot().active) {
						ctx.locale.setLocale(preference);
					}
				});

				// Unpin the settings scope queue (see unpinRemoteSettingsScopes)
				// and then ask the host to re-broadcast settings/document-updated
				// with no namespace: the scopes bound at boot already swallowed
				// their initial load, and that broadcast is the invalidation path
				// every scope subscribes to, so it reloads them all through the
				// now-working queue — making Settings → Plugins (and every other
				// settings-backed page) render live values for remote browsers.
				unpinRemoteSettingsScopes();
				fetchJson("/auth/settings-refresh", {});

				// Welcome notice (内测声明): WelcomeNoticeStore runs in memory mode
				// for remote browsers, so load() never reads the persisted ack and the
				// notice re-pops on every refresh even for users who already
				// acknowledged it. Read the persisted ack through the official
				// settings RPC (which our gate passes) and, when one exists, set the
				// live store's `acknowledged` flag through its official update API
				// (the store is reached via the settings.onboarding slot's inject,
				// returning { hooks: { welcome: store } }). WelcomeNotice then
				// auto-finishes on its own (ui-settings-models:2264) and the
				// coordinator skips the step — no popup, no DSH internals rewritten,
				// no persistence flipped. Left as-is for first-time remote users
				// (no ack yet) per scope decision.
				settingsRpc("settings.describe", {}).then((result) => {
					const ack = result?.value?.namespaces
						?.find((entry) => entry.ns === "ui-onboarding")?.value?.welcomeNoticeVersion;
					if (typeof ack !== "string" || ack.length === 0) return;
					try {
						const onboardingEntry = ctx.slots.entries("settings.onboarding")
							.find((entry) => entry.options?.id === "welcome-notice");
						// ui-slots stores inject as a top-level entry property
						// (SlotCore.register, ui-slots/lib/index.js:115), not under .options.
						const injected = onboardingEntry?.inject?.() ?? onboardingEntry?.options?.inject?.();
						const store = injected?.hooks?.welcome;
						if (store && typeof store.update === "function"
							&& typeof store.getSnapshot === "function"
							&& !store.getSnapshot().acknowledged) {
							store.update((snapshot) => { snapshot.acknowledged = true; });
						}
					} catch (error) {
						// slot/store shape drifted — leave the notice as DSH ships it
					}
				});
				// Settings → Models (provider catalog): the new DSH reads the settings
				// document through one shared "describe mirror" (SettingsDescribeMirror),
				// constructed in memory mode for remote browsers (status "unavailable",
				// view undefined, ensure()/load() short-circuited), so the Models page
				// throws "settings are unavailable in this browser". The wire read is
				// available through our gate, so mirror the locale/welcome pattern:
				// fetch the document through the official settings RPC and fold it into
				// the mirror through the snapshot store's official set API (the mirror
				// is reached through the official ctx.settingsScope.describe() service).
				// No DSH methods rewritten, no persistence flipped; a drifted mirror
				// shape (version drift) degrades to the status quo ante.
				settingsRpc("settings.describe", {}).then((result) => {
					const view = result?.value;
					if (!view?.namespaces) return;
					try {
						const mirror = ctx.settingsScope?.describe?.();
						if (mirror && typeof mirror.store?.set === "function"
							&& typeof mirror.getSnapshot === "function"
							&& mirror.getSnapshot().view === undefined) {
							mirror.store.set({ status: "ready", view, error: null });
						}
					} catch (error) {
						// mirror shape drifted — leave the models page as DSH ships it
					}
				});
			}

			// The settings shell hardcodes a gear icon (navIcon fallback) for any
			// section id it does not special-case; third-party plugins cannot
			// change that mapping. Hide the shell's default icon for THIS nav row
			// so the section shows exactly the user icon from the label below.
			// Selector is structural (first child of the row button carrying our
			// marker span — the shell's icons render as <svg>, not <div>), so it
			// survives the shell's hashed class names.
			const navIconFix = document.createElement("style");
			navIconFix.dataset.plugin = "dsh-remote";
			navIconFix.textContent = "button:has(.dsh-auth-nav) > :first-child { display: none !important; }";
			document.head.appendChild(navIconFix);

			const mount = document.createElement("div");
			mount.id = "dsh-remote-gate";
			Object.assign(mount.style, {
				position: "fixed",
				inset: "0",
				zIndex: "2147483000",
				pointerEvents: "none"
			});
			document.body.appendChild(mount);
			const root = reactDOMClient.createRoot(mount);
			const renderGate = () => root.render(h("div", null, [h(AuthGate, { key: "gate" }), h(SidePanelHost, { key: "viewer" })]));
			renderGate();
			// The gate overlay renders once per mount; re-render it when the
			// active locale changes (boot adoption or a manual switch) so its
			// copy follows the app language like the rest of the UI.
			const unsubscribeLocale = typeof localeRuntime?.subscribe === "function"
				? localeRuntime.subscribe(renderGate)
				: null;
			ctx.effect(() => () => {
				if (typeof unsubscribeLocale === "function") unsubscribeLocale();
				try {
					root.unmount();
				} catch (error) {
					// already unmounted
				}
				if (mount.parentNode) mount.parentNode.removeChild(mount);
				if (navIconFix.parentNode) navIconFix.parentNode.removeChild(navIconFix);
			}, "dsh-remote: gate overlay");

			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "auth",
				order: 990,
				label: () => IconUserOutline16
					? h("span", { className: "dsh-auth-nav", style: { display: "inline-flex", alignItems: "center", gap: "6px" } }, [
						jsx(IconUserOutline16, { size: 16 }),
						t("settings.title")
					])
					: t("settings.title"),
				inject: () => ({})
			}, AuthSection));
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
