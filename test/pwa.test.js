/**
 * Tests for the PWA static plane: the manifest, the service worker and the
 * icons answer even when the visitor has no dsh-remote session, and every one
 * of them gets the headers a home-screen launch needs — correct MIME,
 * `Service-Worker-Allowed: /`, no stale caching. The core `dsh-auth` cookie
 * repair happens on AUTHENTICATED documents only: an anonymous GET mints
 * nothing (see the minting-context tests at the bottom).
 *
 * Three layers, each testing what the one below cannot:
 *  - pure helpers (path classification, header merge, MIME) in isolation;
 *  - a LIVE node server, proving the rewritten headers survive the gzip
 *    wrapper and node's own `res.writeHead` — the two places a "looks right"
 *    header quietly disappears from the wire;
 *  - `apply()` against a fake core, proving the gate lets the three PWA paths
 *    through WITHOUT a session and still denies everything else.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { gunzipSync } from "node:zlib";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ORIGINAL_HOST,
	Config,
	apply,
	canonicalAuthority,
	cookieHeaderSet,
	dshAuthCookieName,
	encodeDshAuthCookie,
	hasLiveDshAuthCookie,
	isDocumentPath,
	isPwaAssetPath,
	expectedContentType,
	staticContentTypeFor,
	serviceWorkerAllowFor,
	pwaHeadersFor,
	makePwaRes,
	makeGzipRes,
} from "../lib/index.js";

// ── unit: isPwaAssetPath ───────────────────────────────────────────────────────

test("isPwaAssetPath: the manifest, the service worker and one icon", () => {
	for (const p of ["/manifest.webmanifest", "/sw.js", "/icons/icon-192.png", "/icons/maskable-512.png", "/icons/x.ico"]) {
		assert.equal(isPwaAssetPath(p), true, `expected PWA asset: ${p}`);
	}
});

test("isPwaAssetPath: nothing else escapes the gate", () => {
	for (const p of [
		"/", "/index.html", "/assets/index-abc.js", "/api/session.history", "/auth/me",
		// not the allowlisted leaves
		"/icons/", "/icons/a/b.png", "/icons/../sw.js", "/icons/..", "/icons/.", "/icons/a b.png",
		// only the ROOT /icons/ directory
		"/x/icons/icon-192.png",
		// encoded spellings are NOT classified here: the core decodes them itself
		"/%73w.js", "/sw%2Ejs", "/icons/icon%2E192%2Epng"
	]) {
		assert.equal(isPwaAssetPath(p), false, `expected gated: ${p}`);
	}
});

// ── unit: isDocumentPath ───────────────────────────────────────────────────────

test("isDocumentPath: SPA routes, .html pages and the PWA shell files", () => {
	for (const p of ["/", "/workspace/x", "/a/b/c", "/index.html", "/manifest.webmanifest", "/sw.js"]) {
		assert.equal(isDocumentPath(p), true, `expected document: ${p}`);
	}
});

test("isDocumentPath: extension-bearing assets and API paths are not documents", () => {
	for (const p of ["/assets/index-abc.js", "/assets/index.css", "/api/session.history", "/plugins/x.js", "/auth/me", "/favicon.ico"]) {
		assert.equal(isDocumentPath(p), false, `expected non-document: ${p}`);
	}
});

// ── unit: MIME ─────────────────────────────────────────────────────────────────

test("expectedContentType: the types PWA installability needs", () => {
	assert.equal(expectedContentType("/manifest.webmanifest"), "application/manifest+json");
	assert.equal(expectedContentType("/sw.js"), "text/javascript; charset=utf-8");
	assert.equal(expectedContentType("/icons/icon-192.png"), "image/png");
	assert.equal(expectedContentType("/icons/x.ico"), "image/x-icon");
	assert.equal(expectedContentType("/icons/maskable.svg"), "image/svg+xml");
	assert.equal(expectedContentType("/nope.unknown"), null);
});

test("expectedContentType: the plugin JS fallback only covers real script paths", () => {
	assert.equal(expectedContentType("/plugins/x/dist.js"), "text/javascript; charset=utf-8");
	assert.equal(expectedContentType("/plugins/x/worker"), "text/javascript; charset=utf-8");
	// a binary/data file inside a plugin directory is NOT JavaScript
	assert.equal(expectedContentType("/plugins/x/bin.dat"), null);
	assert.equal(expectedContentType("/plugins/x/logo.png"), "image/png");
});

test("staticContentTypeFor: replaces only an untyped response", () => {
	assert.equal(staticContentTypeFor("/icons/a.png", {}), "image/png");
	assert.equal(staticContentTypeFor("/icons/a.png", { "content-type": "application/octet-stream" }), "image/png");
	assert.equal(staticContentTypeFor("/icons/a.png", { "content-type": "image/png" }), null);
	// an aliased spelling of the same type is already correct
	assert.equal(staticContentTypeFor("/icons/a.ico", { "content-type": "image/vnd.microsoft.icon" }), null);
	// a type the core DID set is left alone, even when it disagrees: a missing
	// /sw.js or icon falls back to the SPA shell, and calling that HTML
	// JavaScript (or an image) would be worse than the mismatch
	assert.equal(staticContentTypeFor("/sw.js", { "content-type": "text/html; charset=utf-8" }), null);
	assert.equal(staticContentTypeFor("/icons/a.png", { "content-type": "text/html" }), null);
	// the helper only looks at content-type; the COMPRESSED case is the caller's guard
	assert.equal(pwaHeadersFor("/icons/a.png", "/icons/a.png", 200, { "content-type": "application/octet-stream", "content-encoding": "gzip" })["content-type"], "application/octet-stream");
	// and only a 200 body is ever retyped
	assert.equal(pwaHeadersFor("/icons/a.png", "/icons/a.png", 304, { "content-type": "application/octet-stream" })["content-type"], "application/octet-stream");
});

// ── unit: serviceWorkerAllowFor ────────────────────────────────────────────────

test("serviceWorkerAllowFor: '/' on the worker only", () => {
	assert.equal(serviceWorkerAllowFor("/sw.js", "/sw.js", 200), "/");
	// the header is meaningless on documents — browsers ignore it there
	assert.equal(serviceWorkerAllowFor("/", "/", 200), null);
	assert.equal(serviceWorkerAllowFor("/workspace/x", "/workspace/x", 200), null);
	assert.equal(serviceWorkerAllowFor("/manifest.webmanifest", "/manifest.webmanifest", 200), null);
	// assets and non-200 responses carry no worker scope
	assert.equal(serviceWorkerAllowFor("/assets/x.js", "/assets/x.js", 200), null);
	assert.equal(serviceWorkerAllowFor("/sw.js", "/sw.js", 304), null);
	assert.equal(serviceWorkerAllowFor("/", "/", 404), null);
});

// ── unit: pwaHeadersFor ────────────────────────────────────────────────────────

test("pwaHeadersFor: worker gets scope + no-store, casing of the caller kept", () => {
	const out = pwaHeadersFor("/sw.js", "/sw.js", 200, { "Content-Type": "text/javascript; charset=utf-8" });
	assert.equal(out["service-worker-allowed"], "/");
	assert.equal(out["cache-control"], "no-store");
	assert.equal(out["Content-Type"], "text/javascript; charset=utf-8");
	// no duplicate when the caller already spelled it differently
	assert.equal(Object.keys(out).filter((k) => k.toLowerCase() === "cache-control").length, 1);
});

test("pwaHeadersFor: a healed document is uncacheable, an ordinary one is not", () => {
	const healed = pwaHeadersFor("/workspace/x", "/workspace/x", 200, {}, { healCookie: true });
	assert.equal(healed["cache-control"], "no-store");
	const plain = pwaHeadersFor("/workspace/x", "/workspace/x", 200, {}, { healCookie: false });
	assert.equal(plain["cache-control"], undefined);
	// documents never carry a worker-scope header
	assert.equal(healed["service-worker-allowed"], undefined);
	assert.equal(plain["service-worker-allowed"], undefined);
});

test("pwaHeadersFor: assets are untouched apart from their MIME", () => {
	const out = pwaHeadersFor("/assets/index-abc.js", "/assets/index-abc.js", 200, { "cache-control": "public, max-age=31536000, immutable" });
	assert.equal(out["cache-control"], "public, max-age=31536000, immutable");
	assert.equal(out["service-worker-allowed"], undefined);
});

// ── live: headers actually reach the wire ─────────────────────────────────────

const serve = (handler) => {
	const server = createServer((req, res) => {
		req[ORIGINAL_HOST] = String(req.headers.host);
		handler(req, res).catch((err) => { res.destroy(err); });
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
};

async function sendRaw(server, { path = "/", method = "GET", hostHeader = "dsh.facaix.fun", acceptEncoding = "gzip", cookie } = {}) {
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;
	const headers = { host: hostHeader, "accept-encoding": acceptEncoding };
	if (cookie !== undefined) headers.cookie = cookie;
	return new Promise((resolve, reject) => {
		const req = httpRequest({ host: "127.0.0.1", port, path, method, headers }, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
			res.on("error", reject);
		});
		req.on("error", reject);
		req.setTimeout(8000, () => { reject(new Error("sendRaw timed out")); req.destroy(); });
		req.end();
	});
}

// ── the minting context: a real credentials service ───────────────────────────
// `HARNESS_SECRET` is the session secret `withPlugin` configures, so a session
// cookie signed here verifies exactly like a login-issued one.
const HARNESS_SECRET = "0".repeat(64);
const HARNESS_HOST = "dsh.facaix.fun";
const BROWSER_SECRET = randomBytes(32);
const BROWSER_RECORD = { kind: "grant", payload: { version: 1, secret: BROWSER_SECRET.toString("base64url") } };

/** A `dsh_session` cookie signed the way `issueSession` signs it. */
function sessionCookie(username = "admin") {
	const payload = { sub: username, role: "admin", iat: Date.now(), exp: Date.now() + 3600_000 };
	const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
	const sig = createHmac("sha256", HARNESS_SECRET).update(`v1.${encoded}`).digest("base64url");
	return `dsh_session=v1.${encoded}.${sig}`;
}

