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
import { createGzip, inflateRawSync } from "node:zlib";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import QRCode from "qrcode";
import { AccountStore, defaultStorePath, generateSecret, hashPasswordSync, hmac, verifyPassword } from "./store.js";
import { FilesRootsStore, filesRootsPath } from "./files-store.js";
import { AnonymousPathsStore, anonymousPathsPath, matchesAnonymousPath, normalizeAnonymousPath } from "./anonymous-paths-store.js";
import { renderLoginPage } from "./login-page.js";
import { generateBackupCodes, generateTotpSecret, hashBackupCode, otpauthUri, verifyTotp } from "./totp.js";

/**
 * Locale ids DSH ships and dsh-remote translates. Keep the order matching
 * `@deepseek-ai/dsh-client-locale` so the client dictionary set and the
 * server-rendered login page accept exactly the same languages.
 */
const SUPPORTED_LOCALES = ["en", "zh", "ja", "es", "fr", "de", "ru", "pt"];

/** Normalize an arbitrary tag (`zh-CN`, `pt_BR`, `EN`) to a supported primary
 *  subtag, or null when the language is not shipped by DSH. */
const normalizeLocale = (tag) => {
	if (typeof tag !== "string") return null;
	const primary = tag.trim().toLowerCase().replace(/_/g, "-").split("-")[0];
	return SUPPORTED_LOCALES.includes(primary) ? primary : null;
};

/** Pick the first supported locale from an Accept-Language header (highest q
 *  first, full tag before primary subtag through normalizeLocale), else null. */
const localeFromAcceptLanguage = (header) => {
	if (typeof header !== "string" || header.length === 0) return null;
	const ranked = header
		.split(",")
		.map((part) => {
			const [tag, ...params] = part.trim().split(";");
			let q = 1;
			for (const param of params) {
				const match = /^\s*q=([0-9.]+)\s*$/.exec(param);
				if (match) q = Number(match[1]);
			}
			return { tag: tag.trim(), q: Number.isFinite(q) ? q : 1 };
		})
		.filter((entry) => entry.tag.length > 0 && entry.tag !== "*" && entry.q > 0)
		.sort((a, b) => b.q - a.q);
	for (const { tag } of ranked) {
		const locale = normalizeLocale(tag);
		if (locale !== null) return locale;
	}
	return null;
};

/** Resolve the login-page language from an explicit preference and an
 *  Accept-Language header (pure; used by the tests). */
const pickLoginLang = (preference, acceptLanguage) =>
	normalizeLocale(preference) ?? localeFromAcceptLanguage(acceptLanguage) ?? "en";

/** Language for a server-rendered login page: the stored DSH preference, else
 *  the browser's Accept-Language, else English. */
const loginPageLang = (headers) =>
	pickLoginLang(readLocalePreference(), headers?.["accept-language"]);

/**
 * Read the app-level locale preference (`locale.preference` in
 * $DSH_HOME/settings.yaml -- probed as settings.yaml.imported on dsh >= 0.1.7)
 * so the login page follows the same language the DSH shell uses. Returns one
 * of {@link SUPPORTED_LOCALES}, or null when absent/unreadable — the caller
 * then falls back to the request's Accept-Language.
 */
