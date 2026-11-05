/**
 * Tests for the dsh ≥ 0.2.2-alpha "resource" webserver shape.
 *
 * That release refactored the webserver so a route or the fallback seat may be
 * a Fetch resource — `(request, peer?) => Promise<Response>` — instead of a
 * node:http handler. frontend-static now claims the fallback seat with a
 * resource and /plugins/* is a resource prefix route. Before the fix the node
 * wrappers saw a non-function and left it unwrapped, so an unauthenticated
 * visitor fell through to the core, whose `authorizeIndex` demanded the launch
 * token the terminal prints (`dsh web: …?token=`) — exactly issue #27.
 *
 * These tests drive `apply()` against a fake core that uses the resource shape
 * and assert the login gate, the PWA passthrough and the 403 non-page denial
 * all survive it — plus that an authenticated document still gets the minted
 * core cookie injected on the resource path.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Config,
	apply,
	canonicalAuthority,
	encodeDshAuthCookie,
	hasLiveDshAuthCookie,
	isPwaAssetPath,
} from "../lib/index.js";

const HARNESS_SECRET = "0".repeat(64);
const BROWSER_SECRET = randomBytes(32);
const BROWSER_RECORD = { kind: "grant", payload: { version: 1, secret: BROWSER_SECRET.toString("base64url") } };
const HOST = "dsh.facaix.fun";

/** A `dsh_session` cookie signed the way `issueSession` signs it. */
function sessionCookie(username = "admin") {
	const payload = { sub: username, role: "admin", iat: Date.now(), exp: Date.now() + 3600_000 };
	const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
	const sig = createHmac("sha256", HARNESS_SECRET).update(`v1.${encoded}`).digest("base64url");
	return `dsh_session=v1.${encoded}.${sig}`;
}

/**
 * A fake core whose fallback seat is a Fetch resource and whose /plugins/*
 * prefix is a resource route — the shape dsh 0.2.2-alpha installed. `coreAuth`
 * makes the fallback behave like frontend-static's authorizeIndex: it rejects a
 * DOCUMENT request whose Cookie lacks a live dsh-auth cookie bound to the Host
 * it sees (the 401 that sent the reporter to the terminal token).
 */