/** A live `dsh-auth-<sha256(host)>` cookie, i.e. a jar that needs no repair. */
function liveDshAuthCookie() {
	const authority = canonicalAuthority(HARNESS_HOST);
	return encodeDshAuthCookie(authority, BROWSER_SECRET, 3600_000).cookie.split(";")[0];
}

/** A live dsh-auth cookie bound to the loopback authority the gated core sees
 *  (`trustProxy` defaults on; the fake core has no port, so `127.0.0.1:3080`).
 *  A jar needs NO repair only when it carries BOTH this and the original-Host
 *  cookie — the loopback heal (cookie-fence fix) owns the other authority. */
function liveLoopbackDshAuthCookie() {
	const authority = canonicalAuthority("127.0.0.1:3080");
	return encodeDshAuthCookie(authority, BROWSER_SECRET, 3600_000).cookie.split(";")[0];
}

test("live: a PWA rewrite survives makeGzipRes and a later res.writeHead(status)", async () => {
	const pngBody = Buffer.alloc(64, 7);
	const server = await serve(async (req, res) => {
		const out = makeGzipRes(res, req, { enabled: true, remoteOnly: true, minBytes: 1024 });
		const pwa = makePwaRes(out);
		// the core's static handler writes octet-stream for `.png`; the PWA plane corrects it
		pwa.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store" });
		pwa.end(pngBody);
	});
	try {
		const res = await sendRaw(server, { path: "/icons/icon-192.png" });
		assert.equal(res.status, 200);
		assert.equal(res.headers["content-type"], "image/png", "MIME must reach the wire as image/png");
		assert.equal(res.headers["cache-control"], "no-store");
		assert.deepEqual(res.body, pngBody);
	} finally {
		server.close();
	}
});

