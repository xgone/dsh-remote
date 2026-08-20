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
import { createGzip } from "node:zlib";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import QRCode from "qrcode";
import { AccountStore, defaultStorePath, generateSecret, hashPasswordSync, hmac, verifyPassword } from "./store.js";
import { renderLoginPage } from "./login-page.js";
import { generateBackupCodes, generateTotpSecret, hashBackupCode, otpauthUri, verifyTotp } from "./totp.js";

/**
 * Read the app-level locale preference (`locale.preference` in
 * $DSH_HOME/settings.yaml) so the login page follows the same language the
 * DSH shell uses. Returns "zh" | "en" | null (absent/unreadable — the caller
 * then falls back to the request's Accept-Language).
 */
const readLocalePreference = () => {
	try {
		const raw = readFileSync(join(dshHomePath(), "settings.yaml"), "utf8");
		const match = /(?:^|\n)locale:\n(?:[ \t]+[^\n]*\n)*?[ \t]+preference:\s*(\S+)/.exec(raw);
		const value = match?.[1]?.replace(/^["']|["']$/g, "");
		return value === "zh" || value === "en" ? value : null;
	} catch {
		return null;
	}
};

/** Stable Cordis plugin name. */
const name = "remote";

/** Services required before this plugin activates. */
const inject = ["webServer"];

/** Marker placed on gated handlers so re-application never double-wraps. */
const GATED = Symbol("dsh-remote.gated");

/**
 * Where the ORIGINAL (pre-`normalizeForFence`) Host is stashed before the /api
 * trust fence rewrites it to loopback. `shouldGzip` reads this to decide
 * whether the request came from a remote (non-loopback) browser — gzip is only
 * useful / desired for those, not for local direct access.
 * Internal implementation detail; not a stable API.
 */
const ORIGINAL_HOST = Symbol("dsh-remote.originalHost");

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
	// Headless/Linux bootstrap: the browser bootstrap endpoint is loopback-only,
	// which a server without a local browser can never reach. Declaring
	// credentials here provisions the first admin at startup (once); ignored as
	// soon as any account exists.
	bootstrap: z.object({
		username: z.string().min(1),
		password: z.string().min(1)
	}),
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
	}).default({}),
	gzip: z.object({
		enabled: z.boolean().default(true),
		// Only compress responses served to remote (non-loopback original Host)
		// browsers. Local loopback access already has near-zero latency and
		// plenty of bandwidth, so compression there only costs CPU.
		remoteOnly: z.boolean().default(true),
		// Below this many response bytes skip compression (gzip overhead beats
		// any savings on tiny bodies).
		minBytes: z.natural().default(1024)
	}).default({}),
	// Remote file display: in remote mode the browser redirects host.openPath
	// clicks to /auth/file (served by this plugin) so the file is DISPLAYED in
	// the remote browser instead of being opened by a desktop app on the host,
	// where the remote user would never see it.
	files: z.object({
		enabled: z.boolean().default(true),
		// Extra allowed read roots (absolute paths). The default roots are the
		// DSH home directory and the process working directory (where sessions
		// and agent-produced files usually live); list more here to expose
		// files stored elsewhere.
		roots: z.array(z.string()).default([]),
		// Cap entries rendered per directory listing page.
		maxListing: z.natural().min(10).max(5000).default(500)
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

// ── response gzip / static cache helpers ───────────────────────────────────────
// These run AFTER authentication (the gate wraps `res` only for authed requests),
// and only for remote (non-loopback) original Host when `gzip.remoteOnly`.

/** Content-Types worth gzip-ing (lower-cased). Intentional narrow allow-list so
 *  binary and streaming responses are never wrongly compressed. */
const GZIP_TEXT_TYPES = new Set([
	"text/html",
	"text/css",
	"text/plain",
	"text/javascript",
	"application/javascript",
	"application/x-javascript",
	"application/json",
	"text/json",
	"image/svg+xml",
	"application/manifest+json",
]);

/** Request paths / URL features that resolve to rev-hashed static assets — safe
 *  to cache immutable + CDN-cache (mirrors dsh-web-remote's isCacheable). */
function shouldCache(req) {
	const u = String(req.url ?? "");
	if (u.startsWith("/assets/") || u.startsWith("/plugins/") || u.includes("rev=")) return true;
	if (u === "/favicon.svg" || u === "/manifest.webmanifest") return true;
	return false;
}

/** Is a raw Host header value a loopback authority (localhost, [::1], 127.x)? */
function isLoopbackHostHeader(host) {
	const s = String(host ?? "").toLowerCase();
	// IPv6 loopback uses brackets, e.g. `[::1]` or `[::1]:3080`.
	if (s.startsWith("[")) return s.startsWith("[::1]");
	const hostname = s.split(":")[0];
	if (hostname === "localhost") return true;
	const parts = hostname.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** Is the request's ORIGINAL Host (pre-fence rewrite) a remote, non-loopback host? */
function isRemoteOrigin(req) {
	return !isLoopbackHostHeader(req[ORIGINAL_HOST]);
}

/** Stash the raw Host before `normalizeForFence` rewrites it. Must be called
 *  BEFORE the fence normalization on the gated HTTP/fallback path. */
function captureOriginalHost(req) {
	req[ORIGINAL_HOST] = req.headers.host;
}

/** Look up the effective content-type of a response from its resolved headers. */
function contentTypeOf(headers) {
	if (headers && typeof headers["content-type"] === "string") return headers["content-type"].split(";")[0].trim().toLowerCase();
	return "";
}

/** Decide whether a gated response should be gzip-compressed.
 *  @param remoteOnly - when true, only remote (non-loopback original Host) requests compress.
 *  @param minBytes - responses with a known Content-Length below this are skipped. */
function shouldGzip(req, status, headers, remoteOnly = true, minBytes = 1024) {
	if (status === 204 || status === 206 || status === 304) return false;
	if (remoteOnly && !isRemoteOrigin(req)) return false; // local direct access: no gzip
	if (String(req.headers["accept-encoding"] ?? "").indexOf("gzip") === -1) return false;
	if (headers && headers["content-encoding"]) return false; // already compressed
	const ctype = contentTypeOf(headers);
	if (ctype === "text/event-stream") return false; // SSE: streaming, never gzip
	let eligible = false;
	if (ctype === "") {
		// Content-Type absent: fall back to URL extension (.js/.css/.json/.map/...)
		const u = String(req.url ?? "").toLowerCase();
		eligible = /\.(?:js|mjs|cjs|css|json|map|svg|html)$/.test(u);
	} else {
		eligible = GZIP_TEXT_TYPES.has(ctype);
	}
	if (!eligible) return false;
	const len = headers && typeof headers["content-length"] === "string" ? Number(headers["content-length"]) : NaN;
	if (Number.isFinite(len) && len >= 0 && len < minBytes) return false; // too small
	return true;
}

/**
 * Wrap a node:http ServerResponse so that (a) gzip compression is applied to the
 * body when eligible, and (b) rev-hashed static assets get long-lived cache
 * headers. The real `writeHead` is deferred to the first `write`/`end` so the
 * decision can inspect the response headers before they are emitted. Only the
 * minimal surface (`writeHead`/`write`/`end`/`flushHeaders`/`destroy`) is
 * intercepted; everything else is forwarded to the real `res` via a Proxy so
 * `headersSent`, event listeners, `setTimeout`, `socket`, etc. behave normally.
 */
function makeGzipRes(res, req, cfg) {
	const minBytes = (cfg && cfg.minBytes) || 1024;
	const remoteOnly = !cfg || cfg.remoteOnly !== false;

	let statusCode = 200;
	let resolvedHeaders = null;   // merged headers seen in writeHead
	let gzip = null;              // null = undecided; then true/false
	let rawHeaders = null;        // headers to emit when NOT gzipped

	let gzStream = null;

	const emit = (finalHeaders) => {
		if (res.headersSent) return;
		res.writeHead(statusCode, finalHeaders);
	};

	const maybeStart = () => {
		// Decide once, at the first write/end, when the real headers are about to
		// go on the wire.
		if (gzip !== null) return;
		const eligible = shouldGzip(req, statusCode, resolvedHeaders, remoteOnly, minBytes);
		if (eligible) {
			gzip = true;
			gzStream = createGzip();
			gzStream.on("error", () => { try { res.destroy(); } catch { /* ignore */ } });
			// headers to emit: our own + the originals minus content-length
			const out = {};
			for (const [k, v] of Object.entries(resolvedHeaders || {})) {
				const lk = k.toLowerCase();
				if (lk === "content-length" || lk === "transfer-encoding" || lk === "connection" || lk === "keep-alive") continue;
				out[k] = v;
			}
			out["content-encoding"] = "gzip";
			if (out["vary"]) out["vary"] = String(out["vary"]).replace(/accept-encoding/gi, "").replace(/,{2,}/g, ",") + ", Accept-Encoding";
			else out["vary"] = "Accept-Encoding";
			// rev-hashed assets: long-lived caches (phone re-open is fast; CDN edge hits)
			if (shouldCache(req)) {
				out["cache-control"] = "public, max-age=31536000, immutable";
				out["cdn-cache-control"] = "public, max-age=86400";
			}
			emit(out);
			// Compressed bytes flow from the gzip stream into the client socket.
			// pipe() with default end:true calls res.end() when the gzip stream
			// finishes flushing its final block — this is what guarantees the
			// complete gzip trailer reaches the client.
			gzStream.pipe(res);
		} else {
			gzip = false;
			emit(rawHeaders ?? resolvedHeaders ?? {});
		}
	};

	const writeChunk = (chunk, encoding, cb) => {
		if (gzip) {
			// Data goes into the gzip stream (piped to the real res), so return
			// `true` — a truthful "accepted, no drain needed". Returning falsy
			// (e.g. undefined) makes node's http-bridge wait for a 'drain' event
			// that never fires on the real res (we never call res.write for the
			// body), deadlocking the response. Backpressure is the gzip pipe's job.
			gzStream.write(chunk, encoding, cb);
			return true;
		}
		return res.write(chunk, encoding, cb);
	};

	const wrapper = {
		writeHead(status, headers, ...rest) {
			// Node allows writeHead(headers) with status 200 implicit; normalize.
			if (typeof status === "object" && status !== null) {
				headers = status;
				status = 200;
			}
			statusCode = status;
			const h = Object.assign({}, headers ?? {});
			resolvedHeaders = Object.assign({}, resolvedHeaders ?? {}, h);
			// Keep original headers (pre-rewrite) so non-gzipped responses match DSH.
			rawHeaders = Object.assign({}, rawHeaders ?? {}, h);
			// Don't emit yet — decide at first write/end.
			return res;
		},
		flushHeaders() {
			maybeStart();
			if (!gzip) res.flushHeaders();
		},
		write(chunk, encoding, cb) {
			maybeStart();
			return writeChunk(chunk, encoding, cb);
		},
		end(chunk, encoding, cb) {
			maybeStart();
			if (gzip) {
				// Ending the gzip stream flushes its final block; the pipe (default
				// end:true) then calls res.end() once the full trailer is delivered.
				if (chunk !== undefined && chunk !== null) gzStream.end(chunk, encoding, cb);
				else gzStream.end();
				return res;
			}
			if (chunk !== undefined && chunk !== null) return res.end(chunk, encoding, cb);
			return res.end();
		},
		destroy(...args) {
			if (gzStream) { try { gzStream.destroy(); } catch { /* ignore */ } }
			return res.destroy(...args);
		},
	};

	return new Proxy(res, {
		get(target, prop, receiver) {
			if (prop in wrapper) return wrapper[prop];
			const value = Reflect.get(target, prop, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
		set(target, prop, value, receiver) {
			return Reflect.set(target, prop, value, receiver);
		},
	});
}

/** Resolve the effective allowed roots (realpaths; unreadable roots drop out). */
function fileRootsFor(extraRoots = []) {
	const candidates = [dshHomePath(), process.cwd(), ...extraRoots];
	const roots = [];
	for (const candidate of candidates) {
		if (typeof candidate !== "string" || candidate === "") continue;
		try {
			const real = realpathSync(resolve(candidate));
			if (!roots.includes(real)) roots.push(real);
		} catch {
			// root does not exist / unreadable — skip it
		}
	}
	return roots;
}

/**
 * Is a requested absolute path inside one of the allowed roots (DSH home,
 * process cwd, plus `extraRoots`)? Symlink escapes are neutralized by
 * comparing realpaths. Exported for tests.
 * @returns {ok, real, reason} — reason is a stable short code for tests.
 */
function checkFilePathAgainst(rawPath, extraRoots = []) {
	if (typeof rawPath !== "string" || rawPath.trim() === "") return { ok: false, reason: "no-path" };
	const resolved = resolve(rawPath);
	let real;
	try {
		real = realpathSync(resolved);
	} catch {
		return { ok: false, reason: "not-found" };
	}
	let st;
	try {
		st = statSync(real);
	} catch {
		return { ok: false, reason: "not-found" };
	}
	if (!st.isFile() && !st.isDirectory()) return { ok: false, reason: "not-a-file" };
	const roots = fileRootsFor(extraRoots);
	const inside = roots.some((root) => real === root || real.startsWith(root + sep));
	if (!inside) return { ok: false, reason: "outside-roots" };
	return { ok: true, real, isDirectory: st.isDirectory(), size: st.isFile() ? st.size : undefined };
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

	// Config bootstrap (headless servers): the browser bootstrap endpoint is
	// loopback-only, so a Linux box without a local browser cannot create the
	// first admin through the UI. Declaring credentials in the composition
	// provisions the root admin here instead — idempotent, and the first
	// account of an empty store is protected exactly like a UI bootstrap.
	const boot = cfg.bootstrap;
	if (boot?.username && boot?.password) {
		if (store.hasAccounts) {
			ctx.logger.warn("[dsh-remote] bootstrap config ignored: accounts already exist — remove the credentials from cordis.patch.yml");
		} else {
			const username = String(boot.username).trim();
			if (!username) throw new Error("dsh-remote: bootstrap.username must not be empty");
			if (String(boot.password).length < 6) throw new Error("dsh-remote: bootstrap.password must be at least 6 characters");
			store.upsert({ username, role: "admin", passwordHash: hashPasswordSync(String(boot.password)) });
			ctx.logger.info("[dsh-remote] bootstrapped first admin account %q from config — remove the credentials from cordis.patch.yml after first login", username);
		}
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
			captureOriginalHost(req);
			const verdict = requireAuth(req);
			if (!verdict.ok) {
				denyJson(res, 403, "unauthorized");
				return;
			}
			let outRes = res;
			if (cfg.gzip.enabled) {
				outRes = makeGzipRes(res, req, cfg.gzip);
			}
			normalizeForFence(req);
			if (cfg.enforceRoles && verdict.user.role !== "admin") {
				const gate = await roleGate(req, verdict.user.role);
				if (!gate.allowed) {
					denyJson(outRes, 403, "forbidden for role " + verdict.user.role);
					return;
				}
				if (gate.replayed) return handler(replayable(req, gate.body), outRes);
			}
			return handler(req, outRes);
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
					// i18n: prefer the app-level language preference (the same
					// value the DSH shell follows); otherwise fall back to the
					// browser's Accept-Language (zh for any zh-* tag, else en).
					const lang = readLocalePreference()
						?? (/^zh/i.test(req.headers?.["accept-language"] ?? "") ? "zh" : "en");
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
			// Authenticated: static / SPA resources. Capture the original Host for
			// the remote-only gzip decision and wrap `res` so bundles, index.html
			// and JSON get compressed + long-lived cache headers for remote clients.
			captureOriginalHost(req);
			let outRes = res;
			if (cfg.gzip.enabled) {
				outRes = makeGzipRes(res, req, cfg.gzip);
			}
			return handler(req, outRes);
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

	// Remote settings refresh (browser-half counterpart: unpinRemoteSettingsScopes
	// in lib/client.js). The client patches its settings scope queue so
	// memory-mode scopes perform their RPCs, but the scopes bound at boot already
	// swallowed their initial load — this endpoint makes the host re-broadcast
	// settings/document-updated (the invalidation every scope subscribes to) with
	// no namespace, reloading every scope through the now-working queue. Requires
	// a valid session so unauthenticated visitors cannot flood the broadcast.
	const handleSettingsRefresh = (req, res) => {
		if (req.method !== "POST") {
			denyJson(res, 405, "method not allowed");
			return;
		}
		if (!cfg.enabled) {
			denyJson(res, 403, "authentication is disabled");
			return;
		}
		if (!requireAuth(req).ok) {
			denyJson(res, 401, "unauthorized");
			return;
		}
		// No namespace argument → the client refresh handler reloads every scope.
		ctx.emit("settings/document-updated");
		json(res, 200, { ok: true });
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

	// ── remote file display (/auth/file) ───────────────────────────────────────
	// The web UI opens agent-produced files through the host.openPath RPC, which
	// hands the path to the HOST desktop's default application — invisible to a
	// remote browser. The browser half of this plugin intercepts those RPCs for
	// non-loopback clients and redirects them here, so the file is displayed in
	// the remote browser (inline) or downloaded, and directories get an HTML
	// listing instead of a host file-manager window.

	/** Content-Types for inline display by extension (lower-cased, no dot). */
	const FILE_MIME = {
		html: "text/html; charset=utf-8",
		htm: "text/html; charset=utf-8",
		css: "text/css; charset=utf-8",
		js: "text/javascript; charset=utf-8",
		mjs: "text/javascript; charset=utf-8",
		json: "application/json; charset=utf-8",
		txt: "text/plain; charset=utf-8",
		md: "text/plain; charset=utf-8",
		csv: "text/plain; charset=utf-8",
		log: "text/plain; charset=utf-8",
		svg: "image/svg+xml",
		png: "image/png",
		jpg: "image/jpeg",
		jpeg: "image/jpeg",
		gif: "image/gif",
		webp: "image/webp",
		avif: "image/avif",
		ico: "image/x-icon",
		bmp: "image/bmp",
		pdf: "application/pdf",
		mp4: "video/mp4",
		webm: "video/webm",
		mp3: "audio/mpeg",
		wav: "audio/wav"
	};

	const escapeHtml = (s) => String(s)
		.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;").replaceAll("'", "&#39;");

	/**
	 * Is a requested absolute path inside one of the allowed roots (DSH home,
	 * process cwd, plus `extraRoots`)? Symlink escapes are neutralized by
	 * comparing realpaths. Exported for tests.
	 * @returns {ok, real, reason} — reason is a stable short code for tests.
	 */
	const checkFilePath = (rawPath, extraRoots = []) => checkFilePathAgainst(rawPath, extraRoots);

	/** Simple HTML directory listing with clickable entries (files open inline). */
	const renderListing = (dirPath, entries) => {
		const rows = entries.map((entry) => {
			const href = `/auth/file?path=${encodeURIComponent(join(dirPath, entry.name))}`;
			const icon = entry.isDirectory ? "&#128193;" : "&#128196;";
			const size = entry.isDirectory ? "—" : `${Math.max(1, Math.round(entry.size / 1024))} KB`;
			return `<tr><td><a href="${href}">${icon} ${escapeHtml(entry.name)}${entry.isDirectory ? "/" : ""}</a></td><td>${size}</td></tr>`;
		}).join("\n");
		const parent = dirname(dirPath);
		const parentRow = parent !== dirPath && checkFilePath(parent).ok
			? `<tr><td><a href="/auth/file?path=${encodeURIComponent(parent)}">&#11014; ..</a></td><td>—</td></tr>` : "";
		return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(dirPath)}</title>` +
			`<style>body{font:13px/1.6 -apple-system,Segoe UI,sans-serif;background:#0d1117;color:#e6edf3;padding:24px;}` +
			`code{color:#8b949e}table{border-collapse:collapse}td{padding:3px 18px 3px 0}` +
			`a{color:#4c8bf5;text-decoration:none}a:hover{text-decoration:underline}</style></head><body>` +
			`<h3 style="margin:0 0 4px">Index of</h3><code>${escapeHtml(dirPath)}</code>` +
			`<table style="margin-top:14px">${parentRow}${rows}</table></body></html>`;
	};

	const handleFile = (req, res) => {
		if (req.method !== "GET" && req.method !== "HEAD") {
			denyJson(res, 405, "method not allowed");
			return;
		}
		if (!requireAuth(req).ok) {
			denyJson(res, 401, "unauthorized");
			return;
		}
		let rawPath = null;
		let format = null;
		try {
			const query = new URL(req.url ?? "/", "http://dsh.internal").searchParams;
			rawPath = query.get("path");
			format = query.get("format");
		} catch {
			rawPath = null;
		}
		const verdict = checkFilePath(rawPath);
		if (!verdict.ok) {
			const status = verdict.reason === "outside-roots" ? 403 : 404;
			denyJson(res, status, `cannot display file (${verdict.reason})`);
			return;
		}
		if (verdict.isDirectory) {
			let list;
			try {
				list = readdirSync(verdict.real, { withFileTypes: true });
			} catch {
				denyJson(res, 403, "cannot read directory");
				return;
			}
			const rows = [];
			for (const ent of list) {
				if (rows.length >= cfg.files.maxListing) break;
				try {
					const st = statSync(join(verdict.real, ent.name));
					rows.push({ name: ent.name, isDirectory: st.isDirectory(), size: st.size });
				} catch {
					// dangling symlink etc. — skip
				}
			}
			rows.sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : (a.isDirectory ? -1 : 1)));
			// format=json powers the in-app viewer modal's directory navigation;
			// the default HTML listing serves direct browser opens.
			if (format === "json") {
				const parent = dirname(verdict.real);
				json(res, 200, {
					ok: true,
					path: verdict.real,
					parent: parent !== verdict.real && checkFilePath(parent).ok ? parent : null,
					entries: rows.map((row) => ({ ...row, path: join(verdict.real, row.name) }))
				});
				return;
			}
			const html = renderListing(verdict.real, rows);
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(html) });
			res.end(req.method === "HEAD" ? undefined : html);
			return;
		}
		const ext = extname(verdict.real).slice(1).toLowerCase();
		const mime = FILE_MIME[ext] ?? "application/octet-stream";
		const inline = mime !== "application/octet-stream" || ext === "";
		const disposition = inline
			? `inline; filename="${encodeURIComponent(basename(verdict.real))}"`
			: `attachment; filename="${encodeURIComponent(basename(verdict.real))}"`;
		res.writeHead(200, {
			"Content-Type": mime,
			"Content-Length": verdict.size,
			"Content-Disposition": disposition,
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff"
		});
		if (req.method === "HEAD") {
			res.end();
			return;
		}
		const stream = createReadStream(verdict.real);
		stream.on("error", () => { try { res.destroy(); } catch { /* ignore */ } });
		stream.pipe(res);
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
		disposers.push(originalRegister({ kind: "exact", path: "/auth/settings-refresh", handler: handleSettingsRefresh }));
		disposers.push(originalRegister({ kind: "exact", path: "/auth/accounts", handler: handleAccounts }));
		disposers.push(originalRegister({ kind: "exact", path: "/auth/mfa/login", handler: handleMfaLogin }));
		disposers.push(originalRegister({ kind: "exact", path: "/auth/mfa/setup", handler: handleMfaSetup }));
		disposers.push(originalRegister({ kind: "exact", path: "/auth/mfa/verify", handler: handleMfaVerify }));
		disposers.push(originalRegister({ kind: "exact", path: "/auth/mfa/disable", handler: handleMfaDisable }));
		if (cfg.files.enabled) {
			disposers.push(originalRegister({ kind: "exact", path: "/auth/file", handler: handleFile }));
		}
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
export {
	ORIGINAL_HOST,
	captureOriginalHost,
	isRemoteOrigin,
	shouldGzip,
	shouldCache,
	makeGzipRes,
	checkFilePathAgainst
};
export default { Config, apply, inject, name };