function resourceCore({ coreAuth = false } = {}) {
	const exact = new Map();
	const prefixes = new Map();
	const upgrades = new Map();
	const calls = [];
	const webServer = {
		exact, prefixes, upgrades, calls, port: 3080,
		fallback: undefined,
		register(route) {
			const map = route.kind === "prefix" ? prefixes : exact;
			map.set(route.path, { ...route });
			return () => map.delete(route.path);
		},
		registerUpgrade(route) {
			upgrades.set(route.path, { ...route });
			return () => upgrades.delete(route.path);
		},
		registerFallback(fallback) {
			webServer.fallback = fallback;
			return () => { webServer.fallback = undefined; };
		},
	};
	// dsh 0.2.2-alpha serves /plugins/* bundles through a resource prefix route.
	prefixes.set("/plugins/", {
		kind: "prefix",
		path: "/plugins/",
		resource: async () => new Response("BUNDLE", { status: 200, headers: { "content-type": "text/javascript" } }),
	});
	webServer.fallback = {
		resource: async (request, peer) => {
			const pathname = new URL(request.url).pathname;
			calls.push({ pathname, cookie: request.headers.get("cookie"), host: request.headers.get("host") });
			if (isPwaAssetPath(pathname)) {
				return new Response(`ASSET:${pathname}`, { status: 200, headers: { "content-type": "application/octet-stream" } });
			}
			// frontend-static skips `authorizeIndex` for an in-process read whose
			// caller admitted the Peer (`() => peer === undefined ? authorizeIndex(request) : undefined`);
			// only an HTTP request (no Peer) carries the browser-authentication check.
			if (coreAuth && peer === undefined) {
				const authority = canonicalAuthority(request.headers.get("host"));
				if (!hasLiveDshAuthCookie(request.headers.get("cookie"), authority, BROWSER_SECRET)) {
					return new Response("dsh web authentication required; reopen the URL printed by dsh web.", {
						status: 401, headers: { "content-type": "text/plain", "cache-control": "no-store" },
					});
				}
			}
			return new Response("CORE_INDEX", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
		},
	};
	return webServer;
}

function fakeCtx(webServer, dir) {
	const disposers = [];
	const ctx = {
		webServer,
		logger: { info() {}, warn() {}, error() {}, debug() {} },
		inject() { throw new Error("no credentials service in this fake"); },
		emit() {},
		effect(fn) { disposers.push(fn()); return () => {}; },
		dir,
	};
	return ctx;
}

function mintingCtx(webServer, dir) {
	const ctx = fakeCtx(webServer, dir);
	ctx.inject = (services, cb) => { cb({ credentials: { readRecord: async () => BROWSER_RECORD } }); };
	return ctx;
}

/** Apply the plugin to a resource-shaped fake core; build Fetch requests in `run`. */
async function withPlugin(run, { coreAuth = false, credentials = false } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "dsh-remote-res-"));
	const webServer = resourceCore({ coreAuth });
	const ctx = credentials ? mintingCtx(webServer, dir) : fakeCtx(webServer, dir);
	apply(ctx, Config({
		enabled: true,
		secret: HARNESS_SECRET,
		storePath: join(dir, "accounts.json"),
		filesRootsPath: join(dir, "files-roots.json"),
		accounts: [{ username: "admin", password: "admin-password", role: "admin" }],
		files: { enabled: false },
	}));
	try {
		return await run({ webServer });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** A Fetch Request as the webserver's serveResource would build it. */
const request = (path, { method = "GET", cookie, host = HOST } = {}) => {
	const headers = { host };
	if (cookie !== undefined) headers.cookie = cookie;
	return new Request(`http://x${path}`, { method, headers });
};

test("resource fallback: apply() wraps the Fetch resource (not left as a non-function)", async () => {
	await withPlugin(async ({ webServer }) => {
		assert.ok(webServer.fallback && typeof webServer.fallback === "object", "fallback stays an object seat");
		assert.equal(typeof webServer.fallback.resource, "function", "the resource is wrapped");
	});
});

test("resource fallback: an unauthenticated document shows the login page, never the core 401", async () => {
	await withPlugin(async ({ webServer }) => {
		const res = await webServer.fallback.resource(request("/"));
		assert.equal(res.status, 200);
		const body = await res.text();
		assert.match(res.headers.get("content-type") ?? "", /text\/html/);
		assert.match(body, /<!doctype html>/i);
		assert.match(body, /\/auth\/(bootstrap|login)/);
		assert.equal(webServer.calls.length, 0, "the core must NOT be reached for an unauthenticated document");
	});
});

test("resource fallback: an unauthenticated PWA asset is forwarded and marked no-store", async () => {
	await withPlugin(async ({ webServer }) => {
		const res = await webServer.fallback.resource(request("/manifest.webmanifest"));
		assert.equal(res.status, 200);
		assert.equal(await res.text(), "ASSET:/manifest.webmanifest");
		assert.equal(res.headers.get("cache-control"), "no-store");
		assert.equal(webServer.calls.length, 1, "the public PWA file is served by the core");
	});
});

test("resource fallback: an unauthenticated non-page request is a 403, not the core", async () => {
	await withPlugin(async ({ webServer }) => {
		const res = await webServer.fallback.resource(request("/api/session.prompt", { method: "POST" }));
		assert.equal(res.status, 403);
		assert.deepEqual(await res.json(), { ok: false, error: "unauthorized" });
		assert.equal(webServer.calls.length, 0);
	});
});

test("resource fallback: an authenticated document reaches the core with a healed dsh-auth cookie", async () => {
	await withPlugin(async ({ webServer }) => {
		const res = await webServer.fallback.resource(request("/", { cookie: sessionCookie() }));
		assert.equal(res.status, 200);
		assert.equal(await res.text(), "CORE_INDEX");
		const seen = webServer.calls.at(-1);
		assert.equal(seen.host, HOST);
		assert.match(String(seen.cookie), /dsh_session=/);
		const authority = canonicalAuthority(HOST);
		assert.ok(
			hasLiveDshAuthCookie(seen.cookie, authority, BROWSER_SECRET),
			"the core must receive a live dsh-auth cookie for the Host it sees",
		);
		const setCookie = res.headers.getSetCookie();
		assert.ok(setCookie.some((c) => c.startsWith("dsh-auth-")), "the response hands the browser the same cookie");
	}, { coreAuth: true, credentials: true });
});

test("resource route: a /plugins/* prefix resource requires a session", async () => {
	await withPlugin(async ({ webServer }) => {
		const route = webServer.prefixes.get("/plugins/");
		assert.ok(route && typeof route.resource === "function", "the prefix resource is wrapped");
		const denied = await route.resource(request("/plugins/x/bundle.js"));
		assert.equal(denied.status, 403);
		const allowed = await route.resource(request("/plugins/x/bundle.js", { cookie: sessionCookie() }));
		assert.equal(allowed.status, 200);
	});
});

// ── in-process reads: webServer.readResource(request, peer) ───────────────────
//
// dsh >= 0.2.2 added `webServer.readResource(request, peer)`: it answers, without
// an HTTP exchange, what the same URL would return, computing the response for
// the Peer its CALLER already admitted. The host contract is explicit that such
// a read checks no cookie, Host or Origin ("its caller admits the reader
// first"), and frontend-static renders the page for that Peer. The gate must
// therefore authenticate only a Peer-less request; re-applying the session
// cookie check to an admitted read would answer a login page (or a 403) to an
// in-process caller that never had a jar.

/** A PeerScope as the host passes it to a resource on an admitted read. */
const admittedPeer = { principal: { kind: "owner" } };

test("resource fallback: an admitted in-process read gets the core page, not the login page", async () => {
	await withPlugin(async ({ webServer }) => {
		const res = await webServer.fallback.resource(request("/"), admittedPeer);
		assert.equal(res.status, 200);
		assert.equal(await res.text(), "CORE_INDEX", "the admitted reader reaches the core");
		assert.equal(webServer.calls.length, 1);
		assert.match(res.headers.get("content-type") ?? "", /text\/html/);
	});
});

test("resource fallback: an admitted read never mints or injects a browser cookie", async () => {
	await withPlugin(async ({ webServer }) => {
		const res = await webServer.fallback.resource(request("/"), admittedPeer);
		assert.equal(res.status, 200);
		assert.equal(res.headers.getSetCookie().length, 0, "no jar exists for an in-process reader");
		const seen = webServer.calls.at(-1);
		assert.ok(!seen.cookie, "the cookie header is not manufactured for the read");
	}, { coreAuth: true, credentials: true });
});

test("resource fallback: a Peer-less request is still gated (the peer check is not a bypass)", async () => {
	await withPlugin(async ({ webServer }) => {
		const res = await webServer.fallback.resource(request("/"));
		assert.equal(res.status, 200);
		assert.match(await res.text(), /<!doctype html>/i, "without a Peer the visitor gets the login page");
		assert.equal(webServer.calls.length, 0, "the core is never reached");
	});
});

test("resource route: an admitted in-process read of /plugins/* skips the session gate", async () => {
	await withPlugin(async ({ webServer }) => {
		const route = webServer.prefixes.get("/plugins/");
		assert.ok(route && typeof route.resource === "function", "the prefix resource is wrapped");
		const allowed = await route.resource(request("/plugins/x/bundle.js"), admittedPeer);
		assert.equal(allowed.status, 200);
		assert.equal(await allowed.text(), "BUNDLE");
		// ...while the same path without a Peer still requires the session.
		const denied = await route.resource(request("/plugins/x/bundle.js"));
		assert.equal(denied.status, 403);
	});
});