test("live: the manifest keeps application/manifest+json through the gzip path", async () => {
	// >1 KiB so the remote-only gzip branch actually engages for this response
	const body = Buffer.from(JSON.stringify({ name: "DSH", short_name: "DSH", icons: [], pad: "x".repeat(2048) }));
	const server = await serve(async (req, res) => {
		const out = makeGzipRes(res, req, { enabled: true, remoteOnly: true, minBytes: 1024 });
		const pwa = makePwaRes(out);
		// an UNTYPED response is the one the plugin retypes (octet-stream/absent)
		pwa.writeHead(200, { "content-type": "application/octet-stream" });
		pwa.end(body);
	});
	try {
		const res = await sendRaw(server, { path: "/manifest.webmanifest" });
		assert.equal(res.headers["content-type"], "application/manifest+json");
		// a document-ish response must NOT be dressed up as a worker script
		assert.equal(res.headers["service-worker-allowed"], undefined);
		const plain = res.headers["content-encoding"] === "gzip" ? gunzipSync(res.body) : res.body;
		assert.deepEqual(JSON.parse(plain.toString("utf8")), JSON.parse(body.toString("utf8")));
	} finally {
		server.close();
	}
});

test("live: sw.js carries Service-Worker-Allowed: / on the wire", async () => {
	const server = await serve(async (req, res) => {
		const pwa = makePwaRes(res);
		pwa.writeHead(200, { "content-type": "text/javascript" });
		pwa.end("self.addEventListener('install', () => {});");
	});
	try {
		const res = await sendRaw(server, { path: "/sw.js" });
		assert.equal(res.headers["service-worker-allowed"], "/");
		assert.equal(res.headers["cache-control"], "no-store");
	} finally {
		server.close();
	}
});