const readLocalePreference = () => {
	// dsh >= 0.1.7 renames settings.yaml to settings.yaml.imported after the
	// one-time settings import (dsh-settings), so probe both names.
	for (const fileName of ["settings.yaml.imported", "settings.yaml"]) {
		try {
			const raw = readFileSync(join(dshHomePath(), fileName), "utf8");
			const match = /(?:^|\n)locale:\n(?:[ \t]+[^\n]*\n)*?[ \t]+preference:\s*(\S+)/.exec(raw);
			const locale = normalizeLocale(match?.[1]?.replace(/^["']|["']$/g, ""));
			if (locale !== null) return locale;
		} catch {
			// absent/unreadable -- probe the next name, else Accept-Language
		}
	}
	return null;
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
/** resource wrapper -> original resource (dsh ≥ 0.2.2-alpha Fetch routes). */
const wrappedResourceOriginals = new WeakMap();
/** wrapped fallback descriptor -> original descriptor (dsh ≥ 0.2.3 auth policies). */
const wrappedFallbackOriginals = new WeakMap();
/** route -> original auth policy when admin anonymous prefixes are composed into host auth. */
const wrappedRouteAuthOriginals = new WeakMap();

/** Paths owned by this plugin — never gated. */
function isPublicPath(pathname) {
	return pathname === "/auth" || pathname.startsWith("/auth/");
}

/** Wire methods any non-admin session may not call. Names exist per dsh
 *  generation: the rc-era dotted entries and their dsh ≥ 0.1.2-alpha
 *  renames (evaluateRoleGate normalizes `namespace/method` → dotted before
 *  matching, so one list covers both). The native-open methods are denied so
 *  a non-admin session can never pop a host desktop surface — the remote
 *  browser file panel never reaches the wire for these anyway (the client
 *  half intercepts the fetch first); this is defense in depth. */
const NON_ADMIN_DENY = new Set([
	"settings.describe",
	"settings.openDocument",
	"settings.openSettingsDocument",
	"settings.update",
	"settings.replace",
	"settings.mutate",
	"credentials.describe",
	"credentials.set",
	"credentials.unset",
	"agentPreset.read",
	"agentPreset.copy",
	"agentPreset.openDocument",
	"settings.openAgentPresetDirectory",
	"agentPreset.remove",
	"host.pickDirectory",
	"host.listDirectory",
	"host.createDirectory",
	"host.openPath",
	"session.openWorkspacePath",
	"llm.discoverModels"
]);

/** Wire methods a guest (read-only) session may not call either. */
const GUEST_DENY = new Set([
	"session.prompt",
	"session.export",
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
	// Shared secret required by POST /auth/bootstrap while the account store is
	// empty. Defaults to '' — an ephemeral random token is generated per process
	// and printed in the startup log, so a remote attacker cannot claim the first
	// admin just by presenting a loopback-looking Host header.
	bootstrapToken: z.string().default(""),
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
	}).default({}),
	// dsh ≥ 0.1.2-alpha browser-session cookie minting (issue #10). New dsh
	// builds gate /api and index.html behind a persistent, Host-bound signed
	// cookie (`dsh-auth-<sha256(host)>`, verified by client-connection's
	// browserAuth). Remote browsers can never hold the cookie bound to the
	// loopback authority this plugin normalizes requests to, so after login
	// every /api call 401s. This plugin therefore MINTS that cookie itself —
	// signing it with the same persisted secret client-connection uses (read
	// through the credentials service) and binding it to the authority the
	// core will see (loopback under trustProxy, the original Host otherwise).
	// A self-heal re-mint on gated requests also upgrades sessions created
	// before this fix. No-op on dsh builds without the credential record.
	browserAuth: z.object({
		enabled: z.boolean().default(true),
		// Minted-cookie lifetime in seconds; 0 follows `session.ttlSeconds`
		// (the default 7d sits well inside client-connection's default
		// cookieMaxAgeDays of 30, which bounds the accepted window). Raise
		// this above the deployment's cookieMaxAgeDays and the core would
		// reject every minted cookie.
		cookieTtlSeconds: z.natural().default(0)
	}).default({})
});

// ── small HTTP helpers ────────────────────────────────────────────────────────

function pathnameOf(req) {
	return new URL(req.url ?? "/", "http://dsh.internal").pathname;
}

/** Pathname exactly as the request line carried it (still percent-encoded) —
 *  the only form whose decoding is the core's own decision. */
function rawPathnameOf(req) {
	return String(req.url ?? "/").split("?")[0];
}

/** One query parameter from a request target, or null (also for an
 *  unparsable target, which cannot carry the core's `?token=` anyway). */
function searchParamGet(url, name) {
	try {
		return new URL(url ?? "/", "http://dsh.internal").searchParams.get(name);
	} catch {
		return null;
	}
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

/**
 * Pure role-gate decision, exported for tests. Only client-request envelopes
 * carry a `method` and are subject to role gating. Everything else is a
 * wire-protocol message — most importantly /api/respond, whose
 * client-response envelope answers a host server-request (approvals,
 * questions, tool results, subagent submissions…). Denying those broke the
 * respond channel for EVERY session (method === null fell into the deny
 * branch), which aborted pending host streams, forced a WebSocket reconnect,
 * and left the workspace/session baselines appearing wiped. Such envelopes
 * pass through (authenticated) with their body replayed untouched.
 * @param pathname - request pathname.
 * @param httpMethod - request method ("GET"/"POST"/…).
 * @param body - POST body buffer (null when not read / over the cap).
 * @param role - session role ("admin"/"user"/"guest").
 * @returns {allowed, body, replayed}.
 */
function evaluateRoleGate(pathname, httpMethod, body, role) {
	if (!pathname.startsWith("/api/")) return { allowed: true, body: null, replayed: false };
	if (pathname === "/api/session.export") return { allowed: role !== "guest", body: null, replayed: false };
	if (httpMethod !== "POST") return { allowed: true, body: null, replayed: false };
	if (body === null) return { allowed: role !== "guest", body: null, replayed: false };
	let envelope;
	try {
		envelope = JSON.parse(body.toString("utf8"));
	} catch {
		return { allowed: false, body, replayed: true };
	}
	if (envelope?.type !== "client-request" || typeof envelope.method !== "string") {
		return { allowed: true, body, replayed: true };
	}
	// dsh ≥ 0.1.2-alpha names RPC endpoints `namespace/method` (slash) on the
	// wire while the deny lists above are dotted rc-era names — normalize the
	// separators before matching so role gating binds on both generations.
	const method = envelope.method.replaceAll("/", ".");
	if (NON_ADMIN_DENY.has(method)) return { allowed: false, body, replayed: true };
	if (role === "guest" && GUEST_DENY.has(method)) return { allowed: false, body, replayed: true };
	return { allowed: true, body, replayed: true };
}

/**
 * Answer a denied client-request with a WIRE-COMPLIANT server-response
 * envelope (HTTP 200) so the browser's connection layer parses a clean
 * business error instead of a transport/schema failure: the client validates
 * every /api body against serverResponseSchema
 * ({type,rpcId,result:{ok:false,error:{code,message,details}}}); a plain
 * denyJson body made every denied RPC (e.g. credentials.describe for a
 * `user` session) throw inside the client and broke flows downstream.
 * `error.code` must be one of the client schema's discriminated codes.
 */
function denyRpcEnvelope(res, requestBody, message) {
	let rpcId = null;
	try {
		const envelope = JSON.parse(requestBody.toString("utf8"));
		if (typeof envelope?.rpcId === "string") rpcId = envelope.rpcId;
	} catch {
		// unreadable request — emit with a null id rather than fail
	}
	json(res, 200, {
		type: "server-response",
		rpcId,
		result: { ok: false, error: { code: "internal", message, details: {} } }
	});
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

/** Headers a reverse proxy / tunnel adds to a forwarded request. Their
 *  presence proves the request did NOT originate from this machine's browser,
 *  even though the proxy itself connects from loopback. */
const FORWARDING_HEADERS = [
	"x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port",
	"forwarded", "x-real-ip", "cf-connecting-ip", "true-client-ip", "x-client-ip", "fastly-client-ip"
];

/** Is this a genuinely local (pre-proxy) first-run request? Keeps the familiar
 *  username+password bootstrap on the machine itself while making a forged Host
 *  header useless to a remote attacker: the TCP peer must be loopback, the Host
 *  must be a strict loopback authority, and no proxy header may be present.
 *  Proxied fresh deployments can use the optional bootstrapToken instead. */
function isLocalBootstrapRequest(req) {
	const remote = String(req.socket?.remoteAddress ?? "").replace(/^::ffff:/i, "");
	const addressIsLoopback = remote === "::1"
		|| remote === "127.0.0.1"
		|| (remote.split(".").length === 4 && remote.split(".")[0] === "127");
	if (!addressIsLoopback) return false;
	for (const name of FORWARDING_HEADERS) {
		if (req.headers?.[name] !== undefined) return false;
	}
	return isLoopbackHostHeader(req.headers?.host);
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
	// Never let an API/auth response (which may carry Set-Cookie or user data)
	// inherit the long-lived static cache policy through a `?rev=` marker.
	if (u.startsWith("/api") || u.startsWith("/auth")) return false;
	if (u.startsWith("/assets/") || u.startsWith("/plugins/")) return true;
	if (u === "/favicon.svg" || u === "/manifest.webmanifest") return true;
	const pathname = u.split("?")[0];
	return /[?&]rev=/.test(u)
		&& /\.(?:js|mjs|cjs|css|json|map|svg|png|jpg|jpeg|gif|webp|avif|ico|bmp|woff2?|ttf|otf)$/i.test(pathname);
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

// ── dsh browser-session cookie minting (dsh ≥ 0.1.2-alpha, issue #10) ─────────
// dsh's client-connection plugin authenticates browsers with a persistent,
// Host-bound signed cookie (`dsh-auth-<sha256(authority)>`): the request Host
// selects the cookie name AND the payload `authority` must equal it. The
// functions below mirror packages/client/connection/src/browser-auth.ts
// (COOKIE_PAYLOAD_VERSION 1) so this plugin can mint cookies the core accepts.
// Pure helpers, exported for tests.

/** Credential record holding client-connection's persistent signing secret. */
const BROWSER_SESSION_RECORD_KEY = "client-connection/browser-session";

/** Cookie payload version minted/accepted by dsh core browser-auth v1. */
const BROWSER_COOKIE_VERSION = 1;
/** client-connection.cookieMaxAgeDays default — bounds any minted window. */
const BROWSER_COOKIE_MAX_AGE_DAYS_DEFAULT = 30;

/**
 * Canonical request authority exactly as dsh core derives it from a Host
 * header (WHATWG normalization: lowercased host, explicit port kept).
 * @returns {string|null} canonical `host[:port]`, or null when unparsable.
 */
function canonicalAuthority(host) {
	if (typeof host !== "string" || host === "") return null;
	try {
		return new URL(`http://${host}`).host;
	} catch {
		return null;
	}
}

/** Cookie name for an authority: `dsh-auth-` + base64url(sha256(authority)). */
function dshAuthCookieName(authority) {
	return "dsh-auth-" + createHash("sha256").update(authority).digest("base64url");
}

/**
 * Serialize one v1 browser-session cookie the way dsh core mints them.
 * @param {string} authority - bound authority (must match the request Host the core sees).
 * @param {Buffer} secret - client-connection's persisted signing secret (32 bytes).
 * @param {number} ttlMs - cookie window; the core rejects windows beyond cookieMaxAgeDays.
 * @param {number} [nowMs] - issuedAt override (tests).
 * @returns {{name: string, value: string, cookie: string}} name/value pair plus a full Set-Cookie line.
 */
function encodeDshAuthCookie(authority, secret, ttlMs, nowMs = Date.now()) {
	const issuedAt = nowMs;
	const expiresAt = issuedAt + ttlMs;
	const body = Buffer.from(JSON.stringify({
		version: BROWSER_COOKIE_VERSION,
		authority,
		issuedAt,
		expiresAt
	}), "utf8").toString("base64url");
	const sig = createHmac("sha256", secret).update(body).digest("base64url");
	const name = dshAuthCookieName(authority);
	const value = `v1.${body}.${sig}`;
	// Attribute set mirrors dsh core's sessionCookie() exactly.
	return { name, value, cookie: `${name}=${value}; Max-Age=${Math.floor(ttlMs / 1000)}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; SameSite=Strict` };
}

/**
 * Parse and verify one minted-or-core-minted cookie value (mirror of the
 * core's decodeCookie + isAuthenticated checks that matter to us).
 * @returns {object|null} payload when the signature, version, authority and window are live.
 */
function decodeDshAuthCookie(value, secret, authority, nowMs = Date.now()) {
	const parts = String(value ?? "").split(".");
	if (parts.length !== 3 || parts[0] !== "v1") return null;
	const [, body, sigB64] = parts;
	let sig, expected;
	try {
		sig = Buffer.from(sigB64, "base64url");
		expected = createHmac("sha256", secret).update(body).digest();
	} catch {
		return null;
	}
	if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
	let payload;
	try {
		payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
	} catch {
		return null;
	}
	if (payload?.version !== BROWSER_COOKIE_VERSION
		|| typeof payload.authority !== "string"
		|| !Number.isSafeInteger(payload.issuedAt)
		|| !Number.isSafeInteger(payload.expiresAt)) return null;
	if (payload.authority !== authority) return null;
	const maxAgeMs = BROWSER_COOKIE_MAX_AGE_DAYS_DEFAULT * 24 * 60 * 60 * 1000;
	return payload.issuedAt <= nowMs && payload.expiresAt > nowMs
		&& payload.expiresAt > payload.issuedAt
		&& payload.expiresAt - payload.issuedAt <= maxAgeMs ? payload : null;
}

/** Pull one cookie value out of a raw Cookie header (exact name match). */
function cookieValueOf(cookieHeader, name) {
	const header = String(cookieHeader ?? "");
	for (const segment of header.split(";")) {
		const at = segment.indexOf("=");
		if (at === -1 || segment.slice(0, at).trim() !== name) continue;
		return segment.slice(at + 1).trim();
	}
	return null;
}

/**
 * Return a Cookie header that carries `name=value`, REPLACING every existing
 * segment of that exact name instead of appending behind it. dsh core reads the
 * FIRST matching segment (`cookieValue` returns on the first hit), so appending
 * a fresh value behind a stale one would leave the core authenticating with the
 * dead value — precisely the case this rewrite exists for (an expired or
 * evicted `dsh-auth` cookie that is still in the browser's jar). Every other
 * cookie keeps its original order and text.
 * @param {string|undefined} cookieHeader - the incoming Cookie header.
 * @param {string} name - cookie name to set.
 * @param {string} value - cookie value.
 * @returns {string} the rewritten header (`name=value` when the input was empty).
 */
function cookieHeaderSet(cookieHeader, name, value) {
	const kept = [];
	const header = typeof cookieHeader === "string" ? cookieHeader : "";
	for (const segment of header.split(";")) {
		const trimmed = segment.trim();
		if (trimmed === "") continue;
		const at = trimmed.indexOf("=");
		if (at !== -1 && trimmed.slice(0, at).trim() === name) continue;
		kept.push(trimmed);
	}
	kept.push(`${name}=${value}`);
	return kept.join("; ");
}

/**
 * Validate the stored browser-session credential record and extract the
 * signing secret (mirror of the core's storedSecret/canonicalSecret).
 * @returns {Buffer|null} 32-byte HMAC key, or null when absent/malformed.
 */
function readBrowserAuthSecret(record) {
	if (record === null || typeof record !== "object") return null;
	if (record.kind !== "grant" || record.payload?.version !== 1) return null;
	const raw = record.payload.secret;
	if (typeof raw !== "string") return null;
	const secret = Buffer.from(raw, "base64url");
	return secret.byteLength === 32 ? secret : null;
}

/**
 * Does the request already carry a LIVE dsh-auth cookie for this authority?
 * Core-minted cookies (direct loopback `?token=` access) validate too — the
 * name, secret and authority are the same, so there is nothing to re-mint.
 */
function hasLiveDshAuthCookie(cookieHeader, authority, secret) {
	if (!authority || !secret) return false;
	const value = cookieValueOf(cookieHeader, dshAuthCookieName(authority));
	if (value === null) return false;
	return decodeDshAuthCookie(value, secret, authority) !== null;
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
		// Merge onto the REAL response's own headers instead of replacing them.
		// The core's compression middleware calls `res.writeHead(statusCode)`
		// on this same object (status only, real headers already on the
		// response), which would otherwise wipe a rewritten Content-Type here —
		// node's own writeHead merges, so do the same.
		res.writeHead(statusCode, { ...(res.getHeaders?.() ?? {}), ...(finalHeaders ?? {}) });
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
			// A caller that already decided the cache policy wins: the PWA plane
			// stamps `no-store` on the manifest/worker because the cookie repair
			// only takes effect on a response the browser actually receives, and
			// an immutable override here would silently defeat that.
			if (shouldCache(req) && !hasHeader(out, "cache-control") && !hasHeader(out, "set-cookie")) {
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
			// Node allows writeHead(headers) with status 200 implicit, and its raw
			// `(status, reasonPhrase, headerArray)` triple; normalize both so a
			// PWA rewrite (which runs on this wrapper) always sees one plain bag.
			// NOTE (known gap, predates 0.3.6 — not introduced here): the two-arg
			// `writeHead(status, headerArray)` form lands the array in `headers`,
			// where `Object.assign` turns it into numeric keys. Node itself
			// accepts that form, so a caller using it would get a corrupt header
			// block. No caller in the core or this plugin does; fixing it is a
			// separate change.
			if (typeof status === "object" && status !== null) {
				headers = status;
				status = 200;
			} else if (Array.isArray(rest[rest.length - 1]) && (rest.length === 1 || typeof rest[0] === "string")) {
				const flat = rest[rest.length - 1];
				headers = Object.fromEntries(Array.from({ length: Math.floor(flat.length / 2) }, (_, i) => [flat[i * 2], flat[i * 2 + 1]]));
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

// ── PWA static plane (installed app launches behind the gate) ─────────────────
// An installed app opened from its own icon/window navigates on the
// FIRST request. The SPA fallback answers `/` with index.html only after the
// core's browserAuth accepts the Host-bound `dsh-auth-*` cookie; a browser
// whose jar lost that cookie gets the core's
// "dsh web authentication required; reopen the URL printed by dsh web.".
// The only requests the fallback can answer BEFORE such a navigation are the
// service worker's own static fetches (`sw.js` at registration, the manifest
// and icons thereafter). Serving those without a session and writing a
// Host-bound core cookie onto their response repairs the jar in place, so the
// next navigation is accepted — no client-side injection or core patch
// needed. Everything below is pure so the gate wiring stays testable.

/** PWA files the fallback seat serves to ANY visitor: the manifest and the
 *  service worker script, by exact path. Icons are matched separately (any
 *  valid leaf name under `/icons/`). */
const PWA_EXACT_FILES = new Set(["/manifest.webmanifest", "/sw.js"]);
/** Optional icon directory prefix — the only directory the allowlist covers. */
const PWA_ICON_PREFIX = "/icons/";
/** Icon leaf name: one path segment, conservative charset, never a traversal. */
const PWA_ICON_NAME_RE = /^[A-Za-z0-9._-]+$/;
/** Root-level app icons the newer dsh web dist ships: `manifest.webmanifest`
 *  names them RELATIVELY (`icon-192.png`, `icon-512.png`,
 *  `icon-maskable-512.png`) and `index.html` names the Apple touch icon. A
 *  browser fetches these while installing the app — before any session exists
 *  — so they must answer anonymously or the installed window has no icon.
 *  One path segment only, conservative charset: same traversal-safety posture
 *  as the `/icons/` allowlist. */
const PWA_ROOT_ICON_RE = /^\/(?:apple-touch-icon(?:-[A-Za-z0-9._-]+)?|icon(?:-[A-Za-z0-9._-]+)?)\.png$/;

/** MIME table for the static responses the fallback seat ships. The core's
 *  own table is authoritative, but it has no `.png`/`.ico` entry, so icons
 *  went out as `application/octet-stream` and some browsers refuse to install. */
const STATIC_MIME = new Map(Object.entries({
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".map": "application/json",
	".webmanifest": "application/manifest+json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".otf": "font/otf",
	".txt": "text/plain; charset=utf-8",
	".wasm": "application/wasm",
	".gz": "application/gzip"
}));

/** Decoded pathname of a request, or null when it is not valid UTF-8 escapes.
 *  Note a bad escape (e.g. `/icons/%zz.png`) throws in `decodeURIComponent`
 *  AND in `new URL(...)`, so the raw `?query` is cut off before decoding. */
function decodedPathname(req) {
	const raw = String(req.url ?? "/").split("?")[0];
	try {
		return decodeURIComponent(raw);
	} catch {
		return null;
	}
}

/**
 * Does this request target one of the PWA files the fallback seat serves
 * without a dsh-remote session? Matched on the RAW pathname the core will
 * decode, so an encoded spelling (`/%73w.js`) never widens the allowlist: it
 * reaches the core, not this branch.
 * @returns {boolean} true for the manifest, the service worker or one icon.
 */
function isPwaAssetPath(rawPathname) {
	if (PWA_EXACT_FILES.has(rawPathname)) return true;
	if (PWA_ROOT_ICON_RE.test(rawPathname)) return true;
	if (!rawPathname.startsWith(PWA_ICON_PREFIX)) return false;
	const name = rawPathname.slice(PWA_ICON_PREFIX.length);
	return name !== "." && name !== ".." && PWA_ICON_NAME_RE.test(name);
}

/** Extension of a pathname (lowercased, last segment only), or "" when none. */
function extensionOf(pathname) {
	const segments = String(pathname).split("/");
	const last = segments[segments.length - 1] ?? "";
	const dot = last.lastIndexOf(".");
	if (dot <= 0) return "";
	return last.slice(dot).toLowerCase();
}

/**
 * Is this response a document the browser treats as the app shell — and so a
 * response whose dsh-auth cookie must be repaired? Extension-less SPA routes
 * (`/`, `/workspace/x`), `.html`/`.htm`, and the PWA shell files (the manifest
 * and the worker). `/assets/*`, `/plugins/*`, `/api/*`, `/auth/*` and every
 * other extension-bearing file are NOT documents.
 */
function isDocumentPath(pathname) {
	// API and auth planes are data, not documents: `/auth/me` must not be
	// mistaken for an extension-less page just because "me" has no dot.
	if (pathname === "/api" || pathname.startsWith("/api/")) return false;
	if (pathname === "/auth" || pathname.startsWith("/auth/")) return false;
	if (pathname === "/manifest.webmanifest" || pathname === "/sw.js") return true;
	const ext = extensionOf(pathname);
	if (ext === "") return true;
	return ext === ".html" || ext === ".htm";
}

/** Expected content-type for a pathname: the static table, else `application/javascript`
 *  for an extension-less plugin bundle path (`/plugins/<id>/<file>`); a plugin
 *  file that names another extension (`.dat`, `.png`, …) is left alone — only a
 *  path that is really serving JavaScript may be typed as JavaScript. */
function expectedContentType(pathname) {
	const ext = extensionOf(pathname);
	if (ext !== "" && STATIC_MIME.has(ext)) return STATIC_MIME.get(ext);
	if (ext === "" || ext === ".js") {
		if (pathname.startsWith("/plugins/")) return STATIC_MIME.get(".js");
	}
	return null;
}

/** The plugin's own MIME override for a static response, or null to keep the
 *  core's value. Only a response the core could not type — `octet-stream` or
 *  an absent content-type — is retyped: a core that answered a PWA path with
 *  something else (e.g. the SPA shell's `text/html`, when `/sw.js` or an icon
 *  is missing and the index fallback answers) meant it, and calling HTML
 *  JavaScript or an image would be worse than the mismatch. */
function staticContentTypeFor(pathname, headers) {
	const expected = expectedContentType(pathname);
	if (expected === null) return null;
	const current = String(headers?.["content-type"] ?? "").trim().toLowerCase();
	if (current === "" || current.startsWith("application/octet-stream")) return expected;
	return null;
}

/**
 * Service worker scope pin. `index.html` carries `<base href="./">` and the
 * registration uses `{ scope: "./" }`, so both the script URL and the scope
 * resolve against the document's directory — a SPA route opened from an
 * installed app window (`/workspace/x`) would otherwise truncate the scope to
 * `/workspace/`, leaving the app at `/` uncontrolled. `Service-Worker-Allowed`
 * is only meaningful on the worker SCRIPT itself (`/` there lifts the scope to
 * the whole origin); browsers ignore it on documents, so nothing is emitted
 * for them. Returns null when no header belongs on it.
 * @param {number} status - response status (only successful bodies carry a worker).
 */
function serviceWorkerAllowFor(rawPathname, pathname, status) {
	if (status !== 200) return null;
	return rawPathname === "/sw.js" ? "/" : null;
}

/**
 * Case-insensitive `content-encoding` lookup: a compressed body's MIME cannot
 * be rewritten (the type describes the encoded bytes), so callers skip it.
 */
function hasContentEncoding(headers) {
	return Object.keys(headers ?? {}).some((key) => key.toLowerCase() === "content-encoding");
}

/** Case-insensitive presence check for any single header name. */
function hasHeader(headers, name) {
	const wanted = String(name).toLowerCase();
	return Object.keys(headers ?? {}).some((key) => key.toLowerCase() === wanted);
}

/**
 * Did this response actually grow a `Set-Cookie` header? The cookie repair is
 * a side effect of an earlier `appendHeader` on the SAME response, so this is
 * the only truthful answer to "is this response a healed one" — a path-shaped
 * predicate alone cannot know whether `ensureDshAuthCookie` was a no-op.
 * Works through the gzip/`makePwaRes` wrappers: their proxies bind non-wrapper
 * methods (including `getHeader`) to the real ServerResponse.
 * @returns {boolean} true when at least one Set-Cookie header is present.
 */
function hasSetCookieHeader(res) {
	const value = typeof res?.getHeader === "function" ? res.getHeader("set-cookie") : undefined;
	if (value === undefined || value === null) return false;
	return Array.isArray(value) ? value.length > 0 : String(value) !== "";
}

/**
 * Merge PWA headers into one already-resolved header bag (pure; the caller
 * hands the result to `writeHead`). Existing header names keep their casing:
 * node lowercases them on emit, and a mis-cased duplicate would go out as a
 * second header with the SAME value — harmless, but noise.
 * @param {boolean} healCookie - the response also carries a cookie repair, so
 *   it must be uncacheable for browsers AND for the nginx in front of us.
 */
function pwaHeadersFor(rawPathname, pathname, status, headers, { healCookie = false } = {}) {
	const out = headers !== null && typeof headers === "object" ? headers : {};
	const set = (name, value) => {
		for (const key of Object.keys(out)) {
			if (key.toLowerCase() === name) {
				out[key] = value;
				return;
			}
		}
		out[name] = value;
	};
	// The cookie repair takes effect only when the browser actually receives
	// the response, so nothing (proxy_cached, browser HTTP cache) may replay a
	// stored copy of the PWA files or of a healed document.
	if (isPwaAssetPath(rawPathname) || healCookie) set("cache-control", "no-store");
	const allowed = serviceWorkerAllowFor(rawPathname, pathname, status);
	if (allowed !== null) set("service-worker-allowed", allowed);
	if (status === 200 && !hasContentEncoding(out)) {
		const ct = staticContentTypeFor(pathname, out);
		if (ct !== null) set("content-type", ct);
	}
	return out;
}

/**
 * Wrap a response so `writeHead` runs {@link pwaHeadersFor} over the resolved
 * header bag, whichever shape the callee used: the node object form,
 * `writeHead(status, headers)`, or the raw `(status, reason, headerArray)`
 * triple core's http-bridge can emit. Works on both a bare ServerResponse and
 * a `makeGzipRes` wrapper, because it only chains the existing `writeHead`:
 * gzip has already resolved + captured headers by the time the real
 * `res.writeHead` is called, so the rewrite lands in the captured copy.
 * Only `writeHead` is intercepted — a callee that uses `setHeader`/`appendHeader`
 * keeps node's own header machinery untouched.
 * @param {object} res - the response (or gzip wrapper) handed to the handler.
 * @param {(rawPathname: string, pathname: string, status: number) => boolean} [healCookie]
 *   predicate naming the responses that MAY carry a cookie repair. Naming is
 *   not enough: the repair only happened when the response actually grew a
 *   `Set-Cookie` (see {@link hasSetCookieHeader}), so an already-healthy jar —
 *   where `ensureDshAuthCookie` was a no-op — keeps its normal cache policy
 *   instead of being forced `no-store` on every navigation.
 */
function makePwaRes(res, healCookie) {
	const writeHead = res.writeHead;
	if (typeof writeHead !== "function") return res;
	/** Resolve the request path pair once per writeHead (invalid escapes degrade to `/`). */
	const requestPaths = () => {
		try {
			const raw = new URL(res.req?.url ?? "/", "http://dsh.internal").pathname;
			return { raw, decoded: decodeURIComponent(raw) };
		} catch {
			return { raw: "/", decoded: "/" };
		}
	};

	const wrapper = {
		/** `writeHead(status[, reasonPhrase], headers)` — headers as an object or a raw flat array. */
		writeHead(status, ...rest) {
			const { raw, decoded } = requestPaths();
			// Both halves are required: the path must allow a repair AND this
			// response must actually carry the Set-Cookie that repair appends.
			const heal = healCookie?.(raw, decoded, status) === true && hasSetCookieHeader(res);
			const patch = (headers) => pwaHeadersFor(raw, decoded, status, headers, { healCookie: heal });
			// Object form: `writeHead(status, obj)` (node also accepts a bare object).
			const objectForm = rest.find((arg) => arg !== null && typeof arg === "object" && !Array.isArray(arg));
			if (objectForm !== undefined) {
				return writeHead.call(res, status, ...rest.map((arg) => (arg === objectForm ? patch({ ...objectForm }) : arg)));
			}
			// Raw `(status, reason, headerArray)` triple: patch the pairs in place.
			const flat = rest.find((arg) => Array.isArray(arg));
			if (flat === undefined) return writeHead.call(res, status, ...rest);
			const bag = {};
			for (let i = 0; i + 1 < flat.length; i += 2) bag[String(flat[i])] = flat[i + 1];
			const patched = patch(bag);
			const merged = [];
			for (let i = 0; i + 1 < flat.length; i += 2) {
				const name = String(flat[i]);
				merged.push(name, String(patched[name] ?? flat[i + 1]));
			}
			for (const [name, value] of Object.entries(patched)) {
				if (!flat.some((n) => String(n).toLowerCase() === name.toLowerCase())) merged.push(name, String(value));
			}
			return writeHead.call(res, status, ...rest.map((arg) => (arg === flat ? merged : arg)));
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

// ── .docx text extraction (in-app viewer panel) ───────────────────────────────
// A .docx is a ZIP of XML; the panel only needs the words. This is a
// dependency-free best effort: parse the central directory, inflate
// word/document.xml (Node's own zlib), turn paragraph ends into newlines and
// strip the remaining tags. Formatting is lost, content survives. Old `.doc`
// (OLE binary) is NOT supported — those stay download-only.

/** Maximum .docx source accepted for extraction (larger → download only). */
const DOCX_EXTRACT_MAX_BYTES = 64 * 1024 * 1024;
/** Cap on the extracted text served to the browser. */
const DOCX_EXTRACT_MAX_CHARS = 2 * 1024 * 1024;

const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_CD_SIG = 0x02014b50;
const ZIP_LFH_SIG = 0x04034b50;

/**
 * Parse one ZIP central directory (no ZIP64 / encryption / data descriptors).
 * @param {Buffer} buf - the ZIP file bytes.
 * @returns {Map<string, {method: number, dataStart: number, compSize: number}> | null}
 *   entry name → compression method (0 stored / 8 deflate), payload start and
 *   payload size; null on any structural surprise.
 */
export function zipEntries(buf) {
	try {
		// Locate the End Of Central Directory record (comment ≤ 64 KiB).
		let eocd = -1;
		const minEocd = Math.max(0, buf.length - 22 - 65535);
		for (let i = buf.length - 22; i >= minEocd; i--) {
			if (buf.readUInt32LE(i) === ZIP_EOCD_SIG) {
				eocd = i;
				break;
			}
		}
		if (eocd < 0) return null;
		const count = buf.readUInt16LE(eocd + 10);
		let ptr = buf.readUInt32LE(eocd + 16);
		const entries = new Map();
		for (let n = 0; n < count; n++) {
			if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== ZIP_CD_SIG) return null;
			const method = buf.readUInt16LE(ptr + 10);
			const compSize = buf.readUInt32LE(ptr + 20);
			const nameLen = buf.readUInt16LE(ptr + 28);
			const extraLen = buf.readUInt16LE(ptr + 30);
			const commentLen = buf.readUInt16LE(ptr + 32);
			const lfhOffset = buf.readUInt32LE(ptr + 42);
			const name = buf.slice(ptr + 46, ptr + 46 + nameLen).toString("utf8");
			// The local header repeats its own name/extra lengths.
			if (lfhOffset + 30 > buf.length || buf.readUInt32LE(lfhOffset) !== ZIP_LFH_SIG) return null;
			const lfhNameLen = buf.readUInt16LE(lfhOffset + 26);
			const lfhExtraLen = buf.readUInt16LE(lfhOffset + 28);
			entries.set(name, {
				method,
				compSize,
				uncompSize: buf.readUInt32LE(ptr + 24),
				dataStart: lfhOffset + 30 + lfhNameLen + lfhExtraLen
			});
			ptr += 46 + nameLen + extraLen + commentLen;
		}
		return entries;
	} catch {
		return null;
	}
}

/** Turn WordprocessingML into plain text in one linear pass. Regex-stripping
 *  `<[^>]+>` is quadratic on long unclosed `<` runs (a hostile document can
 *  freeze the event loop), so scan manually and only recognise the few tags
 *  that carry text structure. */
function stripDocxXml(xml) {
	let out = "";
	let index = 0;
	while (index < xml.length) {
		const lt = xml.indexOf("<", index);
		if (lt < 0) { out += xml.slice(index); break; }
		out += xml.slice(index, lt);
		const gt = xml.indexOf(">", lt + 1);
		if (gt < 0) break; // unterminated tail: drop it instead of scanning again
		const tag = xml.slice(lt + 1, gt);
		if (/^w:tab\b/i.test(tag)) out += "\t";
		else if (/^w:br\b/i.test(tag)) out += "\n";
		else if (/^\/w:p$/i.test(tag)) out += "\n";
		index = gt + 1;
	}
	return out
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, "\"")
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

/**
 * Extract human-readable plain text from a .docx buffer.
 * @param {Buffer} buf - the whole .docx file.
 * @returns {string | null} the extracted text (capped), null when the
 *   document is too large, not a readable ZIP, or carries no main part.
 */
export function extractDocxText(buf) {
	try {
		if (!(buf instanceof Buffer) || buf.length === 0 || buf.length > DOCX_EXTRACT_MAX_BYTES) return null;
		const entries = zipEntries(buf);
		const entry = entries && entries.get("word/document.xml");
		if (!entry) return null;
		const payload = buf.slice(entry.dataStart, entry.dataStart + entry.compSize);
		// Cap the declared and actual inflation size: a tiny ZIP can expand
		// ~1000×, so an unbounded inflate is an OOM kill for any authenticated
		// user. The panel only needs text, never gigabytes.
		const maxInflated = DOCX_EXTRACT_MAX_CHARS * 4;
		if (entry.uncompSize > maxInflated) return null;
		let xml;
		if (entry.method === 0) xml = payload;
		else if (entry.method === 8) xml = inflateRawSync(payload, { maxOutputLength: maxInflated });
		else return null;
		const text = stripDocxXml(xml.toString("utf8"));
		return text.length > DOCX_EXTRACT_MAX_CHARS
			? text.slice(0, DOCX_EXTRACT_MAX_CHARS) + "\n…"
			: text;
	} catch {
		return null;
	}
}

/**
 * Is a requested absolute path inside one of the allowed roots (DSH home,
 * process cwd, plus `extraRoots`)? Symlink escapes are neutralized by
 * comparing realpaths. Exported for tests.
 *
 * Windows note: the filesystem is case-insensitive but realpath returns one
 * canonical spelling, so a root configured as `E:\CODE` may realpath to
 * `E:\code`. Comparisons are therefore case-folded on win32 (override via
 * options.caseInsensitive for tests on case-sensitive hosts).
 * @returns {ok, real, reason} — reason is a stable short code for tests.
 */
function checkFilePathAgainst(rawPath, extraRoots = [], options = {}) {
	if (typeof rawPath !== "string" || rawPath.trim() === "") return { ok: false, reason: "no-path" };
	if (rawPath.includes("\u0000")) return { ok: false, reason: "outside-roots" };
	// Reject Windows UNC / device paths up front: resolving or statting `\\host\share`
	// would make the HOST open an outbound SMB connection (NTLMv2 leak) and stall
	// the event loop. On POSIX a leading `//` is also non-canonical, so denying it
	// is safe and keeps both platforms on the same rule.
	if (/^[\\/]{2}/.test(rawPath)) return { ok: false, reason: "outside-roots" };
	const roots = fileRootsFor(extraRoots);
	const caseInsensitive = options.caseInsensitive ?? process.platform === "win32";
	const norm = caseInsensitive ? (value) => value.toLowerCase() : (value) => value;
	const sameOrInside = (candidate, root) => norm(candidate) === norm(root) || norm(candidate).startsWith(norm(root) + sep);
	const within = (candidate) => roots.some((root) => sameOrInside(candidate, root));
	// Lexical roots use the CONFIGURED spellings (symlinked spellings like
	// /var vs /private/var must not look "outside" before realpath runs), while
	// the realpath containment check above uses the resolved canonical roots.
	const lexicalRoots = [dshHomePath(), process.cwd(), ...extraRoots]
		.filter((entry) => typeof entry === "string" && entry !== "")
		.map((entry) => resolve(entry));
	const lexicallyWithin = (candidate) => lexicalRoots.some((root) => sameOrInside(candidate, root));
	// 1) Lexical containment first: a path that resolves outside every root is
	//    rejected WITHOUT touching the filesystem, so the endpoint cannot be
	//    used as an existence/type oracle for arbitrary host paths. A configured
	//    root reached through a symlinked spelling (macOS /var vs /private/var)
	//    can fail this lexical test while being physically inside the root, so
	//    resolve the realpath once and require the canonical containment below.
	const resolved = resolve(rawPath);
	let real = null;
	if (!lexicallyWithin(resolved)) {
		try {
			const candidate = realpathSync(resolved);
			if (within(candidate)) real = candidate; // canonical spelling inside a root
		} catch {
			// unresolvable outside-root probe: same answer as a nonexistent path
		}
		if (real === null) return { ok: false, reason: "outside-roots" };
	}
	// 2) Resolve symlinks, then re-check: a symlink inside a root that points
	//    elsewhere must not escape it.
	if (real === null) {
		try {
			real = realpathSync(resolved);
		} catch {
			return { ok: false, reason: "not-found" };
		}
	}
	if (!within(real)) return { ok: false, reason: "outside-roots" };
	let st;
	try {
		st = statSync(real);
	} catch {
		return { ok: false, reason: "not-found" };
	}
	if (!st.isFile() && !st.isDirectory()) return { ok: false, reason: "not-a-file" };
	return { ok: true, real, isDirectory: st.isDirectory(), size: st.isFile() ? st.size : undefined };
}

/** Extra hardening headers for the server-rendered login page (clickjacking,
 *  MIME sniffing, referrer leakage). */
const loginPageHeaders = () => ({
	"X-Frame-Options": "DENY",
	"Referrer-Policy": "no-referrer",
	"X-Content-Type-Options": "nosniff"
});

/** Lower-case header names for Fetch Response header bags. */
const mapHeaderCase = (headers) => Object.fromEntries(
	Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
);

/** Constant-time equality for two secret strings (length mismatch is safe to leak). */
function secretsMatch(a, b) {
	const left = Buffer.from(String(a ?? ""), "utf8");
	const right = Buffer.from(String(b ?? ""), "utf8");
	return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

// ── plugin ────────────────────────────────────────────────────────────────────

function apply(ctx, config) {
	const cfg = config;
	const store = new AccountStore(config.storePath ?? defaultStorePath());
	store.load();
	// Runtime-editable allowed-file roots (the settings UI's "允许的目录"):
	// layered on top of config `files.roots`. Loosely coupled to the account
	// store — same file-store conventions, separate file.
	const filesRoots = new FilesRootsStore(config.filesRootsPath ?? filesRootsPath());
	filesRoots.load();
	// Administrator-managed path prefixes for plugin endpoints that perform
	// their own authentication (for example a key-authenticated MCP bridge).
	const anonymousPaths = new AnonymousPathsStore(config.anonymousPathsPath ?? anonymousPathsPath());
	anonymousPaths.load();
	// First-admin bootstrap credential. A configured value (or the
	// DSH_REMOTE_BOOTSTRAP_TOKEN env) wins; otherwise a fresh random token is
	// minted per process, logged, and written to a 0600 file under $DSH_HOME.
	// Optional bootstrap secret for proxied fresh deployments. When absent the
	// familiar local username+password flow stays available; the token is never
	// auto-generated, logged, or stored on disk.
	const envBootstrapToken = String(process.env.DSH_REMOTE_BOOTSTRAP_TOKEN ?? "").trim();
	const configuredBootstrapToken = cfg.bootstrapToken !== "" ? cfg.bootstrapToken : envBootstrapToken;
	if (configuredBootstrapToken !== "" && configuredBootstrapToken.length < 16) {
		throw new Error("dsh-remote: bootstrapToken must be at least 16 characters");
	}
	const isConfiguredAnonymousPath = (pathname) => matchesAnonymousPath(pathname, anonymousPaths.list());

	// Seed accounts from the composition (plaintext passwords are hashed once
	// and persisted; existing store entries are never overwritten). In
	// admin-only mode every seeded account is forced to the admin role.
	for (const seed of cfg.accounts) {
		if (store.find(seed.username)) continue;
		const passwordHash = seed.password.startsWith("scrypt$") ? seed.password : hashPasswordSync(seed.password);
		store.upsert({ username: seed.username, role: cfg.adminOnly ? "admin" : seed.role, passwordHash });
	}

	// Config bootstrap (headless servers): alternatively seed the first admin
	// here so a box without access to the startup log can provision itself; the
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
	// dsh 0.2.3 adds WebServer route authentication backed by this registry.
	// Do not trust `route.auth` on older dsh versions, where it is only an
	// ignored plugin field and must not silently widen the dsh-remote gate.
	let coreRouteAuthAvailable = false;
	let coreAuthentication = null;
	let gateActive = true;
	const internalResourceReads = new WeakSet();

	// ── dsh browser-session cookie minting (issue #10) ──────────────────────────
	// On dsh ≥ 0.1.2-alpha, /api and index.html are gated behind a persistent
	// Host-bound cookie minted by client-connection's browserAuth. Remote
	// browsers can never hold the cookie bound to the loopback authority the
	// gate normalizes requests to (and never hold the launch token to mint
	// it), so this plugin mints the cookies itself, signed with the SAME
	// persisted secret client-connection uses. The `credentials` service does
	// not exist on every dsh build/runtime this plugin supports, so it is
	// resolved opportunistically — when absent, minting stays off and
	// behavior is exactly the pre-fix one.
	let credentialsProvider = null;
	try {
		ctx.inject(["credentials"], (credCtx) => {
			credentialsProvider = credCtx.credentials ?? null;
		});
	} catch {
		// Older runtimes without context.inject semantics: stay mint-free.
	}

	/** Authority the CORE sees on gated HTTP/upgrade requests (post-normalization). */
	const gatedAuthority = () => (cfg.trustProxy
		? `127.0.0.1:${webServer.port ?? "3080"}`
		: null);
	/** Authority the CORE sees on fallback/index requests (never normalized). */
	const originalAuthority = (req) => canonicalAuthority(req[ORIGINAL_HOST] ?? req.headers.host);

	// Secret cache: the record lives in credentials-local's memory map, but the
	// provider may back onto disk/IPC, so keep a short positive TTL; a negative
	// probe (old dsh without the record) backs off much longer.
	let secretCache = null;
	let lastMissAt = 0;
	const SECRET_POSITIVE_TTL_MS = 30 * 1000;
	const SECRET_MISS_TTL_MS = 5 * 60 * 1000;
	const browserAuthSecret = async () => {
		if (!cfg.browserAuth.enabled || credentialsProvider === null) return null;
		const now = Date.now();
		if (secretCache !== null && now - secretCache.at < SECRET_POSITIVE_TTL_MS) return secretCache.value;
		if (now - lastMissAt < SECRET_MISS_TTL_MS) return null;
		try {
			const record = await credentialsProvider.readRecord(BROWSER_SESSION_RECORD_KEY);
			const value = readBrowserAuthSecret(record);
			if (value !== null) {
				secretCache = { value, at: now };
				return value;
			}
		} catch {
			// Provider differences must never break the request path.
		}
		lastMissAt = now;
		return null;
	};

	/** Minted-cookie window: config override, else follow the session TTL. */
	const cookieTtlMs = () => {
		const seconds = cfg.browserAuth.cookieTtlSeconds > 0
			? cfg.browserAuth.cookieTtlSeconds
			: cfg.session.ttlSeconds;
		// The core hard-rejects windows beyond its cookieMaxAgeDays (30 by
		// default) — stay inside that bound no matter how session TTL is set.
		return Math.min(seconds, BROWSER_COOKIE_MAX_AGE_DAYS_DEFAULT * 24 * 60 * 60) * 1000;
	};

	/**
	 * Mint one dsh-auth cookie onto the response when the request does not
	 * already carry a live one for `authority` (core-minted or our own), AND
	 * make that same cookie visible to the core inside THIS request.
	 *
	 * Why both: the Set-Cookie only reaches the browser's jar, so the core
	 * handled the current request before that jar changed and answered 401
	 * ("dsh web authentication required") to the very navigation that minted
	 * the cookie — the phone PWA cold start showed that plain-text error on
	 * screen. Injecting the freshly minted value into `req.headers.cookie`
	 * closes that gap: the core's `authorizeIndex`/`authorizeApi` reads the
	 * request headers, so the first navigation authenticates immediately.
	 *
	 * The injection replaces any same-named segment (see `cookieHeaderSet`):
	 * a stale-but-present cookie is exactly when `hasLiveDshAuthCookie` is
	 * false, and the core stops at the FIRST matching segment. Other cookies
	 * (`dsh_session` included) are preserved in place.
	 *
	 * Safe to call with the raw res or the gzip wrapper — both forward
	 * setHeader-time headers into writeHead — and a no-op while headers are
	 * already sent. Only the in-memory request object changes; nothing besides
	 * the Set-Cookie header leaves the process.
	 */
	// [fix:remote-cookie-heal] Heal the cookie bound to the authority the CORE sees.
	// normalizeForFence() rewrites Host to the loopback authority for every
	// gated /api and upgrade request, so those paths ask the core for
	// dsh-auth-<sha256(loopback)> — not the original (public) authority.
	const ensureLoopbackDshAuthCookie = async (res, req) => {
		const loopbackAuthority = gatedAuthority();
		if (loopbackAuthority === null) return;
		await ensureDshAuthCookie(res, req, loopbackAuthority);
	};

	const ensureDshAuthCookie = async (res, req, authority) => {
		if (authority === null || res.headersSent) return;
		const mintedSecret = await browserAuthSecret();
		if (mintedSecret === null) return;
		if (hasLiveDshAuthCookie(req.headers.cookie, authority, mintedSecret)) return;
		const { name, value, cookie } = encodeDshAuthCookie(authority, mintedSecret, cookieTtlMs());
		// Inject only when the Set-Cookie really went out: an injection without
		// the matching response header would authenticate this one request and
		// then lose the browser again on the next one, which is worse than the
		// plain 401 (it hides the broken jar). `appendHeader` exists since
		// node 18.17; on anything older the plugin stays in its old shape.
		if (typeof res.appendHeader !== "function") return;
		res.appendHeader("Set-Cookie", cookie);
		// The core sees the request's headers, not the browser's cookie jar:
		// without this the current request still authenticates as a stranger.
		req.headers.cookie = cookieHeaderSet(req.headers.cookie, name, value);
	};

	/**
	 * Login/bootstrap/MFA success: hand the browser every dsh-auth cookie the
	 * core may demand from it — one bound to the original (public) Host for
	 * the fallback/index path, and (when the gate normalizes) one bound to the
	 * loopback authority for /api and the WebSocket upgrade.
	 */
	const setLoginDshAuthCookies = async (req, res) => {
		if (!cfg.browserAuth.enabled) return;
		const mintedSecret = await browserAuthSecret();
		if (mintedSecret === null) return;
		const original = originalAuthority(req);
		const loopback = gatedAuthority();
		const authorities = original === null ? [] : [original];
		if (loopback !== null && loopback !== original) authorities.push(loopback);
		for (const authority of authorities) {
			const { cookie } = encodeDshAuthCookie(authority, mintedSecret, cookieTtlMs());
			res.appendHeader?.("Set-Cookie", cookie);
		}
	};

	// ── session signing ─────────────────────────────────────────────────────────
	const issueSession = (account) => {
		const payload = {
			sub: account.username,
			role: account.role ?? "user",
			ver: account.sessionEpoch ?? 0,
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
		return { username: payload.sub, role, ver: typeof payload.ver === "number" ? payload.ver : 0 };
	};

	const requireAuth = (req) => {
		const token = readCookie(req, cfg.session.cookieName);
		if (!token) return { ok: false };
		const session = verifySession(token);
		if (!session) return { ok: false };
		// A removed account must not keep working through a stale cookie.
		const account = store.find(session.username);
		if (!account) return { ok: false };
		// Logout and password resets bump the epoch, invalidating every older token.
		if ((account.sessionEpoch ?? 0) !== session.ver) return { ok: false };
		return { ok: true, user: { username: account.username, role: account.role ?? "user" } };
	};

	/** Legacy (pre-0.2.3) admitted in-process read: the host passes a Peer but
	 *  there is no Core authentication service, and the request carries no
	 *  dsh-remote session cookie. Modern hosts never satisfy this: a request
	 *  that arrives with a browser session still passes the gate above. */
	const legacyAdmittedPeer = (request, peer) => peer !== undefined
		&& !coreRouteAuthAvailable
		&& readCookie(nodeReqView(request), cfg.session.cookieName) === null;

	/** Resolve the Core Peer issued for this already dsh-remote-authenticated request. */
	const corePeerForRequest = (req) => {
		if (typeof coreAuthentication?.authenticate !== "function") return undefined;
		try {
			const admission = coreAuthentication.authenticate({
				headers: req.headers,
				method: req.method,
				url: req.url,
				signal: req.signal,
				socket: req.socket
			});
			return admission && "peer" in admission ? admission.peer : undefined;
		} catch {
			return undefined;
		}
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

	const isSecureRequest = (req) => req?.socket?.encrypted === true
		|| String(req?.headers?.["x-forwarded-proto"] ?? "").split(",")[0].trim().toLowerCase() === "https";

	const setSessionCookie = (res, token, req) => {
		const c = cfg.session;
		const parts = [`${c.cookieName}=${token}`, "Path=/", "HttpOnly", `Max-Age=${c.ttlSeconds}`, `SameSite=${c.sameSite}`];
		if (c.secure || isSecureRequest(req)) parts.push("Secure");
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
	// Equalise the cost of a login probe for a missing account: without this the
	// scrypt work only happens for real usernames, leaking account existence by
	// response timing.
	const decoyPasswordHash = hashPasswordSync(generateSecret());
	/** Client address for rate limiting: the first X-Forwarded-For hop only when
	 *  the deployment explicitly declares a trusted reverse proxy. */
	const clientAddress = (req) => {
		if (cfg.trustProxy) {
			// The RIGHT-most hop is the one the trusted reverse proxy appended;
			// earlier entries are client-controlled and would let an attacker
			// pick a fresh rate-limit bucket per request.
			const hops = String(req.headers["x-forwarded-for"] ?? "").split(",").map((v) => v.trim()).filter(Boolean);
			if (hops.length > 0) return hops[hops.length - 1];
		}
		return req.socket.remoteAddress ?? "unknown";
	};
	const rateKey = (req, username) => `${clientAddress(req)}:${username}`;
	const checkRate = (key) => {
		const now = Date.now();
		if (attempts.size >= 2048) {
			for (const [candidate, value] of attempts) if (value.resetAt <= now) attempts.delete(candidate);
		}
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
		const body = req.method === "POST"
			? await readBodyBounded(req, 16 * 1024 * 1024)
			: null;
		return evaluateRoleGate(pathname, req.method, body, role);
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
		const gated = async (req, res, peer) => {
			if (isPublicPath(pathnameOf(req)) || isConfiguredAnonymousPath(rawPathnameOf(req))) return handler(req, res, peer);
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
			// Self-heal the dsh browser-session cookie (issue #10): sessions
			// created before this fix — or browsers whose minted cookie was
			// evicted — carry only dsh_session, so the core's browserAuth
			// 401s every /api call. `ensureDshAuthCookie` both appends the
			// minted cookie (repairing the jar for later calls) and injects it
			// into THIS request's Cookie header, so the very first call after
			// the loss already passes the core check. The Host was normalized
			// just above, so the cookie is bound to the loopback authority —
			// exactly the one the core derives for this request.
			await ensureDshAuthCookie(outRes, req, gatedAuthority() ?? originalAuthority(req));
			const downstreamPeer = peer ?? corePeerForRequest(req);
			if (cfg.enforceRoles && verdict.user.role !== "admin") {
				const gate = await roleGate(req, verdict.user.role);
				if (!gate.allowed) {
					denyRpcEnvelope(outRes, gate.body, "forbidden for role " + verdict.user.role);
					return;
				}
				if (gate.replayed) return handler(replayable(req, gate.body), outRes, downstreamPeer);
			}
			return handler(req, outRes, downstreamPeer);
		};
		Object.defineProperty(gated, GATED, { value: true });
		wrappedOriginals.set(gated, handler);
		return gated;
	};

	const wrapUpgrade = (handler) => {
		if (typeof handler !== "function" || handler[GATED]) return handler;
		const gated = (req, socket, head, peer) => {
			if (isConfiguredAnonymousPath(rawPathnameOf(req))) {
				return handler(req, socket, head, peer);
			}
			if (!requireAuth(req).ok) {
				// [fix:remote-cookie-heal] Answer with a real 401. socket.destroy() produced a zero-byte
				// disconnect that reads as a proxy/network failure and hides the cause.
				if (!socket.writable || socket.destroyed) {
					socket.destroy();
					return;
				}
				const body = "unauthorized";
				socket.end(
					[
						"HTTP/1.1 401 Unauthorized",
						"Connection: close",
						"Content-Type: text/plain; charset=utf-8",
						`Content-Length: ${String(Buffer.byteLength(body))}`,
						"",
						body
					].join("\r\n")
				);
				return;
			}
			normalizeForFence(req);
			const downstreamPeer = peer ?? corePeerForRequest(req);
			return handler(req, socket, head, downstreamPeer);
		};
		Object.defineProperty(gated, GATED, { value: true });
		wrappedOriginals.set(gated, handler);
		return gated;
	};

	const wrapFallback = (handler) => {
		if (typeof handler !== "function" || handler[GATED]) return handler;
		const gated = async (req, res, peer) => {
			const pageRequest = req.method === "GET" || req.method === "HEAD";
			const rawPathname = rawPathnameOf(req);
			if (!requireAuth(req).ok) {
				if (isConfiguredAnonymousPath(rawPathname)) {
					captureOriginalHost(req);
					let outRes = res;
					if (cfg.gzip.enabled) outRes = makeGzipRes(res, req, cfg.gzip);
					return handler(req, makePwaRes(outRes), peer);
				}
				// PWA static plane: the service worker fetches `sw.js`, the manifest
				// and the icons BEFORE any navigation, so these three paths answer
				// without a dsh-remote session — and they mint NO cookie: signing a
				// Host-bound dsh-auth cookie for an anonymous GET would hand the
				// core's browserAuth to any visitor, and an unauthenticated caller
				// has no dsh_session that could use it (the gate still fronts /api).
				// The cookie repair lives on AUTHENTICATED document responses only.
				// This PWA exception opens only these paths. Other assets, /api and
				// unmatched paths still need the gate unless an admin explicitly
				// configured a plugin endpoint prefix above.
				if (pageRequest && isPwaAssetPath(rawPathname)) {
					captureOriginalHost(req);
					let outRes = res;
					if (cfg.gzip.enabled) {
						outRes = makeGzipRes(res, req, cfg.gzip);
					}
					return handler(req, makePwaRes(outRes), peer);
				}
				if (pageRequest) {
					const pathname = pathnameOf(req);
					// i18n: prefer the app-level language preference (the same
					// value the DSH shell follows); otherwise fall back to the
					// browser's Accept-Language (zh for any zh-* tag, else en).
					const lang = loginPageLang(req.headers);
					res.writeHead(200, {
						"Content-Type": "text/html; charset=utf-8",
						"Cache-Control": "no-store",
						...loginPageHeaders()
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
			const pathname = decodedPathname(req) ?? pathnameOf(req);
			const tokenInUrl = searchParamGet(req.url, "token") !== null;
			// Self-heal the ORIGINAL-Host-bound dsh-auth cookie (issue #10): the
			// core's index/SPA path (frontend-static → authorizeIndex) validates
			// against the un-normalized Host, so DOCUMENT responses carry the
			// re-mint when the jar lost it. Documents are the SPA routes, `.html`
			// pages and the PWA shell files — an app that reports a lost cookie
			// heals on its first screen load, not only on the next navigation:
			// `ensureDshAuthCookie` injects the minted cookie into this
			// request's Cookie header as well, so the navigation that triggered
			// the repair is itself authenticated (a cold PWA start no longer
			// lands on the core's plain-text 401).
			// Extension-bearing assets, /api and the core's `?token=` minting
			// are left untouched (no cookie, and their caches stay as they are).
			// The predicate below only names WHO may be repaired; `makePwaRes`
			// additionally requires the Set-Cookie to be on the response, so a
			// healthy jar keeps its ordinary cache policy.
			if (pageRequest && !tokenInUrl && (isPwaAssetPath(rawPathname) || isDocumentPath(pathname))) {
				await ensureDshAuthCookie(outRes, req, originalAuthority(req));
				// [fix:remote-cookie-heal] A page load must also restore the loopback cookie: the mux
				// upgrade cannot be admitted without it, and this is the only document
				// request that can mint it.
				await ensureLoopbackDshAuthCookie(outRes, req);
			}
			const downstreamPeer = peer ?? corePeerForRequest(req);
			return handler(req, makePwaRes(outRes, (raw, decoded) => pageRequest
				&& !tokenInUrl
				&& (isPwaAssetPath(raw) || isDocumentPath(decoded))), downstreamPeer);
		};
		Object.defineProperty(gated, GATED, { value: true });
		wrappedOriginals.set(gated, handler);
		return gated;
	};

	const unwrap = (handler) => wrappedOriginals.get(handler) ?? handler;

	// ── resource-mode gate (dsh ≥ 0.2.2-alpha: Fetch Request/Response) ───────────
	// dsh 0.2.2-alpha refactored the webserver so a route or the fallback seat may
	// be a "resource" — `(request, peer?) => Promise<Response>` — instead of a
	// node:http handler. frontend-static now claims the fallback seat with a
	// resource, and /plugins/* is a resource prefix route. The node wrappers above
	// cannot see a resource (`typeof x !== "function"`), so they silently left it
	// unwrapped — which removed the login gate entirely: an unauthenticated
	// visitor fell through to the core's frontend-static, whose `authorizeIndex`
	// then demanded the launch token the terminal prints (`dsh web: …?token=`).
	// These mirror the same policy in Fetch terms so both generations are gated.

	/** Fold a Fetch Request into the node-style request view the gate reads. */
	const nodeReqView = (request) => {
		const headers = {};
		for (const [name, value] of request.headers) headers[name.toLowerCase()] = value;
		let url = "/";
		try {
			const parsed = new URL(request.url);
			url = parsed.pathname + parsed.search;
		} catch {
			// unparsable target cannot carry the core's ?token= anyway
		}
		return { url, method: request.method, headers, socket: { remoteAddress: undefined } };
	};

	/** A JSON Fetch response for the resource path (mirrors denyJson). */
	const jsonResource = (status, body) => new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
	});

	/** Mint the core's dsh-auth cookie for `authority` onto THIS request when the
	 *  jar lacks a live one, returning the Set-Cookie line for the response (or
	 *  null). Mirrors ensureDshAuthCookie in Fetch terms: the request header is
	 *  rewritten so the core's authorizeIndex authenticates the same navigation. */
	const mintDshAuthCookie = async (request, authority) => {
		if (authority === null) return null;
		const mintedSecret = await browserAuthSecret();
		if (mintedSecret === null) return null;
		const cookieHeader = request.headers.get("cookie") ?? undefined;
		if (hasLiveDshAuthCookie(cookieHeader, authority, mintedSecret)) return null;
		const { name, value, cookie } = encodeDshAuthCookie(authority, mintedSecret, cookieTtlMs());
		request.headers.set("cookie", cookieHeaderSet(cookieHeader, name, value));
		return cookie;
	};

	/** Re-emit a Fetch response with the PWA/cache header policy (and any minted
	 *  Set-Cookie) applied — the resource-path analogue of makePwaRes. */
	const patchResourceResponse = (response, rawPathname, pathname, { healCookie = false, setCookie = null } = {}) => {
		const bag = {};
		for (const [name, value] of response.headers) {
			if (name.toLowerCase() === "set-cookie") continue;
			bag[name] = value;
		}
		const patched = pwaHeadersFor(rawPathname, pathname, response.status, bag, { healCookie });
		const headers = new Headers(patched);
		const existing = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
		for (const cookie of existing) headers.append("set-cookie", cookie);
		if (setCookie !== null) headers.append("set-cookie", setCookie);
		return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
	};

	const wrapResourceFallback = (resource) => {
		if (typeof resource !== "function") return resource;
		const gated = async (request, peer) => {
			// dsh ≥ 0.2.2 `webServer.readResource(request, peer)`: the CALLER already
			// admitted this Peer before reading — the host contract is explicit that
			// such an in-process read checks no cookie, Host or Origin (webserver
			// README "readResource"; frontend-static renders for that Peer). An
			// admitted read is not a remote visitor's request, so the session gate
			// must not run: authenticate on the request only when it carries no
			// Peer, and never mint a browser cookie for a reader that has no jar.
			if (internalResourceReads.has(request) || legacyAdmittedPeer(request, peer)) return resource(request, peer);
			const reqView = nodeReqView(request);
			const pageRequest = request.method === "GET" || request.method === "HEAD";
			const rawPathname = rawPathnameOf(reqView);
			const pathname = pathnameOf(reqView);
			if (isConfiguredAnonymousPath(rawPathname)) return resource(request, peer);
			const verdict = requireAuth(reqView);
			if (!verdict.ok) {
				// PWA static plane: the manifest, worker and icons answer before a
				// dsh-remote session and mint NO cookie — the core serves these
				// non-index files publicly, so just forward and re-apply the PWA
				// cache/MIME policy.
				if (pageRequest && isPwaAssetPath(rawPathname)) {
					return patchResourceResponse(await resource(request, peer), rawPathname, pathname);
				}
				if (pageRequest) {
					const lang = loginPageLang(reqView.headers);
					return new Response(renderLoginPage({
						bootstrap: !store.hasAccounts,
						next: pathname === "/" ? "/" : pathname,
						lang
					}), { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...mapHeaderCase(loginPageHeaders()) } });
				}
				return jsonResource(403, { ok: false, error: "unauthorized" });
			}
			// Authenticated: forward, healing the core's dsh-auth cookie on the
			// documents/PWA shell (the resource the core gates), bound to the
			// authority the core sees — the ORIGINAL Host (the fallback is never
			// normalized). `?token=` mints handled by the core itself.
			const effectivePath = decodedPathname(reqView) ?? pathname;
			const tokenInUrl = searchParamGet(reqView.url, "token") !== null;
			const pageHeal = pageRequest && !tokenInUrl && (isPwaAssetPath(rawPathname) || isDocumentPath(effectivePath));
			const setCookie = pageHeal ? await mintDshAuthCookie(request, originalAuthority(reqView)) : null;
			const downstreamPeer = peer ?? corePeerForRequest(nodeReqView(request));
			const response = await resource(request, downstreamPeer);
			return patchResourceResponse(response, rawPathname, effectivePath, { healCookie: pageHeal && setCookie !== null, setCookie });
		};
		Object.defineProperty(gated, GATED, { value: true });
		wrappedResourceOriginals.set(gated, resource);
		return gated;
	};

	/** Gate a non-fallback resource route: a dsh-remote session is required,
	 *  exactly as wrapHttp requires it for a node handler route. */
	const wrapResourceHttp = (resource, route) => {
		if (typeof resource !== "function") return resource;
		const gated = async (request, peer) => {
			// dsh 0.2.3 passes a Peer to both HTTP resources and in-process reads.
			// Mark readResource() calls separately so an HTTP Remote Peer cannot
			// replace the dsh-remote password/MFA gate.
			if (internalResourceReads.has(request) || legacyAdmittedPeer(request, peer)) {
				return resource(request, peer);
			}
			const reqView = nodeReqView(request);
			const rawPathname = rawPathnameOf(reqView);
			if (isConfiguredAnonymousPath(rawPathname)) return resource(request, peer);
			const verdict = requireAuth(reqView);
			if (!verdict.ok) {
				const pageRequest = request.method === "GET" || request.method === "HEAD";
				if (coreRouteAuthAvailable && route?.kind === "exact" && route.path === "/"
					&& route.auth === "anonymous" && pageRequest) {
					const pathname = pathnameOf(reqView);
					const lang = loginPageLang(reqView.headers);
					return new Response(request.method === "HEAD" ? null : renderLoginPage({
						bootstrap: !store.hasAccounts,
						next: pathname === "/" ? "/" : pathname,
						lang
					}), { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...mapHeaderCase(loginPageHeaders()) } });
				}
				return jsonResource(403, { ok: false, error: "unauthorized" });
			}
			const remoteRoot = coreRouteAuthAvailable && route?.kind === "exact"
				&& route.path === "/" && route.auth === "anonymous";
			const setCookie = remoteRoot ? await mintDshAuthCookie(request, originalAuthority(reqView)) : null;
			const downstreamPeer = peer ?? (remoteRoot ? corePeerForRequest(nodeReqView(request)) : undefined);
			let forwardedRequest = request;
			if (remoteRoot) {
				const url = new URL(request.url);
				if (url.searchParams.get("login") === "qr") {
					url.searchParams.delete("login");
					forwardedRequest = new Request(url, {
						method: request.method,
						headers: request.headers,
						signal: request.signal
					});
				}
			}
			const response = await resource(forwardedRequest, downstreamPeer);
			return setCookie === null
				? response
				: patchResourceResponse(response, rawPathname, decodedPathname(reqView) ?? pathname, { setCookie });
		};
		Object.defineProperty(gated, GATED, { value: true });
		wrappedResourceOriginals.set(gated, resource);
		return gated;
	};

	const isResourceRoute = (route) => route !== null && typeof route === "object" && typeof route.resource === "function";
	const isResourceFallback = (fallback) => fallback !== null && typeof fallback === "object" && typeof fallback.resource === "function";
	const isHandlerFallback = (fallback) => fallback !== null && typeof fallback === "object" && typeof fallback.handler === "function";
	const unwrapResource = (resource) => wrappedResourceOriginals.get(resource) ?? resource;
	const prepareCoreRouteAuth = (route) => {
		if (!coreRouteAuthAvailable || route === null || typeof route !== "object"
			|| route.auth === "anonymous" || route.auth === "deny" || wrappedRouteAuthOriginals.has(route)) return route;
		const originalAuth = route.auth;
		route.auth = (request) => {
			const policy = typeof originalAuth === "function" ? originalAuth(request) : (originalAuth ?? "required");
			if (policy === "deny") return policy;
			const pathname = request?.url instanceof URL ? request.url.pathname : "";
			if (isConfiguredAnonymousPath(pathname)) return "anonymous";
			return policy;
		};
		wrappedRouteAuthOriginals.set(route, originalAuth);
		return route;
	};
	const unwrapCoreRouteAuth = (route) => {
		if (route !== null && typeof route === "object" && wrappedRouteAuthOriginals.has(route)) {
			route.auth = wrappedRouteAuthOriginals.get(route);
			wrappedRouteAuthOriginals.delete(route);
		}
	};
	const unwrapFallbackSeat = (fallback) => {
		if (fallback !== null && typeof fallback === "object") return wrappedFallbackOriginals.get(fallback) ?? fallback;
		return unwrap(fallback);
	};
	const fallbackHostAuth = (auth) => {
		if (!coreRouteAuthAvailable || auth === "deny") return auth;
		if (typeof auth === "function") return (request) => auth(request) === "deny" ? "deny" : "anonymous";
		return "anonymous";
	};
	const wrapFallbackSeat = (fallback) => {
		if (fallback === null || fallback === undefined) return fallback;
		if (typeof fallback === "function") {
			const original = unwrap(fallback);
			const handler = wrapFallback(original);
			if (!coreRouteAuthAvailable) return handler;
			const wrapped = { handler, auth: "anonymous" };
			wrappedFallbackOriginals.set(wrapped, original);
			return wrapped;
		}
		if (typeof fallback !== "object") return fallback;
		const previouslyWrapped = wrappedFallbackOriginals.get(fallback);
		if (previouslyWrapped !== undefined) return fallback;
		if (isResourceFallback(fallback)) {
			const wrapped = { ...fallback, resource: wrapResourceFallback(fallback.resource) };
			if (coreRouteAuthAvailable) wrapped.auth = fallbackHostAuth(fallback.auth);
			wrappedFallbackOriginals.set(wrapped, fallback);
			return wrapped;
		}
		if (isHandlerFallback(fallback)) {
			const wrapped = { ...fallback, handler: wrapFallback(fallback.handler) };
			if (coreRouteAuthAvailable) wrapped.auth = fallbackHostAuth(fallback.auth);
			wrappedFallbackOriginals.set(wrapped, fallback);
			return wrapped;
		}
		return fallback;
	};

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
		const ok = await verifyPassword(password, account?.passwordHash ?? decoyPasswordHash);
		if (account === null || !ok) {
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
		setSessionCookie(res, issueSession(account), req);
		await setLoginDshAuthCookies(req, res);
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
		setSessionCookie(res, issueSession(account), req);
		await setLoginDshAuthCookies(req, res);
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
		// A session cookie alone must not be able to start (or restart) the
		// binding: require the account password, and refuse to overwrite an
		// already-active factor (that path is /auth/mfa/disable, which demands
		// the password AND a live code).
		if (account.totp?.verified === true) {
			denyJson(res, 409, "mfa is already active; disable it first");
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
		if (!password) {
			denyJson(res, 400, "current password is required to enable mfa");
			return;
		}
		const setupKey = rateKey(req, "mfa-setup:" + account.username);
		const setupRate = checkRate(setupKey);
		if (!setupRate.ok) {
			denyJson(res, 429, `too many attempts; retry in ${setupRate.retryAfter}s`, { retryAfter: setupRate.retryAfter });
			return;
		}
		if (!(await verifyPassword(password, account.passwordHash))) {
			recordFailure(setupKey);
			denyJson(res, 401, "current password is required to enable mfa");
			return;
		}
		clearRate(setupKey);
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
		const verifyKey = rateKey(req, "mfa-verify:" + verdict.user.username);
		const verifyRate = checkRate(verifyKey);
		if (!verifyRate.ok) {
			denyJson(res, 429, `too many attempts; retry in ${verifyRate.retryAfter}s`, { retryAfter: verifyRate.retryAfter });
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
		const disableKey = rateKey(req, "mfa-disable:" + account.username);
		const disableRate = checkRate(disableKey);
		if (!disableRate.ok) {
			denyJson(res, 429, `too many attempts; retry in ${disableRate.retryAfter}s`, { retryAfter: disableRate.retryAfter });
			return;
		}
		const passwordOk = await verifyPassword(password, account.passwordHash);
		if (!passwordOk) {
			recordFailure(disableKey);
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
		// Revoke server-side, not just the browser cookie: a copied token must
		// stop working the moment its owner logs out.
		const verdict = requireAuth(req);
		if (verdict.ok) {
			store.bumpSessionEpoch(verdict.user.username);
			store.save();
		}
		clearSessionCookie(res);
		json(res, 200, { ok: true });
	};

	const handleMe = async (req, res) => {
		if (req.method !== "GET") {
			denyJson(res, 405, "method not allowed");
			return;
		}
		const verdict = requireAuth(req);
		// [fix:remote-cookie-heal] /auth/me is a public path (never wrapped by wrapHttp) yet it is the
		// only HTTP request the client issues before opening the mux. Healing the
		// loopback cookie here is what breaks the "reconnecting forever" deadlock.
		if (verdict.ok) await ensureLoopbackDshAuthCookie(res, req);
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
		const bootstrapKey = "bootstrap:" + clientAddress(req);
		const bootstrapRate = checkRate(bootstrapKey);
		if (!bootstrapRate.ok) {
			denyJson(res, 429, `too many attempts; retry in ${bootstrapRate.retryAfter}s`, { retryAfter: bootstrapRate.retryAfter });
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
		// Two accepted proofs, so the familiar local flow is unchanged:
		//   1) a genuine local browser (loopback peer + loopback Host, no proxy
		//      forwarding headers) enters username+password as before;
		//   2) a proxied fresh deployment may configure bootstrapToken /
		//      DSH_REMOTE_BOOTSTRAP_TOKEN and send it in the JSON body.
		const presentedToken = typeof input?.bootstrapToken === "string" ? input.bootstrapToken : "";
		const tokenAccepted = configuredBootstrapToken !== "" && secretsMatch(presentedToken, configuredBootstrapToken);
		if (!isLocalBootstrapRequest(req) && !tokenAccepted) {
			recordFailure(bootstrapKey);
			denyJson(res, 403, "first-admin bootstrap is loopback-only; set bootstrapToken for a proxied deployment");
			return;
		}
		clearRate(bootstrapKey);
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
		setSessionCookie(res, issueSession(account), req);
		await setLoginDshAuthCookies(req, res);
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
			// A password reset invalidates every session issued with the old one.
			if (passwordHash !== undefined) store.bumpSessionEpoch(username);
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
			const adminKey = rateKey(req, "mfa-admin-disable:" + verdict.user.username);
			const adminRate = checkRate(adminKey);
			if (!adminRate.ok) {
				denyJson(res, 429, `too many attempts; retry in ${adminRate.retryAfter}s`, { retryAfter: adminRate.retryAfter });
				return;
			}
			const adminOk = adminAccount !== null && await verifyPassword(password, adminAccount.passwordHash);
			if (!adminOk) {
				recordFailure(adminKey);
				denyJson(res, 401, "invalid admin password");
				return;
			}
			clearRate(adminKey);
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

	/** Content-Types for inline display by extension (lower-cased, no dot).
	 *  The text/code family serves as text/plain so the panel's "open in new
	 *  tab" shows source instead of downloading (and the client renders those
	 *  paths through its code/text view driven by the extension). */
	const TEXT_PLAIN = "text/plain; charset=utf-8";
	const FILE_MIME = {
		html: "text/html; charset=utf-8",
		htm: "text/html; charset=utf-8",
		css: "text/css; charset=utf-8",
		scss: TEXT_PLAIN,
		less: TEXT_PLAIN,
		vue: TEXT_PLAIN,
		svelte: TEXT_PLAIN,
		js: "text/javascript; charset=utf-8",
		mjs: "text/javascript; charset=utf-8",
		cjs: "text/javascript; charset=utf-8",
		jsx: TEXT_PLAIN,
		ts: TEXT_PLAIN,
		tsx: TEXT_PLAIN,
		mts: TEXT_PLAIN,
		cts: TEXT_PLAIN,
		json: "application/json; charset=utf-8",
		jsonc: TEXT_PLAIN,
		txt: "text/plain; charset=utf-8",
		md: "text/plain; charset=utf-8",
		mdx: TEXT_PLAIN,
		csv: "text/plain; charset=utf-8",
		tsv: TEXT_PLAIN,
		log: "text/plain; charset=utf-8",
		py: TEXT_PLAIN,
		rb: TEXT_PLAIN,
		go: TEXT_PLAIN,
		rs: TEXT_PLAIN,
		java: TEXT_PLAIN,
		c: TEXT_PLAIN,
		h: TEXT_PLAIN,
		cc: TEXT_PLAIN,
		cpp: TEXT_PLAIN,
		hpp: TEXT_PLAIN,
		cxx: TEXT_PLAIN,
		cs: TEXT_PLAIN,
		kt: TEXT_PLAIN,
		kts: TEXT_PLAIN,
		swift: TEXT_PLAIN,
		dart: TEXT_PLAIN,
		lua: TEXT_PLAIN,
		pl: TEXT_PLAIN,
		pm: TEXT_PLAIN,
		php: TEXT_PLAIN,
		r: TEXT_PLAIN,
		sql: TEXT_PLAIN,
		sh: TEXT_PLAIN,
		bash: TEXT_PLAIN,
		zsh: TEXT_PLAIN,
		fish: TEXT_PLAIN,
		ps1: TEXT_PLAIN,
		bat: TEXT_PLAIN,
		cmd: TEXT_PLAIN,
		yml: TEXT_PLAIN,
		yaml: TEXT_PLAIN,
		toml: TEXT_PLAIN,
		ini: TEXT_PLAIN,
		cfg: TEXT_PLAIN,
		conf: TEXT_PLAIN,
		env: TEXT_PLAIN,
		properties: TEXT_PLAIN,
		xml: TEXT_PLAIN,
		xhtml: TEXT_PLAIN,
		gitignore: TEXT_PLAIN,
		gitattributes: TEXT_PLAIN,
		dockerignore: TEXT_PLAIN,
		editorconfig: TEXT_PLAIN,
		npmrc: TEXT_PLAIN,
		diff: TEXT_PLAIN,
		patch: TEXT_PLAIN,
		graphql: TEXT_PLAIN,
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

	// Effective allowed roots for a request: the cordis `files.roots` config
	// PLUS the runtime store the settings UI manages (live add/remove). Read
	// fresh per request so a settings change applies without a restart.
	const effectiveExtraRoots = () => [...cfg.files.roots, ...filesRoots.list()];

	/** Simple HTML directory listing with clickable entries (files open inline). */
	const renderListing = (dirPath, entries, extraRoots = []) => {
		const rows = entries.map((entry) => {
			const href = `/auth/file?path=${encodeURIComponent(join(dirPath, entry.name))}`;
			const icon = entry.isDirectory ? "&#128193;" : "&#128196;";
			const size = entry.isDirectory ? "—" : `${Math.max(1, Math.round(entry.size / 1024))} KB`;
			return `<tr><td><a href="${href}">${icon} ${escapeHtml(entry.name)}${entry.isDirectory ? "/" : ""}</a></td><td>${size}</td></tr>`;
		}).join("\n");
		const parent = dirname(dirPath);
		const parentRow = parent !== dirPath && checkFilePath(parent, extraRoots).ok
			? `<tr><td><a href="/auth/file?path=${encodeURIComponent(parent)}">&#11014; ..</a></td><td>—</td></tr>` : "";
		return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(dirPath)}</title>` +
			`<style>body{font:13px/1.6 -apple-system,Segoe UI,sans-serif;background:#0d1117;color:#e6edf3;padding:24px;}` +
			`code{color:#8b949e}table{border-collapse:collapse}td{padding:3px 18px 3px 0}` +
			`a{color:#4c8bf5;text-decoration:none}a:hover{text-decoration:underline}</style></head><body>` +
			`<h3 style="margin:0 0 4px">Index of</h3><code>${escapeHtml(dirPath)}</code>` +
			`<table style="margin-top:14px">${parentRow}${rows}</table></body></html>`;
	};

	// Never expose the gateway's own secrets through the file viewer. The
	// default root is $DSH_HOME, whose auth/store.json holds the session-signing
	// secret and TOTP seeds, and whose profiles/*/cordis.patch.yml may hold the
	// configured secret/plaintext bootstrap password; DSH's .credentials.yaml
	// holds provider keys and the core dsh-auth signing secret.
	const isProtectedFile = (realPath) => {
		const norm = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
		const home = norm(resolve(dshHomePath()));
		const target = norm(resolve(realPath));
		const configured = [
			cfg.storePath ?? defaultStorePath(),
			cfg.filesRootsPath ?? filesRootsPath(),
			cfg.anonymousPathsPath ?? anonymousPathsPath(),
			join(home, ".credentials.yaml"),
			join(home, "settings.yaml"),
			join(home, "settings.yaml.imported")
		];
		const exact = [];
		for (const entry of configured) {
			exact.push(norm(resolve(entry)));
			try {
				exact.push(norm(realpathSync(entry)));
			} catch {
				// not created yet — the lexical spelling is enough
			}
		}
		if (exact.includes(target)) return true;
		if (target === home) return true;
		if (target.startsWith(home + sep)) {
			const first = target.slice(home.length + 1).split(sep)[0];
			// Only the user-facing data trees are browsable under $DSH_HOME;
			// auth/, profiles/, storages/ and every top-level dotfile are not.
			return !["sessions", "attachments"].includes(first);
		}
		return false;
	};

	const handleFile = (req, res) => {
		if (req.method !== "GET" && req.method !== "HEAD") {
			denyJson(res, 405, "method not allowed");
			return;
		}
		const auth = requireAuth(req);
		if (!auth.ok) {
			denyJson(res, 401, "unauthorized");
			return;
		}
		if (!cfg.files.enabled) {
			denyJson(res, 403, "file viewer disabled");
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
		const extraRoots = effectiveExtraRoots();
		const verdict = checkFilePath(rawPath, extraRoots);
		if (verdict.ok && isProtectedFile(verdict.real)) {
			denyJson(res, 403, "path is not readable through the remote viewer");
			return;
		}
		if (!verdict.ok) {
			const status = verdict.reason === "outside-roots" ? 403 : 404;
			// Self-diagnosing rejection: name the allowed roots so a remote user
			// immediately knows what to add (and where). Only admins get the
			// filesystem inventory; a guest learns nothing about the host layout.
			const extra = verdict.reason === "outside-roots" && auth.user.role === "admin"
				? { allowedRoots: fileRootsFor(extraRoots), hint: "add the file's directory under the plugin's Settings > Allowed directories" }
				: undefined;
			denyJson(res, status, `cannot display file (${verdict.reason})`, extra);
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
				if (isProtectedFile(join(verdict.real, ent.name))) continue;
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
					parent: parent !== verdict.real && checkFilePath(parent, extraRoots).ok ? parent : null,
					entries: rows.map((row) => ({ ...row, path: join(verdict.real, row.name) }))
				});
				return;
			}
			const html = renderListing(verdict.real, rows, extraRoots);
			res.writeHead(200, {
				"Content-Type": "text/html; charset=utf-8",
				"Content-Length": Buffer.byteLength(html),
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
				"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"
			});
			res.end(req.method === "HEAD" ? undefined : html);
			return;
		}
		const ext = extname(verdict.real).slice(1).toLowerCase();
		// format=text on a .docx serves extracted plain text for the in-app
		// viewer panel (the browser half classifies docx and asks here). Any
		// structural surprise answers 415 so the panel falls back to the
		// download card.
		if (format === "text" && ext === "docx") {
			if (verdict.size > DOCX_EXTRACT_MAX_BYTES) {
				denyJson(res, 415, "document too large for text extraction");
				return;
			}
			let text = null;
			try {
				text = extractDocxText(readFileSync(verdict.real));
			} catch {
				text = null;
			}
			if (typeof text !== "string") {
				denyJson(res, 415, "cannot extract text from this document");
				return;
			}
			res.writeHead(200, {
				"Content-Type": "text/plain; charset=utf-8",
				"Content-Length": Buffer.byteLength(text),
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff"
			});
			res.end(req.method === "HEAD" ? undefined : text);
			return;
		}
		const mime = FILE_MIME[ext] ?? "application/octet-stream";
		// Never render active content inline on the gateway origin: an
		// authenticated user opening a workspace-controlled HTML/SVG/JS file
		// would otherwise execute script with this origin's session (stored XSS
		// that could read every allowed file and drive admin-only APIs).
		const activeMime = /^(?:text\/html|image\/svg\+xml|application\/(?:xhtml\+xml|xml|javascript|x-javascript)|text\/(?:xml|javascript))/i.test(mime);
		const servedMime = activeMime ? "text/plain; charset=utf-8" : mime;
		const inline = servedMime !== "application/octet-stream" || ext === "";
		const disposition = inline
			? `inline; filename="${encodeURIComponent(basename(verdict.real))}"`
			: `attachment; filename="${encodeURIComponent(basename(verdict.real))}"`;
		res.writeHead(200, {
			"Content-Type": servedMime,
			"Content-Length": verdict.size,
			"Content-Disposition": disposition,
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
			"Content-Security-Policy": activeMime ? "sandbox; default-src 'none'" : "default-src 'none'"
		});
		if (req.method === "HEAD") {
			res.end();
			return;
		}
		const stream = createReadStream(verdict.real);
		stream.on("error", () => { try { res.destroy(); } catch { /* ignore */ } });
		stream.pipe(res);
	};

	// Snapshot returned by /auth/files so the settings UI can show the three
	// buckets: what config grants, what the runtime store adds, and the union
	// that actually gates /auth/file (realpath-resolved).
	const filesState = () => ({
		ok: true,
		enabled: cfg.files.enabled,
		configRoots: fileRootsFor(cfg.files.roots),
		userRoots: filesRoots.list(),
		effectiveRoots: fileRootsFor(effectiveExtraRoots())
	});

	/**
	 * GET  /auth/files  -> filesState()
	 * POST /auth/files  -> { action: "add"|"remove", path } persists the runtime
	 *                      store (admin only) and returns the fresh filesState().
	 */
	const handleFiles = async (req, res) => {
		if (req.method !== "GET" && req.method !== "POST") {
			denyJson(res, 405, "method not allowed");
			return;
		}
		if (!requireAuth(req).ok) {
			denyJson(res, 401, "unauthorized");
			return;
		}
		// Adding roots exposes the host filesystem — admin only.
		if (requireAuth(req).user.role !== "admin") {
			denyJson(res, 403, "admin required");
			return;
		}
		if (req.method === "GET") {
			// Always answer GET (even when disabled) so the settings page can
			// show the "viewer is off" note instead of silently hiding the block.
			json(res, 200, filesState());
			return;
		}
		if (!cfg.files.enabled) {
			denyJson(res, 403, "file viewer disabled");
			return;
		}
		const body = await readBodyBounded(req, 64 * 1024);
		let payload = null;
		if (body !== null) {
			try {
				payload = JSON.parse(body.toString("utf8"));
			} catch {
				payload = null;
			}
		}
		if (payload === null || typeof payload !== "object") {
			denyJson(res, 400, "bad request body");
			return;
		}
		const action = payload?.action;
		const path = typeof payload?.path === "string" ? payload.path : "";
		if (action === "add") {
			if (path.trim() === "" || !isAbsolute(path)) { denyJson(res, 400, "invalid path"); return; }
			if (filesRoots.add(path)) filesRoots.save();
			json(res, 200, filesState());
			return;
		}
		if (action === "remove") {
			if (filesRoots.remove(path)) filesRoots.save();
			json(res, 200, filesState());
			return;
		}
		denyJson(res, 400, "invalid action");
	};

	const anonymousPathsState = () => ({
		ok: true,
		paths: anonymousPaths.list()
	});

	/** Admin-only live controls for plugin routes with their own authentication. */
	const handleAnonymousPaths = async (req, res) => {
		if (req.method !== "GET" && req.method !== "POST") {
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
		if (req.method === "GET") {
			json(res, 200, anonymousPathsState());
			return;
		}
		const body = await readBodyBounded(req, 64 * 1024);
		let payload = null;
		if (body !== null) {
			try {
				payload = JSON.parse(body.toString("utf8"));
			} catch {
				payload = null;
			}
		}
		if (payload === null || typeof payload !== "object") {
			denyJson(res, 400, "bad request body");
			return;
		}
		const action = payload.action;
		if (action !== "add" && action !== "remove") {
			denyJson(res, 400, "invalid action");
			return;
		}
		const normalized = normalizeAnonymousPath(payload.path);
		if (!normalized.ok) {
			denyJson(res, 400, normalized.error);
			return;
		}
		if (action === "add") {
			const result = anonymousPaths.add(normalized.path);
			if (!result.ok) {
				denyJson(res, 400, result.error);
				return;
			}
			if (result.changed) anonymousPaths.save();
			json(res, 200, anonymousPathsState());
			return;
		}
		if (action === "remove") {
			if (anonymousPaths.remove(normalized.path)) anonymousPaths.save();
			json(res, 200, anonymousPathsState());
		}
	};

	// Register the /auth/* plane with the ORIGINAL register (before the gate is
	// patched in) so these routes are never wrapped.
	const originalRegister = webServer.register.bind(webServer);
	const originalRegisterUpgrade = webServer.registerUpgrade.bind(webServer);
	const originalRegisterFallback = webServer.registerFallback.bind(webServer);
	const originalReadResource = webServer.readResource;
	let wrappedReadResource = null;
	if (cfg.enabled && typeof originalReadResource === "function") {
		wrappedReadResource = async (request, peer) => {
			internalResourceReads.add(request);
			return originalReadResource.call(webServer, request, peer);
		};
		webServer.readResource = wrappedReadResource;
	}

	const disposers = [];
	// These handlers own their authentication. Declare the new DSH host gate
	// anonymous so its default `required` policy does not block /auth/login
	// before dsh-remote can present its own login flow. Older WebServers ignore
	// this optional route field.
	const authRouteGuard = (handler) => async (req, res) => {
		if (req.method !== "GET" && req.method !== "HEAD") {
			// Cross-site request defences for every state-changing /auth route:
			// a browser sends Sec-Fetch-Site and Origin, and all of this plugin's
			// JSON APIs require application/json (which HTML forms cannot send).
			const site = String(req.headers["sec-fetch-site"] ?? "").toLowerCase();
			if (site === "cross-site") {
				denyJson(res, 403, "cross-site request refused");
				return;
			}
			const origin = req.headers.origin;
			if (typeof origin === "string" && origin !== "") {
				let originHost = "";
				try {
					originHost = new URL(origin).host.toLowerCase();
				} catch {
					denyJson(res, 403, "invalid origin");
					return;
				}
				// Behind a reverse proxy/tunnel the request Host may be rewritten;
				// the browser's Origin still names the public authority that a
				// trusted proxy forwards in X-Forwarded-Host.
				const allowed = new Set([String(req.headers.host ?? "").toLowerCase()]);
				if (cfg.trustProxy) {
					const forwardedHost = String(req.headers["x-forwarded-host"] ?? "").split(",")[0].trim().toLowerCase();
					if (forwardedHost !== "") allowed.add(forwardedHost);
				}
				if (!allowed.has(originHost)) {
					denyJson(res, 403, "cross-origin request refused");
					return;
				}
			}
			const ctype = String(req.headers["content-type"] ?? "").toLowerCase();
			if (ctype !== "" && !ctype.startsWith("application/json")) {
				denyJson(res, 415, "application/json required");
				return;
			}
		}
		return handler(req, res);
	};
	const registerAuthRoute = (path, handler) => originalRegister({
		kind: "exact", path, auth: "anonymous", handler: authRouteGuard(handler)
	});
	disposers.push(registerAuthRoute("/auth/login", handleLogin));
	disposers.push(registerAuthRoute("/auth/logout", handleLogout));
	disposers.push(registerAuthRoute("/auth/me", handleMe));
	if (cfg.enabled) {
		disposers.push(registerAuthRoute("/auth/bootstrap", handleBootstrap));
		disposers.push(registerAuthRoute("/auth/settings-refresh", handleSettingsRefresh));
		disposers.push(registerAuthRoute("/auth/accounts", handleAccounts));
		disposers.push(registerAuthRoute("/auth/anonymous-paths", handleAnonymousPaths));
		disposers.push(registerAuthRoute("/auth/mfa/login", handleMfaLogin));
		disposers.push(registerAuthRoute("/auth/mfa/setup", handleMfaSetup));
		disposers.push(registerAuthRoute("/auth/mfa/verify", handleMfaVerify));
		disposers.push(registerAuthRoute("/auth/mfa/disable", handleMfaDisable));
		if (cfg.files.enabled) {
			disposers.push(registerAuthRoute("/auth/file", handleFile));
			disposers.push(registerAuthRoute("/auth/files", handleFiles));
		}
	}

	const enableCoreRouteAuth = (authCtx) => {
		if (!gateActive) return;
		const authentication = authCtx?.["connection.authentication"];
		if (typeof authentication?.authenticate !== "function") return;
		coreAuthentication = authentication;
		coreRouteAuthAvailable = true;
		for (const route of webServer.exact.values()) prepareCoreRouteAuth(route);
		for (const route of webServer.prefixes.values()) prepareCoreRouteAuth(route);
		for (const route of webServer.upgrades.values()) prepareCoreRouteAuth(route);
		// If the optional service arrives after activation, make an already
		// claimed SPA fallback anonymous at the host layer. Its dsh-remote wrapper
		// still enforces the browser session and renders the login page.
		if (cfg.enabled && webServer.fallback !== undefined) {
			const fallback = wrappedFallbackOriginals.get(webServer.fallback) ?? webServer.fallback;
			webServer.fallback = wrapFallbackSeat(fallback);
		}
	};
	try {
		ctx.inject(["connection.authentication"], enableCoreRouteAuth);
	} catch {
		// dsh before 0.2.3 has no route-auth provider; route auth fields are ignored.
	}

	if (cfg.enabled) {
		// Wrap routes registered before this plugin activated. A route may be a
		// node handler (`.handler`) or a Fetch resource (`.resource`) — dsh ≥
		// 0.2.2-alpha introduced the latter (e.g. the /plugins/* bundle prefix).
		const wrapRouteInPlace = (route) => {
			prepareCoreRouteAuth(route);
			if (isResourceRoute(route)) { route.resource = wrapResourceHttp(route.resource, route); return; }
			if (route !== null && typeof route === "object" && typeof route.handler === "function") {
				route.handler = wrapHttp(route.handler, route);
			}
		};
		for (const route of webServer.exact.values()) wrapRouteInPlace(route);
		for (const route of webServer.prefixes.values()) wrapRouteInPlace(route);
		for (const route of webServer.upgrades.values()) {
			prepareCoreRouteAuth(route);
			route.handler = wrapUpgrade(route.handler, route);
		}
		if (webServer.fallback !== undefined) webServer.fallback = wrapFallbackSeat(webServer.fallback);

		// Gate every route registered later, preserving the new DSH host's
		// explicit auth: "anonymous" routes for providers that own authentication.
		webServer.register = (route) => {
			const owned = { ...route };
			prepareCoreRouteAuth(owned);
			if (isResourceRoute(owned)) owned.resource = wrapResourceHttp(owned.resource, owned);
			else owned.handler = wrapHttp(owned.handler, owned);
			return originalRegister(owned);
		};
		webServer.registerUpgrade = (route) => {
			const owned = { ...route };
			prepareCoreRouteAuth(owned);
			owned.handler = wrapUpgrade(owned.handler, owned);
			return originalRegisterUpgrade(owned);
		};
		webServer.registerFallback = (fallback) => originalRegisterFallback(wrapFallbackSeat(fallback));
	}

	ctx.effect(() => () => {
		gateActive = false;
		for (const dispose of disposers) dispose();
		if (cfg.enabled) {
			webServer.register = originalRegister;
			webServer.registerUpgrade = originalRegisterUpgrade;
			webServer.registerFallback = originalRegisterFallback;
			if (wrappedReadResource !== null && webServer.readResource === wrappedReadResource) {
				webServer.readResource = originalReadResource;
			}
			const unwrapRouteInPlace = (route) => {
				if (isResourceRoute(route)) {
					route.resource = unwrapResource(route.resource);
					unwrapCoreRouteAuth(route);
					return;
				}
				if (route !== null && typeof route === "object") {
					route.handler = unwrap(route.handler);
					unwrapCoreRouteAuth(route);
				}
			};
			for (const route of webServer.exact.values()) unwrapRouteInPlace(route);
			for (const route of webServer.prefixes.values()) unwrapRouteInPlace(route);
			for (const route of webServer.upgrades.values()) {
				route.handler = unwrap(route.handler);
				unwrapCoreRouteAuth(route);
			}
			if (webServer.fallback !== undefined) webServer.fallback = unwrapFallbackSeat(webServer.fallback);
		}
	}, "dsh-remote: gate");

	ctx.logger.info(
		`dsh-remote: authentication ${cfg.enabled ? "enabled" : "disabled"} ` +
		`(${store.list().length} account(s), store at ${defaultStorePath()})`
	);
}

export { Config, apply, inject, name };
export {
	SUPPORTED_LOCALES,
	normalizeLocale,
	localeFromAcceptLanguage,
	pickLoginLang,
	loginPageLang,
	ORIGINAL_HOST,
	captureOriginalHost,
	isRemoteOrigin,
	BROWSER_SESSION_RECORD_KEY,
	BROWSER_COOKIE_MAX_AGE_DAYS_DEFAULT,
	canonicalAuthority,
	dshAuthCookieName,
	encodeDshAuthCookie,
	decodeDshAuthCookie,
	cookieValueOf,
	cookieHeaderSet,
	readBrowserAuthSecret,
	hasLiveDshAuthCookie,
	shouldGzip,
	shouldCache,
	makeGzipRes,
	makePwaRes,
	isPwaAssetPath,
	isDocumentPath,
	expectedContentType,
	staticContentTypeFor,
	serviceWorkerAllowFor,
	pwaHeadersFor,
	checkFilePathAgainst,
	evaluateRoleGate,
	denyRpcEnvelope
};
export { FilesRootsStore, filesRootsPath };
export default { Config, apply, inject, name };
