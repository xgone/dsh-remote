/**
 * dsh-remote — account/password authentication for the DeepSeek Harness
 * web surface.
 *
 * Host half: registers the /auth/* HTTP plane (login, logout, me, bootstrap,
 * accounts) and installs a session-cookie gate over the web server's route
 * table (HTTP + WebSocket upgrades + the SPA fallback). The browser half
 * (`./client.js`) renders the in-app login overlay on session expiry and a
 * Settings > 登录与账号 page for account management.
 *
 * Security posture:
 *  - Passwords are stored as scrypt hashes (N=16384,r=8,p=1) in
 *    $DSH_HOME/auth/store.json (0600). The Settings page never receives or
 *    returns a hash.
 *  - Sessions are HMAC-SHA256-signed cookies (v1.<payload>.<sig>) with an
 *    expiry; the signing secret is a persisted random value unless the
 *    composition pins one.
 *  - The gate covers every registered HTTP route, every WebSocket upgrade,
 *    and the SPA fallback, except the /auth/* plane itself. Unauthenticated
 *    browsers get a self-contained login page (or 403 for non-page
 *    requests); unauthenticated upgrades are rejected.
 *  - Login attempts are rate limited per IP+username.
 *  - First-run bootstrap (creating the first admin) is loopback-only.
 *  - When `enforceRoles` is on, non-admin sessions are method-gated on /api:
 *    `user` is denied the configuration/credentials/agent-preset plane,
 *    `guest` is additionally read-only.
 */
import z from "@deepseek-ai/schemastery";
import { Readable } from "node:stream";
import { randomUUID, timingSafeEqual } from "node:crypto";
import QRCode from "qrcode";
import { AccountStore, defaultStorePath, generateSecret, hashPasswordSync, hmac, verifyPassword } from "./store.js";
import { renderLoginPage } from "./login-page.js";
import { generateBackupCodes, generateTotpSecret, hashBackupCode, otpauthUri, verifyTotp } from "./totp.js";

/** Stable Cordis plugin name. */
const name = "remote";

/** Services required before this plugin activates. */
const inject = ["webServer"];

/** Marker placed on gated handlers so re-application never double-wraps. */
const GATED = Symbol("dsh-remote.gated");

/** wrapped -> original, module-level so hot re-application can unwrap. */
const wrappedOriginals = new WeakMap();

/** Paths owned by this plugin — never gated. */
function isPublicPath(pathname) {
	return pathname === "/auth" || pathname.startsWith("/auth/");
}

/** Wire methods any non-admin session may not call. */
const NON_ADMIN_DENY = new Set([
	"settings.describe",
	"settings.openDocument",
	"settings.update",
	"settings.replace",
	"settings.mutate",
	"credentials.describe",
	"credentials.set",
	"credentials.unset",
	"agentPreset.read",
	"agentPreset.copy",
	"agentPreset.openDocument",
	"agentPreset.remove",
	"host.pickDirectory",
	"host.openPath",
	"llm.discoverModels"
]);

/** Wire methods a guest (read-only) session may not call either. */
const GUEST_DENY = new Set([
	"session.prompt",
	"session.create",
	"session.delete",
	"session.fork",
	"session.rename",
	"session.selectModel",
	"session.updateQueue",
	"session.cancel",
	"workspace.create",
	"workspace.delete",
	"workspace.insertBefore",
	"workspace.archiveSession",
	"command.execute"
]);