// ── integration: the gate ─────────────────────────────────────────────────────

/**
 * A minimal fake of the core's web-server service: an exact map, a prefix map,
 * a fallback, and the register*() methods dsh-remote patches.
 *
 * `coreCookieHeaders` records the Cookie header EVERY core-side handler saw —
 * that is the only honest witness to "did the core authenticate THIS request",
 * because the response headers say nothing about what the core read. `api`
 * registers a gated prefix route so `wrapHttp` can be exercised too.
 */
function fakeCore({ fallbackAnswer = "CORE", api = false, coreAuth = false } = {}) {
	const exact = new Map();
	const prefixes = new Map();
	const upgrades = new Map();
	const coreCookieHeaders = [];
	const webServer = {
		exact,
		prefixes,
		upgrades,
		coreCookieHeaders,
		fallback: undefined,
		register(route) {
			const map = route.kind === "prefix" ? prefixes : exact;
			map.set(route.path, { handler: route.handler });
			return () => map.delete(route.path);
		},
		registerUpgrade(route) {
			upgrades.set(route.path, { handler: route.handler });
			return () => upgrades.delete(route.path);
		},
		registerFallback(handler) {
			webServer.fallback = handler;
			return () => { webServer.fallback = undefined; };
		},
		dispatch(req, res) {
			const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
			const hit = exact.get(pathname);
			if (hit) return hit.handler(req, res);
			for (const [prefix, entry] of prefixes) {
				if (pathname.startsWith(prefix)) return entry.handler(req, res);
			}
			if (webServer.fallback !== undefined) return webServer.fallback(req, res);
			res.writeHead(404);
			res.end();
		}
	};
	if (api) {
		// The gate normalizes the Host for /api; the core answers with what it read.
		prefixes.set("/api/", {
			handler: (req, res) => {
				coreCookieHeaders.push(req.headers.cookie);
				if (coreAuth && !hasLiveDshAuthCookie(req.headers.cookie, canonicalAuthority(req.headers.host), BROWSER_SECRET)) {
					const body = "{\"error\":\"unauthorized\"}";
					res.writeHead(401, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
					res.end(body);
					return;
				}
				res.writeHead(200, { "content-type": "application/json" });
				res.end("{\"ok\":true}");
			}
		});
	}
	// The core's static frontend answers the PWA files itself.
	webServer.fallback = (req, res) => {
		const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
		if (isPwaAssetPath(pathname)) {
			res.writeHead(200, { "content-type": "application/octet-stream" });
			res.end(`ASSET:${pathname}`);
			return;
		}
		coreCookieHeaders.push(req.headers.cookie);
		if (coreAuth) {
			// Emulate `authorizeIndex`: the core authenticates the DOCUMENT
			// request from the Host it sees and the Cookie header it received.
			// Without the injection this branch is the plain-text 401 the phone
			// PWA cold start showed.
			const authority = canonicalAuthority(req.headers.host);
			if (!hasLiveDshAuthCookie(req.headers.cookie, authority, BROWSER_SECRET)) {
				const body = "dsh web authentication required; reopen the URL printed by dsh web.";
				res.writeHead(401, { "content-type": "text/plain", "cache-control": "no-store", "content-length": Buffer.byteLength(body) });
				res.end(body);
				return;
			}
		}
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(fallbackAnswer);
	};
	return webServer;
}

function fakeCtx(webServer, dir) {
	const disposers = [];
	return {
		webServer,
		logger: { info() {}, warn() {}, error() {}, debug() {} },
		inject() { throw new Error("no credentials service in this fake"); },
		emit() {},
		effect(fn) {
			disposers.push(fn());
			return () => {};
		},
		dir
	};
}

/**
 * A ctx whose `credentials` service really holds the core's browser-session
 * record, so `ensureDshAuthCookie` can mint. The default fake has no such
 * service and therefore can never prove anything about cookie minting.
 * @param {object} record - value returned by `readRecord(...)`.
 */
function mintingCtx(webServer, dir, record) {
	const ctx = fakeCtx(webServer, dir);
	ctx.inject = (services, cb) => { cb({ credentials: { readRecord: async () => record } }); };
	return ctx;
}

/** Drive `apply` and run one real HTTP request through the patched dispatch. */
async function withPlugin(run, { credentials, api, coreAuth } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "dsh-remote-pwa-"));
	// `api` registers a gated prefix route BEFORE apply, so it passes through
	// `wrapHttp` — the other path that must inject the minted cookie. `coreAuth`
	// makes the fake core authenticate like the real one (401 on a dead cookie).
	const webServer = fakeCore({ api: api === true, coreAuth: coreAuth === true });
	const ctx = credentials === undefined ? fakeCtx(webServer, dir) : mintingCtx(webServer, dir, credentials);
	// Production never hands `apply` a bare object: cordis resolves the
	// Schemastery `Config` first, which fills every default (`session`,
	// `browserAuth`, `gzip`, ...). Calling `apply` with raw input would leave
	// `cfg.session` undefined and crash the first cookie read, so the harness
	// must drive the same resolution the runtime does.
	apply(ctx, Config({
		enabled: true,
		secret: HARNESS_SECRET,
		storePath: join(dir, "accounts.json"),
		filesRootsPath: join(dir, "files-roots.json"),
		accounts: [{ username: "admin", password: "admin-password", role: "admin" }],
		files: { enabled: false }
	}));
	const server = await serve((req, res) => {
		req[ORIGINAL_HOST] = String(req.headers.host);
		return webServer.dispatch(req, res);
	});
	try {
		return await run({ server, webServer });
	} finally {
		server.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

test("gate: sw.js, the manifest and an icon answer WITHOUT a session", async () => {
	await withPlugin(async ({ server }) => {
		for (const path of ["/sw.js", "/manifest.webmanifest", "/icons/icon-192.png"]) {
			const res = await sendRaw(server, { path });
			assert.equal(res.status, 200, `${path} must be served unauthenticated`);
			// gzip is on by default and the PWA plane sits inside it, so the
			// marker is asserted on the DECODED body — the point of this test is
			// that the request reached the static layer, not the transfer coding.
			const body = res.headers["content-encoding"] === "gzip" ? gunzipSync(res.body) : res.body;
			assert.match(body.toString("utf8"), /^ASSET:/, `${path} must reach the static layer`);
		}
		const sw = await sendRaw(server, { path: "/sw.js" });
		assert.equal(sw.headers["service-worker-allowed"], "/");
		const icon = await sendRaw(server, { path: "/icons/icon-192.png" });
		assert.equal(icon.headers["content-type"], "image/png");
	});
});

test("gate: everything else still needs the session", async () => {
	await withPlugin(async ({ server }) => {
		const page = await sendRaw(server, { path: "/" });
		assert.equal(page.status, 200);
		assert.match(page.body.toString("utf8"), /<!doctype html>/i, "unauthenticated home must be the LOGIN page");
		assert.doesNotMatch(page.body.toString("utf8"), /^ASSET:|CORE/);

		// An unauthenticated GET is never denied: it gets the login page, the
		// documented behaviour for page requests. The guarantee under test is
		// that the asset's own bytes never come back — the gate answers with the
		// login page, NOT the core's static bundle.
		const asset = await sendRaw(server, { path: "/assets/index-abc.js" });
		assert.equal(asset.status, 200, "unauthenticated GET answers with the login page");
		const assetBody = asset.body.toString("utf8");
		assert.match(assetBody, /<!doctype html>/i, "asset GET must be replaced by the login page");
		assert.doesNotMatch(assetBody, /^ASSET:|CORE/, "the asset must not reach the static layer");

		// A non-page request has no login page to fall back to, so it is denied.
		const denied = await sendRaw(server, { path: "/assets/index-abc.js", method: "POST" });
		assert.equal(denied.status, 403, "unauthenticated non-GET must be denied");

		const api = await sendRaw(server, { path: "/auth/me" });
		assert.equal(api.status, 200, "/auth/* is registered before the gate runs");
	});
});

test("gate: an unauthenticated PWA leaf answers 200 when no credentials service can mint", async () => {
	await withPlugin(async ({ server }) => {
		const res = await sendRaw(server, { path: "/sw.js" });
		// With no credentials service the plugin cannot mint; the response must
		// still be correct rather than blocked (regression guard for the gate).
		assert.equal(res.status, 200);
	});
});

test("gate: an unauthenticated PWA leaf mints NO dsh-auth cookie, even when minting is possible", async () => {
	await withPlugin(async ({ server }) => {
		for (const path of ["/sw.js", "/manifest.webmanifest", "/icons/icon-192.png"]) {
			const res = await sendRaw(server, { path });
			assert.equal(res.status, 200, `${path} must still answer unauthenticated`);
			// Signing a Host-bound core cookie for an anonymous GET would hand
			// the core's browserAuth to any visitor who can reach the port; the
			// unauthenticated branch must stay mint-free.
			assert.equal(res.headers["set-cookie"], undefined, `${path} must mint nothing`);
			assert.equal(res.headers["cache-control"], "no-store", `${path} stays uncacheable`);
		}
	}, { credentials: BROWSER_RECORD });
});

test("gate: a document is repaired only when the jar actually lost the core cookie", async () => {
	await withPlugin(async ({ server }) => {
		// Logged in, but the dsh-auth cookie is gone: the document response
		// carries the re-mint and must therefore be uncacheable.
		const repaired = await sendRaw(server, { path: "/", cookie: sessionCookie() });
		assert.equal(repaired.status, 200);
		const cookies = repaired.headers["set-cookie"] ?? [];
		// The loopback heal (cookie-fence fix) also mints its own cookie on a
		// document load, so assert on the ORIGINAL-Host cookie specifically.
		const mintedOriginal = cookies.filter((c) =>
			c.startsWith(`${dshAuthCookieName(canonicalAuthority(HARNESS_HOST))}=`));
		assert.equal(mintedOriginal.length, 1, "exactly one minted cookie for the original Host");
		assert.ok(
			mintedOriginal[0].startsWith(`${dshAuthCookieName(canonicalAuthority(HARNESS_HOST))}=`),
			`the minted cookie is bound to ${HARNESS_HOST}, got ${mintedOriginal[0].split(";")[0].split("=")[0]}`
		);
		assert.equal(repaired.headers["cache-control"], "no-store", "a healed document must not be cached");

		// Same session, healthy jar: no mint, so no forced no-store — the
		// navigation may be cached normally.
		const healthy = await sendRaw(server, { path: "/", cookie: `${sessionCookie()}; ${liveDshAuthCookie()}; ${liveLoopbackDshAuthCookie()}` });
		assert.equal(healthy.status, 200);
		assert.equal(healthy.headers["set-cookie"], undefined, "a healthy jar must not be re-minted");
		assert.notEqual(healthy.headers["cache-control"], "no-store",
			"an unhealed document keeps its ordinary cache policy");
	}, { credentials: BROWSER_RECORD });
});

test("gate: a PWA response is never long-cached", async () => {
	await withPlugin(async ({ server }) => {
		const res = await sendRaw(server, { path: "/manifest.webmanifest" });
		assert.equal(res.headers["cache-control"], "no-store");
	});
});

// ── unit: cookieHeaderSet ─────────────────────────────────────────────────────

test("cookieHeaderSet: an empty header becomes exactly `name=value`", () => {
	assert.equal(cookieHeaderSet(undefined, "a", "1"), "a=1");
	assert.equal(cookieHeaderSet("", "a", "1"), "a=1");
	assert.equal(cookieHeaderSet("   ", "a", "1"), "a=1");
});

test("cookieHeaderSet: every other cookie keeps its order and text", () => {
	const header = "dsh_session=SIG; theme=dark";
	assert.equal(cookieHeaderSet(header, "a", "1"), "dsh_session=SIG; theme=dark; a=1");
});

test("cookieHeaderSet: a same-named segment is REPLACED, not appended behind", () => {
	// The core reads the FIRST matching segment, so an appended fresh value
	// behind a stale one would still authenticate with the dead value.
	const header = "a=stale; dsh_session=SIG";
	assert.equal(cookieHeaderSet(header, "a", "fresh"), "dsh_session=SIG; a=fresh");
});

test("cookieHeaderSet: no duplicate survives, whatever the position", () => {
	assert.equal(cookieHeaderSet("a=1; b=2; a=3", "a", "9"), "b=2; a=9");
	assert.equal(cookieHeaderSet("a=1; a=2", "a", "9"), "a=9");
});

test("cookieHeaderSet: a name that only PREFIXES another name is not touched", () => {
	assert.equal(cookieHeaderSet("a-long=keep; a=1", "a", "9"), "a-long=keep; a=9");
	// values containing '=' survive: only the part before the first '=' is the name
	assert.equal(cookieHeaderSet("b=x=y", "a", "1"), "b=x=y; a=1");
});

// ── integration: the minted cookie authenticates THIS request ────────────────
// Regression for the phone PWA cold start: a browser with only `dsh_session`
// navigated, the plugin minted a dsh-auth cookie onto the response, and the
// core still answered 401 in plain text because it had already read the
// request headers. `coreAuth` makes the fake core authenticate exactly like
// the real `authorizeIndex`, so a 200 here means the injection worked.

test("inject: a cold document navigation authenticates on the SAME request", async () => {
	await withPlugin(async ({ server, webServer }) => {
		const res = await sendRaw(server, { path: "/", cookie: sessionCookie() });
		assert.equal(res.status, 200, "the first navigation must not 401");
		const body = res.headers["content-encoding"] === "gzip" ? gunzipSync(res.body) : res.body;
		assert.equal(body.toString("utf8"), "CORE", "the request reached the core as authenticated");
		// The jar is repaired too, otherwise the NEXT navigation would regress.
		const cookies = res.headers["set-cookie"] ?? [];
		assert.equal(cookies.length, 2, "original and loopback cookies are minted for a jar missing both");
		// And what the core READ is what the response handed the browser.
		const seen = webServer.coreCookieHeaders.at(-1);
		const name = dshAuthCookieName(canonicalAuthority(HARNESS_HOST));
		assert.ok(seen.includes(`${name}=`), `the core must have seen ${name}, got: ${seen}`);
		assert.equal(
			`${name}=${seen.split(";").map((s) => s.trim()).find((s) => s.startsWith(`${name}=`)).split("=").slice(1).join("=")}`,
			cookies[0].split(";")[0],
			"the injected value must be the very cookie that was minted"
		);
	}, { credentials: BROWSER_RECORD, coreAuth: true });
});

test("inject: the injected header keeps dsh_session and every other cookie", async () => {
	await withPlugin(async ({ server, webServer }) => {
		const session = sessionCookie();
		const res = await sendRaw(server, { path: "/", cookie: `${session}; theme=dark` });
		assert.equal(res.status, 200);
		const seen = webServer.coreCookieHeaders.at(-1);
		assert.ok(seen.startsWith(`${session}; theme=dark; `),
			`existing cookies keep their position and text, got: ${seen}`);
		assert.match(seen, /dsh-auth-[A-Za-z0-9_-]+=v1\./);
	}, { credentials: BROWSER_RECORD, coreAuth: true });
});

test("inject: a live cookie is neither re-minted nor injected", async () => {
	await withPlugin(async ({ server, webServer }) => {
		const sent = `${sessionCookie()}; ${liveDshAuthCookie()}; ${liveLoopbackDshAuthCookie()}`;
		const res = await sendRaw(server, { path: "/", cookie: sent });
		assert.equal(res.status, 200);
		assert.equal(res.headers["set-cookie"], undefined, "a healthy jar must not be re-minted");
		assert.equal(webServer.coreCookieHeaders.at(-1), sent, "the Cookie header must be untouched");
	}, { credentials: BROWSER_RECORD, coreAuth: true });
});

test("inject: an EXPIRED same-named cookie is replaced, never left in front", async () => {
	await withPlugin(async ({ server, webServer }) => {
		const authority = canonicalAuthority(HARNESS_HOST);
		// A structurally valid cookie that expired an hour ago: `hasLiveDshAuthCookie`
		// says no, so the gate re-mints — and the dead value must be GONE, because
		// the core stops at the first matching segment.
		const dead = encodeDshAuthCookie(authority, BROWSER_SECRET, 1000, Date.now() - 3_600_000).cookie.split(";")[0];
		const name = dshAuthCookieName(authority);
		const session = sessionCookie();
		const res = await sendRaw(server, { path: "/", cookie: `${dead}; ${session}` });
		assert.equal(res.status, 200, "the replacement cookie must authenticate this request");
		const seen = webServer.coreCookieHeaders.at(-1);
		const segments = seen.split(";").map((s) => s.trim()).filter((s) => s.startsWith(`${name}=`));
		assert.equal(segments.length, 1, `exactly one ${name} segment may remain, got: ${segments.length}`);
		assert.notEqual(segments[0], dead, "the stale value must be replaced");
		assert.ok(seen.includes(session), "dsh_session must survive the rewrite");
		const minted = (res.headers["set-cookie"] ?? [])[0];
		assert.equal(segments[0], minted.split(";")[0], "the cookie the core read is the one handed to the browser");
	}, { credentials: BROWSER_RECORD, coreAuth: true });
});

test("inject: /api (wrapHttp) is authenticated on the same request too", async () => {
	await withPlugin(async ({ server, webServer }) => {
		// The gate normalizes the Host for /api, so the core reads the LOOPBACK
		// authority and the injected cookie must be bound to that authority.
		const res = await sendRaw(server, { path: "/api/costMeter/getStateSince", cookie: sessionCookie() });
		assert.equal(res.status, 200, "the first /api call must not 401");
		const authority = `127.0.0.1:${webServer.port ?? "3080"}`;
		const name = dshAuthCookieName(authority);
		const seen = webServer.coreCookieHeaders.at(-1);
		assert.ok(seen.includes(`${name}=`), `the core must have seen ${name}, got: ${seen}`);
		const minted = (res.headers["set-cookie"] ?? [])[0];
		assert.ok(minted.startsWith(`${name}=`), `the minted cookie is bound to ${authority}`);
	}, { credentials: BROWSER_RECORD, api: true, coreAuth: true });
});

test("inject: ?token= keeps the core's own 303 mint flow (nothing injected)", async () => {
	await withPlugin(async ({ server }) => {
		// First-install links carry the launch token; the core answers with its
		// own redirect+Set-Cookie. The plugin must not pre-empt that.
		const res = await sendRaw(server, { path: "/?token=launch-token", cookie: sessionCookie() });
		assert.equal(res.headers["set-cookie"], undefined, "a token link must not be pre-minted");
	}, { credentials: BROWSER_RECORD });
});

test("inject: an unauthenticated visitor still gets no dsh-auth cookie", async () => {
	await withPlugin(async ({ server, webServer }) => {
		// The gate semantics must not regress: signing a Host-bound cookie for
		// an anonymous GET would hand the core's browserAuth to any visitor.
		for (const path of ["/", "/sw.js", "/manifest.webmanifest"]) {
			const res = await sendRaw(server, { path });
			assert.equal(res.status, 200);
			assert.equal(res.headers["set-cookie"], undefined, `${path} must mint nothing`);
		}
		assert.ok(
			webServer.coreCookieHeaders.every((header) => !String(header ?? "").includes("dsh-auth-")),
			"no unauthenticated request may reach the core carrying a dsh-auth cookie"
		);
	}, { credentials: BROWSER_RECORD, coreAuth: true });
});