const Config = z.object({
	enabled: z.boolean().default(true),
	accounts: z.array(z.object({
		username: z.string().min(1),
		password: z.string().min(1),
		role: z.union([z.const("admin"), z.const("user"), z.const("guest")]).default("user")
	})).default([]),
	secret: z.string().default(""),
	session: z.object({
		cookieName: z.string().default("dsh_session"),
		ttlSeconds: z.natural().min(60).max(60 * 60 * 24 * 30).default(7 * 24 * 60 * 60),
		secure: z.boolean().default(false),
		sameSite: z.union([z.const("lax"), z.const("strict"), z.const("none")]).default("lax")
	}).default({}),
	enforceRoles: z.boolean().default(true),
	// Admin-only mode: accounts are created only at bootstrap or through the
	// composition seed; runtime account creation is refused and every account
	// (seed included) is forced to the admin role. The Settings page hides the
	// add-account form while this is on.
	adminOnly: z.boolean().default(true),
	// Authenticated sessions may present any external Host/Origin: the request
	// is normalized to the loopback authority before the connection plugin's
	// browser-trust fence runs, so remote (reverse-proxied) browsers can use
	// the privileged /api plane (host.pickDirectory, settings.*, ...) that the
	// fence pins to loopback "until a real authentication layer exists" — this
	// plugin IS that layer. Unauthenticated requests never reach /api (our
	// gate), so the DNS-rebinding defense is redundant behind the cookie.
	trustProxy: z.boolean().default(true),
	mfa: z.object({
		enabled: z.boolean().default(true),
		issuer: z.string().default("DeepSeek Harness"),
		window: z.natural().min(0).max(3).default(1),
		backupCodes: z.natural().min(0).max(20).default(10)
	}).default({}),
	rateLimit: z.object({
		maxAttempts: z.natural().min(1).default(5),
		windowMs: z.natural().min(1000).default(15 * 60 * 1000)
	}).default({})
});

// ── small HTTP helpers ────────────────────────────────────────────────────────

function pathnameOf(req) {
	return new URL(req.url ?? "/", "http://dsh.internal").pathname;
}

function json(res, status, body) {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"Content-Length": Buffer.byteLength(text)
	});
	res.end(text);
}

function denyJson(res, status, message, extra) {
	json(res, status, { ok: false, error: message, ...extra });
}

/** Buffer a request body up to `limit` bytes; null when it exceeds the cap. */
async function readBodyBounded(req, limit) {
	const chunks = [];
	let received = 0;
	for await (const chunk of req) {
		received += chunk.length;
		if (received > limit) return null;
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

/** Replay a fully-read request body through the same node:http request shape. */
function replayable(req, body) {
	const stream = Readable.from([body]);
	return new Proxy(req, {
		get(target, prop, receiver) {
			if (prop === Symbol.asyncIterator) return stream[Symbol.asyncIterator].bind(stream);
			const value = Reflect.get(target, prop, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		}
	});
}

function readCookie(req, cookieName) {
	const header = req.headers.cookie;
	if (!header) return null;
	for (const part of header.split(";")) {
		const idx = part.indexOf("=");
		if (idx === -1) continue;
		if (part.slice(0, idx).trim() === cookieName) return part.slice(idx + 1).trim();
	}
	return null;
}

/** Loopback classification for the bootstrap endpoint (mirrors the /api fence). */
function isLoopbackRequest(req) {
	const hostname = String(req.headers.host ?? "").split(":")[0].toLowerCase();
	if (hostname === "localhost" || hostname === "[::1]") return true;
	return hostname.split(".").length === 4 && hostname.split(".")[0] === "127";
}

// ── plugin ────────────────────────────────────────────────────────────────────

function apply(ctx, config) {
	const cfg = config;
	const store = new AccountStore(config.storePath ?? defaultStorePath());
	store.load();

	// Seed accounts from the composition (plaintext passwords are hashed once
	// and persisted; existing store entries are never overwritten). In
	// admin-only mode every seeded account is forced to the admin role.
	for (const seed of cfg.accounts) {
		if (store.find(seed.username)) continue;
		const passwordHash = seed.password.startsWith("scrypt$") ? seed.password : hashPasswordSync(seed.password);
		store.upsert({ username: seed.username, role: cfg.adminOnly ? "admin" : seed.role, passwordHash });
	}
	store.save();

	const secret = cfg.secret && cfg.secret.length >= 32 ? cfg.secret : store.secret;
	const webServer = ctx.webServer;

	// ── session signing ─────────────────────────────────────────────────────────
	const issueSession = (account) => {
		const payload = {
			sub: account.username,
			role: account.role ?? "user",
			iat: Date.now(),
			exp: Date.now() + cfg.session.ttlSeconds * 1000
		};
		const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
		const sig = hmac(secret, `v1.${encoded}`).toString("base64url");
		return `v1.${encoded}.${sig}`;
	};

	const verifySession = (token) => {
		const parts = String(token).split(".");
		if (parts.length !== 3 || parts[0] !== "v1") return null;
		const [, encoded, sigB64] = parts;
		const expected = hmac(secret, `v1.${encoded}`);
		let sig;
		try {
			sig = Buffer.from(sigB64, "base64url");
		} catch {
			return null;
		}
		if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
		let payload;
		try {
			payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
		} catch {
			return null;
		}
		if (typeof payload?.sub !== "string" || typeof payload?.exp !== "number" || payload.exp <= Date.now()) return null;
		const role = payload.role === "admin" || payload.role === "guest" ? payload.role : "user";
		return { username: payload.sub, role };
	};

	const requireAuth = (req) => {
		const token = readCookie(req, cfg.session.cookieName);
		if (!token) return { ok: false };
		const session = verifySession(token);
		if (!session) return { ok: false };
		// A removed account must not keep working through a stale cookie.
		const account = store.find(session.username);
		if (!account) return { ok: false };
		return { ok: true, user: { username: account.username, role: account.role ?? "user" } };
	};

	// ── MFA challenge tokens (second login step) ────────────────────────────────
	// A signed, short-lived, single-use token proving the password step already
	// passed; replay is prevented with an in-memory consumed-nonce set. The
	// token is consumed ONLY on a successful code — a wrong code must be able
	// to retry with the same challenge.
	const consumedMfaNonces = new Set();
	const MFA_TOKEN_TTL_MS = 5 * 60 * 1000;

	const issueMfaToken = (username) => {
		const nonce = randomUUID();
		const payload = { purpose: "mfa", sub: username, nonce, exp: Date.now() + MFA_TOKEN_TTL_MS };
		const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
		const sig = hmac(secret, `mfa.${encoded}`).toString("base64url");
		return `mfa.${encoded}.${sig}`;
	};

	/** Verify a challenge without consuming it (returns the nonce too). */
	const verifyMfaToken = (token) => {
		const parts = String(token).split(".");
		if (parts.length !== 3 || parts[0] !== "mfa") return null;
		const [, encoded, sigB64] = parts;
		const expected = hmac(secret, `mfa.${encoded}`);
		let sig;
		try {
			sig = Buffer.from(sigB64, "base64url");
		} catch {
			return null;
		}
		if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
		let payload;
		try {
			payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
		} catch {
			return null;
		}
		if (payload?.purpose !== "mfa" || typeof payload?.sub !== "string" || typeof payload?.nonce !== "string") return null;
		if (typeof payload?.exp !== "number" || payload.exp <= Date.now()) return null;
		if (consumedMfaNonces.has(payload.nonce)) return null;
		return { username: payload.sub, nonce: payload.nonce };
	};

	/** Mark a challenge consumed (single use) after a successful code. */
	const consumeMfaToken = (nonce) => {
		consumedMfaNonces.add(nonce);
		for (const used of consumedMfaNonces) {
			if (consumedMfaNonces.size <= 256) break;
			consumedMfaNonces.delete(used);
		}
	};

	const setSessionCookie = (res, token) => {
		const c = cfg.session;
		const parts = [`${c.cookieName}=${token}`, "Path=/", "HttpOnly", `Max-Age=${c.ttlSeconds}`, `SameSite=${c.sameSite}`];
		if (c.secure) parts.push("Secure");
		res.setHeader("Set-Cookie", parts.join("; "));
	};

	const clearSessionCookie = (res) => {
		const c = cfg.session;
		const parts = [`${c.cookieName}=`, "Path=/", "HttpOnly", "Max-Age=0", `SameSite=${c.sameSite}`];
		if (c.secure) parts.push("Secure");
		res.setHeader("Set-Cookie", parts.join("; "));
	};

	// ── rate limiting ───────────────────────────────────────────────────────────
	const attempts = new Map();
	const rateKey = (req, username) => `${req.socket.remoteAddress ?? "unknown"}:${username}`;
	const checkRate = (key) => {
		const now = Date.now();
		const entry = attempts.get(key);
		if (entry === undefined || entry.resetAt <= now) return { ok: true };
		if (entry.count >= cfg.rateLimit.maxAttempts) return { ok: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
		return { ok: true };
	};
	const recordFailure = (key) => {
		const now = Date.now();
		const entry = attempts.get(key);
		if (entry === undefined || entry.resetAt <= now) attempts.set(key, { count: 1, resetAt: now + cfg.rateLimit.windowMs });
		else entry.count += 1;
	};
	const clearRate = (key) => attempts.delete(key);

	// ── role gating on /api ─────────────────────────────────────────────────────
	// Returns { allowed, body, replayed }: when `replayed` is true the request
	// body was consumed for method inspection and must be replayed.
	const roleGate = async (req, role) => {
		const pathname = pathnameOf(req);
		if (!pathname.startsWith("/api/")) return { allowed: true, body: null, replayed: false };
		if (pathname === "/api/session.export") return { allowed: role !== "guest", body: null, replayed: false };
		if (req.method !== "POST") return { allowed: true, body: null, replayed: false };
		// The RPC method name always sits in the envelope head; cap the read so
		// an oversized legitimate image prompt still flows for `user` sessions.
		const body = await readBodyBounded(req, 16 * 1024 * 1024);
		if (body === null) return { allowed: role !== "guest", body: null, replayed: false };
		let envelope;
		try {
			envelope = JSON.parse(body.toString("utf8"));
		} catch {
			return { allowed: false, body, replayed: true };
		}
		const method = typeof envelope?.method === "string" ? envelope.method : null;
		if (method === null) return { allowed: false, body, replayed: true };
		if (NON_ADMIN_DENY.has(method)) return { allowed: false, body, replayed: true };
		if (role === "guest" && GUEST_DENY.has(method)) return { allowed: false, body, replayed: true };
		return { allowed: true, body, replayed: true };
	};

	// ── the gate ────────────────────────────────────────────────────────────────
	/**
	* Normalize an authenticated request's Host/Origin to the loopback
	* authority so the connection plugin's browser-trust fence accepts it.
	* Mutates the IncomingMessage headers in place; the bridge copies them into
	* the fetch Request, and the upgrade handlers read them directly.
	*/
	const normalizeForFence = (req) => {
		if (!cfg.trustProxy) return;
		const authority = `127.0.0.1:${webServer.port ?? "3080"}`;
		if (typeof req.headers.host === "string") req.headers.host = authority;
		if (typeof req.headers.origin === "string" && req.headers.origin !== "") {
			let scheme = "http";
			try {
				scheme = new URL(req.headers.origin).protocol.replace(/:$/, "");
			} catch {
				// keep http
			}
			req.headers.origin = `${scheme}://${authority}`;
		}
	};

	const wrapHttp = (handler) => {
		if (typeof handler !== "function" || handler[GATED]) return handler;
		const gated = async (req, res) => {
			if (isPublicPath(pathnameOf(req))) return handler(req, res);
			const verdict = requireAuth(req);
			if (!verdict.ok) {
				denyJson(res, 403, "unauthorized");
				return;
			}
			normalizeForFence(req);
			if (cfg.enforceRoles && verdict.user.role !== "admin") {
				const gate = await roleGate(req, verdict.user.role);
				if (!gate.allowed) {
					denyJson(res, 403, "forbidden for role " + verdict.user.role);
					return;
				}
				if (gate.replayed) return handler(replayable(req, gate.body), res);
			}
			return handler(req, res);
		};
		Object.defineProperty(gated, GATED, { value: true });
		wrappedOriginals.set(gated, handler);
		return gated;
	};

	const wrapUpgrade = (handler) => {
		if (typeof handler !== "function" || handler[GATED]) return handler;
		const gated = (req, socket, head) => {
			if (!requireAuth(req).ok) {
				socket.destroy();
				return;
			}
			normalizeForFence(req);
			return handler(req, socket, head);
		};
		Object.defineProperty(gated, GATED, { value: true });
		wrappedOriginals.set(gated, handler);
		return gated;
	};

	const wrapFallback = (handler) => {
		if (typeof handler !== "function" || handler[GATED]) return handler;
		const gated = async (req, res) => {
			if (!requireAuth(req).ok) {
				if (req.method === "GET" || req.method === "HEAD") {
					const pathname = pathnameOf(req);
					// i18n: render the login page in the browser's preferred
					// language (zh for any zh-* accept-language, en otherwise).
					const lang = /^zh/i.test(req.headers?.["accept-language"] ?? "") ? "zh" : "en";
					res.writeHead(200, {
						"Content-Type": "text/html; charset=utf-8",
						"Cache-Control": "no-store"
					});
					res.end(renderLoginPage({
						bootstrap: !store.hasAccounts,
						next: pathname === "/" ? "/" : pathname,
						lang
					}));
					return;
				}
				denyJson(res, 403, "unauthorized");
				return;
			}
			return handler(req, res);
		};
		Object.defineProperty(gated, GATED, { value: true });
		wrappedOriginals.set(gated, handler);
		return gated;
	};

	const unwrap = (handler) => wrappedOriginals.get(handler) ?? handler;

	// ── routes ──────────────────────────────────────────────────────────────────
	const handleLogin = async (req, res) => {
		if (req.method !== "POST") {
			denyJson(res, 405, "method not allowed");
			return;
		}
		const body = await readBodyBounded(req, 64 * 1024);
		let input = null;
		if (body !== null) {
			try {
				input = JSON.parse(body.toString("utf8"));
			} catch {
				input = null;
			}
		}
		const username = typeof input?.username === "string" ? input.username.trim() : "";
		const password = typeof input?.password === "string" ? input.password : "";
		if (!username || !password) {
			denyJson(res, 400, "username and password are required");
			return;
		}
		const key = rateKey(req, username);
		const rate = checkRate(key);
		if (!rate.ok) {
			denyJson(res, 429, `too many attempts; retry in ${rate.retryAfter}s`, { retryAfter: rate.retryAfter });
			return;
		}
		const account = store.find(username);
		const ok = account !== null && await verifyPassword(password, account.passwordHash);
		if (!ok) {
			recordFailure(key);
			denyJson(res, 401, "invalid credentials");
			return;
		}
		clearRate(key);
		// Second factor: a verified TOTP setup requires the one-time code before
		// any session is issued. No cookie is set at this step.
		if (cfg.mfa.enabled && account.totp?.verified === true) {
			json(res, 200, {
				ok: false,
				mfaRequired: true,
				mfa: true,
				mfaToken: issueMfaToken(account.username),
				user: { username: account.username, role: account.role ?? "user" }
			});
			return;
		}
		store.markLogin(username);
		store.save();
		setSessionCookie(res, issueSession(account));
		json(res, 200, {
			ok: true,
			mfa: false,
			user: { username: account.username, role: account.role ?? "user" }
		});
	};

	/** Second login step: TOTP code or one-time backup code. */
	const handleMfaLogin = async (req, res) => {
		if (req.method !== "POST") {
			denyJson(res, 405, "method not allowed");
			return;
		}
		const body = await readBodyBounded(req, 64 * 1024);
		let input = null;
		if (body !== null) {
			try {
				input = JSON.parse(body.toString("utf8"));
			} catch {
				input = null;
			}
		}
		const mfaToken = typeof input?.mfaToken === "string" ? input.mfaToken : "";
		const code = typeof input?.code === "string" ? input.code.trim() : "";
		if (!mfaToken || !code) {
			denyJson(res, 400, "mfaToken and code are required");
			return;
		}
		const challenge = verifyMfaToken(mfaToken);
		if (challenge === null) {
			denyJson(res, 401, "mfa challenge invalid or expired");
			return;
		}
		const account = store.find(challenge.username);
		if (account === null || account.totp?.verified !== true) {
			denyJson(res, 401, "mfa challenge invalid");
			return;
		}
		const key = rateKey(req, "mfa:" + account.username);
		const rate = checkRate(key);
		if (!rate.ok) {
			denyJson(res, 429, `too many attempts; retry in ${rate.retryAfter}s`, { retryAfter: rate.retryAfter });
			return;
		}
		const codeOk = verifyTotp(account.totp.secret, code, cfg.mfa.window) ||
			store.consumeBackupCode(account.username, code);
		if (!codeOk) {
			recordFailure(key);
			denyJson(res, 401, "invalid code");
			return;
		}
		clearRate(key);
		// Success: only now consume the challenge (single use) so a wrong code
		// can retry with the same mfaToken.
		consumeMfaToken(challenge.nonce);
		store.markLogin(account.username);
		store.save();
		setSessionCookie(res, issueSession(account));
		json(res, 200, { ok: true, user: { username: account.username, role: account.role ?? "user" } });
	};

	/** Begin TOTP setup for the CURRENT session's account (self-service). */
	const handleMfaSetup = async (req, res) => {
		if (req.method !== "POST") {
			denyJson(res, 405, "method not allowed");
			return;
		}
		const verdict = requireAuth(req);
		if (!verdict.ok) {
			denyJson(res, 401, "unauthorized");
			return;
		}
		if (!cfg.mfa.enabled) {
			denyJson(res, 403, "mfa is disabled");
			return;
		}
		const account = store.find(verdict.user.username);
		if (account === null) {
			denyJson(res, 401, "unauthorized");
			return;
		}
		const secret = generateTotpSecret();
		const backupCodes = generateBackupCodes(cfg.mfa.backupCodes);
		store.beginTotpSetup(account.username, secret, backupCodes.map((code) => hashBackupCode(code)));
		store.save();
		const otpauth = otpauthUri({ secret, account: account.username, issuer: cfg.mfa.issuer });
		// Scan-ready QR (SVG data URL) for authenticator apps; null on failure.
		let qr = null;
		try {
			const svg = await QRCode.toString(otpauth, { type: "svg", errorCorrectionLevel: "M", margin: 1 });
			qr = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
		} catch (error) {
			ctx.logger.warn(`dsh-remote: qr generation failed: ${String(error)}`);
		}
		json(res, 200, {
			ok: true,
			secret,
			otpauth,
			qr,
			issuer: cfg.mfa.issuer,
			backupCodes
		});
	};

	/** Confirm a pending TOTP setup with one valid code. */
	const handleMfaVerify = async (req, res) => {
		if (req.method !== "POST") {
			denyJson(res, 405, "method not allowed");
			return;
		}
		const verdict = requireAuth(req);
		if (!verdict.ok) {
			denyJson(res, 401, "unauthorized");
			return;
		}
		const body = await readBodyBounded(req, 64 * 1024);
		let input = null;
		if (body !== null) {
			try {
				input = JSON.parse(body.toString("utf8"));
			} catch {
				input = null;
			}
		}
		const code = typeof input?.code === "string" ? input.code.trim() : "";
		if (!code) {
			denyJson(res, 400, "code is required");
			return;
		}
		const account = store.find(verdict.user.username);
		if (account === null || account.totp === undefined || account.totp.verified) {
			denyJson(res, 400, "no pending mfa setup");
			return;
		}
		if (!verifyTotp(account.totp.secret, code, cfg.mfa.window)) {
			denyJson(res, 400, "invalid code");
			return;
		}
		store.confirmTotp(account.username);
		store.save();
		json(res, 200, { ok: true, mfa: true });
	};

	/** Disable MFA for the CURRENT account: password + (when active) a code. */
	const handleMfaDisable = async (req, res) => {
		if (req.method !== "POST") {
			denyJson(res, 405, "method not allowed");
			return;
		}
		const verdict = requireAuth(req);
		if (!verdict.ok) {
			denyJson(res, 401, "unauthorized");
			return;
		}
		const body = await readBodyBounded(req, 64 * 1024);
		let input = null;
		if (body !== null) {
			try {
				input = JSON.parse(body.toString("utf8"));
			} catch {
				input = null;
			}
		}
		const password = typeof input?.password === "string" ? input.password : "";
		const code = typeof input?.code === "string" ? input.code.trim() : "";
		if (!password) {
			denyJson(res, 400, "password is required to disable mfa");
			return;
		}
		const account = store.find(verdict.user.username);
		if (account === null) {
			denyJson(res, 401, "unauthorized");
			return;
		}
		const passwordOk = await verifyPassword(password, account.passwordHash);
		if (!passwordOk) {
			denyJson(res, 401, "invalid password");
			return;
		}
		// An ACTIVE setup additionally needs a live code (a session alone must
		// never be enough to strip the second factor).
		if (account.totp?.verified === true) {
			const codeOk = verifyTotp(account.totp.secret, code, cfg.mfa.window) ||
				store.consumeBackupCode(account.username, code);
			if (!codeOk) {
				denyJson(res, 401, "a valid mfa code is required to disable mfa");
				return;
			}
		}
		const had = store.disableTotp(account.username);
		store.save();
		json(res, 200, { ok: true, disabled: had });
	};

	const handleLogout = (req, res) => {
		if (req.method !== "POST") {
			denyJson(res, 405, "method not allowed");
			return;
		}
		clearSessionCookie(res);
		json(res, 200, { ok: true });
	};

	const handleMe = (req, res) => {
		if (req.method !== "GET") {
			denyJson(res, 405, "method not allowed");
			return;
		}
		const verdict = requireAuth(req);
		json(res, 200, {
			authEnabled: cfg.enabled,
			bootstrap: cfg.enabled && !store.hasAccounts,
			authenticated: verdict.ok,
			username: verdict.ok ? verdict.user.username : null,
			role: verdict.ok ? verdict.user.role : null,
			mfa: verdict.ok ? store.mfaInfo(verdict.user.username).enabled : null,
			mfaAvailable: cfg.mfa.enabled,
			adminOnly: cfg.adminOnly
		});
	};

	const handleBootstrap = async (req, res) => {
		if (req.method !== "POST") {
			denyJson(res, 405, "method not allowed");
			return;
		}
		if (!cfg.enabled) {
			denyJson(res, 403, "authentication is disabled");
			return;
		}
		if (store.hasAccounts) {
			denyJson(res, 409, "accounts already exist");
			return;
		}
		if (!isLoopbackRequest(req)) {
			denyJson(res, 403, "first-account bootstrap is loopback-only");
			return;
		}
		const body = await readBodyBounded(req, 64 * 1024);
		let input = null;
		if (body !== null) {
			try {
				input = JSON.parse(body.toString("utf8"));
			} catch {
				input = null;
			}
		}
		const username = typeof input?.username === "string" ? input.username.trim() : "";
		const password = typeof input?.password === "string" ? input.password : "";
		if (!username || !password) {
			denyJson(res, 400, "username and password are required");
			return;
		}
		if (password.length < 6) {
			denyJson(res, 400, "password must be at least 6 characters");
			return;
		}
		store.upsert({ username, role: "admin", passwordHash: hashPasswordSync(password) });
		store.save();
		const account = store.find(username);
		setSessionCookie(res, issueSession(account));
		json(res, 200, { ok: true, mfa: false, user: { username, role: "admin" } });
	};

	const handleAccounts = async (req, res) => {
		if (req.method !== "POST") {
			denyJson(res, 405, "method not allowed");
			return;
		}
		const verdict = requireAuth(req);
		if (!verdict.ok) {
			denyJson(res, 401, "unauthorized");
			return;
		}
		if (verdict.user.role !== "admin") {
			denyJson(res, 403, "admin required");
			return;
		}
		const body = await readBodyBounded(req, 128 * 1024);
		let input = null;
		if (body !== null) {
			try {
				input = JSON.parse(body.toString("utf8"));
			} catch {
				input = null;
			}
		}
		const action = typeof input?.action === "string" ? input.action : "";
		if (action === "list") {
			json(res, 200, { ok: true, accounts: store.list() });
			return;
		}
		if (action === "upsert") {
			const username = typeof input?.username === "string" ? input.username.trim() : "";
			// Absent role (a password-only reset) keeps the account's current role.
			const requestedRole = input?.role === "admin" || input?.role === "guest" ? input.role : null;
			const password = typeof input?.password === "string" ? input.password : "";
			if (!username) {
				denyJson(res, 400, "username is required");
				return;
			}
			const existing = store.find(username);
			// Admin-only mode: accounts are created only at bootstrap or via the
			// composition seed — runtime creation is refused, and every account
			// is forced to the admin role.
			if (cfg.adminOnly && existing === null) {
				denyJson(res, 400, "account creation is disabled (admin-only mode)");
				return;
			}
			const role = cfg.adminOnly ? "admin" : (requestedRole ?? existing?.role ?? "user");
			// The first (protected) account is the root: only its password may be
			// reset — explicit role changes are refused.
			if (existing !== null && existing.protected === true && requestedRole !== null && requestedRole !== (existing.role ?? "user")) {
				denyJson(res, 400, "cannot change the role of the first (protected) account");
				return;
			}
			if (existing === null && password.length < 6) {
				denyJson(res, 400, "new accounts need a password of at least 6 characters");
				return;
			}
			const passwordHash = password ? hashPasswordSync(password) : undefined;
			store.upsert({ username, role, passwordHash });
			store.save();
			json(res, 200, { ok: true, account: store.list().find((a) => a.username === username) });
			return;
		}
		if (action === "remove") {
			const username = typeof input?.username === "string" ? input.username : "";
			const target = store.find(username);
			if (target === null) {
				json(res, 200, { ok: true, removed: false });
				return;
			}
			if (target.protected === true) {
				denyJson(res, 400, "cannot remove the first (protected) account; reset its password instead");
				return;
			}
			if ((target.role ?? "user") === "admin" && store.countAdmins() <= 1) {
				denyJson(res, 400, "cannot remove the last admin");
				return;
			}
			const removed = store.remove(username);
			store.save();
			json(res, 200, { ok: true, removed });
			return;
		}
		if (action === "disable-mfa") {
			// Admin recovery path: strip MFA from an account. Re-auths the admin
			// with their own password so a hijacked admin session alone cannot
			// silently remove another user's second factor.
			const username = typeof input?.username === "string" ? input.username : "";
			const password = typeof input?.password === "string" ? input.password : "";
			const target = store.find(username);
			if (target === null) {
				denyJson(res, 404, "account not found");
				return;
			}
			const adminAccount = store.find(verdict.user.username);
			const adminOk = adminAccount !== null && await verifyPassword(password, adminAccount.passwordHash);
			if (!adminOk) {
				denyJson(res, 401, "invalid admin password");
				return;
			}
			const had = store.disableTotp(username);
			store.save();
			json(res, 200, { ok: true, disabled: had });
			return;
		}
		denyJson(res, 400, `unknown action ${JSON.stringify(action)}`);
	};

	// Register the /auth/* plane with the ORIGINAL register (before the gate is
	// patched in) so these routes are never wrapped.
	const originalRegister = webServer.register.bind(webServer);
	const originalRegisterUpgrade = webServer.registerUpgrade.bind(webServer);
	const originalRegisterFallback = webServer.registerFallback.bind(webServer);

	const disposers = [];
	disposers.push(originalRegister({ kind: "exact", path: "/auth/login", handler: handleLogin }));
	disposers.push(originalRegister({ kind: "exact", path: "/auth/logout", handler: handleLogout }));
	disposers.push(originalRegister({ kind: "exact", path: "/auth/me", handler: handleMe }));
	if (cfg.enabled) {
		disposers.push(originalRegister({ kind: "exact", path: "/auth/bootstrap", handler: handleBootstrap }));
		disposers.push(originalRegister({ kind: "exact", path: "/auth/accounts", handler: handleAccounts }));
		disposers.push(originalRegister({ kind: "exact", path: "/auth/mfa/login", handler: handleMfaLogin }));
		disposers.push(originalRegister({ kind: "exact", path: "/auth/mfa/setup", handler: handleMfaSetup }));
		disposers.push(originalRegister({ kind: "exact", path: "/auth/mfa/verify", handler: handleMfaVerify }));
		disposers.push(originalRegister({ kind: "exact", path: "/auth/mfa/disable", handler: handleMfaDisable }));
	}

	if (cfg.enabled) {
		// Wrap routes registered before this plugin activated.
		for (const route of webServer.exact.values()) route.handler = wrapHttp(route.handler);
		for (const route of webServer.prefixes.values()) route.handler = wrapHttp(route.handler);
		for (const route of webServer.upgrades.values()) route.handler = wrapUpgrade(route.handler);
		if (webServer.fallback !== undefined) webServer.fallback = wrapFallback(webServer.fallback);

		// Gate every route registered later.
		webServer.register = (route) => originalRegister({ ...route, handler: wrapHttp(route.handler) });
		webServer.registerUpgrade = (route) => originalRegisterUpgrade({ ...route, handler: wrapUpgrade(route.handler) });
		webServer.registerFallback = (handler) => originalRegisterFallback(wrapFallback(handler));
	}

	ctx.effect(() => () => {
		for (const dispose of disposers) dispose();
		if (cfg.enabled) {
			webServer.register = originalRegister;
			webServer.registerUpgrade = originalRegisterUpgrade;
			webServer.registerFallback = originalRegisterFallback;
			for (const route of webServer.exact.values()) route.handler = unwrap(route.handler);
			for (const route of webServer.prefixes.values()) route.handler = unwrap(route.handler);
			for (const route of webServer.upgrades.values()) route.handler = unwrap(route.handler);
			if (webServer.fallback !== undefined) webServer.fallback = unwrap(webServer.fallback);
		}
	}, "dsh-remote: gate");

	ctx.logger.info(
		`dsh-remote: authentication ${cfg.enabled ? "enabled" : "disabled"} ` +
		`(${store.list().length} account(s), store at ${defaultStorePath()})`
	);
}

export { Config, apply, inject, name };
export default { Config, apply, inject, name };
