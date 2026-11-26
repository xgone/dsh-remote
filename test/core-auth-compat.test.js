import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnonymousPathsStore } from "../lib/anonymous-paths-store.js";
import { apply, canonicalAuthority, Config, hasLiveDshAuthCookie } from "../lib/index.js";

const HARNESS_SECRET = "0".repeat(64);
const BROWSER_SECRET = randomBytes(32);
const BROWSER_RECORD = { kind: "grant", payload: { version: 1, secret: BROWSER_SECRET.toString("base64url") } };
const CORE_PEER = { principal: { kind: "owner" } };

function sessionCookie(username = "admin") {
	const payload = { sub: username, role: "admin", iat: Date.now(), exp: Date.now() + 3600_000 };
	const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
	const signature = createHmac("sha256", HARNESS_SECRET).update(`v1.${encoded}`).digest("base64url");
	return `dsh_session=v1.${encoded}.${signature}`;
}

function makeWebServer(fallback) {
	const exact = new Map();
	const prefixes = new Map();
	const upgrades = new Map();
	const server = {
		exact, prefixes, upgrades, fallback, port: 3080,
		register(route) {
			const table = route.kind === "prefix" ? prefixes : exact;
			table.set(route.path, route);
			return () => table.delete(route.path);
		},
		registerUpgrade(route) {
			upgrades.set(route.path, route);
			return () => upgrades.delete(route.path);
		},
		registerFallback(value) {
			server.fallback = value;
			return () => { server.fallback = undefined; };
		},
		async readResource(request, peer) {
			const route = exact.get(new URL(request.url).pathname);
			if (typeof route?.resource === "function") return route.resource(request, peer);
			if (typeof server.fallback?.resource === "function") return server.fallback.resource(request, peer);
			return new Response(null, { status: 404 });
		}
	};
	return server;
}

function nodeRequest(url, cookie) {
	const req = Readable.from([]);
	req.url = url;
	req.method = "GET";
	req.headers = { host: "dsh.example" };
	if (cookie !== undefined) req.headers.cookie = cookie;
	req.socket = { remoteAddress: "127.0.0.1" };
	return req;
}

function response() {
	return {
		status: 200,
		headers: {},
		body: "",
		writeHead(status, headers = {}) {
			this.status = status;
			this.headers = headers;
			return this;
		},
		end(body = "") {
			this.body = String(body);
			return this;
		}
	};
}

async function withPlugin({ coreAuth = false, routes = [], fallback, anonymousPaths = [], credentials = false } = {}, run) {
	const dir = mkdtempSync(join(tmpdir(), "dsh-remote-core-auth-"));
	const webServer = makeWebServer(fallback);
	for (const route of routes) webServer.register(route);
	const anonymousPathsFile = join(dir, "anonymous-paths.json");
	const anonymousPathStore = new AnonymousPathsStore(anonymousPathsFile);
	for (const path of anonymousPaths) {
		const added = anonymousPathStore.add(path);
		assert.equal(added.ok, true, added.error);
	}
	anonymousPathStore.save();
	const ctx = {
		webServer,
		logger: { info() {}, warn() {}, error() {}, debug() {} },
		inject(services, callback) {
			if (services.includes("connection.authentication")) {
				if (!coreAuth) throw new Error("pre-0.2.3 host has no route authentication provider");
				callback({ "connection.authentication": {
					authenticate(request) {
						const headers = request.headers;
						const host = headers instanceof Headers ? headers.get("host") : headers?.host;
					const cookie = headers instanceof Headers ? headers.get("cookie") : headers?.cookie;
					return typeof host === "string" && hasLiveDshAuthCookie(cookie, canonicalAuthority(host), BROWSER_SECRET)
						? { peer: CORE_PEER }
						: { rejection: 401 };
					}
				} });
				return;
			}
			if (services.includes("credentials") && credentials) {
				callback({ credentials: { readRecord: async () => BROWSER_RECORD } });
				return;
			}
			throw new Error(`service unavailable in this test: ${services.join(", ")}`);
		},
		emit() {},
		effect(fn) { fn(); return () => {}; },
		dir
	};
	apply(ctx, Config({
		enabled: true,
		secret: HARNESS_SECRET,
		storePath: join(dir, "accounts.json"),
		filesRootsPath: join(dir, "files-roots.json"),
		anonymousPathsPath: anonymousPathsFile,
		accounts: [{ username: "admin", password: "test-password", role: "admin" }],
		gzip: { enabled: false },
		files: { enabled: false }
	}));
	try {
		return await run({ webServer });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("dsh 0.2.3 auth: the anonymous Remote root route uses dsh-remote login and then reaches the app", async () => {
	await withPlugin({ coreAuth: true }, async ({ webServer }) => {
		webServer.register({
			kind: "exact",
			path: "/",
			auth: "anonymous",
			resource: async (request) => new Response(new URL(request.url).searchParams.has("login")
				? "official Remote login page"
				: "application shell")
		});
		const root = webServer.exact.get("/");
		const anonymous = await root.resource(new Request("http://dsh.example/?login=qr", { headers: { host: "dsh.example" } }));
		assert.equal(anonymous.status, 200);
		assert.match(await anonymous.text(), /<form/i, "dsh-remote owns the login screen");

		const authenticated = await root.resource(new Request("http://dsh.example/?login=qr", {
			headers: { host: "dsh.example", cookie: sessionCookie() }
		}));
		assert.equal(authenticated.status, 200);
		assert.equal(await authenticated.text(), "application shell");
	});
});

test("dsh 0.2.3 auth: dsh-remote login issues the Core cookie used by the anonymous Remote root", async () => {
	await withPlugin({ coreAuth: true, credentials: true }, async ({ webServer }) => {
		webServer.register({
			kind: "exact",
			path: "/",
			auth: "anonymous",
			resource: async (_request, peer) => new Response(peer === CORE_PEER ? "app authenticated by dsh-remote" : "missing Core Peer", {
				status: peer === CORE_PEER ? 200 : 401
			})
		});
		const root = webServer.exact.get("/");
		const loggedOut = await root.resource(new Request("http://dsh.example/", { headers: { host: "dsh.example" } }));
		assert.equal(loggedOut.status, 200);
		assert.match(await loggedOut.text(), /<form/i, "dsh-remote replaces the official Remote login screen");

		const loggedIn = await root.resource(new Request("http://dsh.example/?login=qr", {
			headers: { host: "dsh.example", cookie: sessionCookie() }
		}));
		assert.equal(loggedIn.status, 200);
		assert.equal(await loggedIn.text(), "app authenticated by dsh-remote");
		assert.ok(loggedIn.headers.getSetCookie().some((cookie) => cookie.startsWith("dsh-auth-")));
	});
});

test("dsh 0.2.3 auth: anonymous node routes still pass the dsh-remote gate", async () => {
	await withPlugin({ coreAuth: true }, async ({ webServer }) => {
		webServer.register({
			kind: "exact",
			path: "/connect",
			auth: "anonymous",
			handler(_req, res) {
				res.writeHead(302, { location: "/api/remote.mux" });
				res.end();
			}
		});
		const route = webServer.exact.get("/connect");
		const denied = response();
		await route.handler(nodeRequest("/connect"), denied);
		assert.equal(denied.status, 403, "the host's anonymous policy must not skip dsh-remote's login gate");
		const allowed = response();
		await route.handler(nodeRequest("/connect", sessionCookie()), allowed);
		assert.equal(allowed.status, 302);
		assert.equal(allowed.headers.location, "/api/remote.mux");
	});
});

test("dsh 0.2.3 auth: configured anonymous prefixes also bypass the host credential policy", async () => {
	await withPlugin({ coreAuth: true, anonymousPaths: ["/plugin/webhook"], routes: [{
		kind: "prefix",
		path: "/plugin/webhook",
		handler(_req, res) {
			res.writeHead(200);
			res.end("plugin reached");
		}
	}] }, async ({ webServer }) => {
		const route = webServer.prefixes.get("/plugin/webhook");
		assert.equal(route.auth({
			headers: {}, method: "POST", url: new URL("http://dsh.example/plugin/webhook/event"), transport: "http"
		}), "anonymous");
		const allowed = response();
		await route.handler(nodeRequest("/plugin/webhook/event"), allowed);
		assert.equal(allowed.status, 200);
		const sibling = response();
		await route.handler(nodeRequest("/plugin/webhookfoo"), sibling);
		assert.equal(sibling.status, 403, "path-prefix matching must retain segment boundaries");
	});
});

test("dsh 0.2.3 auth: legacy hosts still gate Node and resource routes with an unknown auth field", async () => {
	await withPlugin({ coreAuth: false, routes: [{
		kind: "exact",
		path: "/connect",
		auth: "anonymous",
		handler(_req, res) { res.end("must stay behind the legacy gate"); }
	}, {
		kind: "exact",
		path: "/remote-root",
		auth: "anonymous",
		resource: async () => new Response("must stay behind the legacy gate")
	}] }, async ({ webServer }) => {
		const result = response();
		await webServer.exact.get("/connect").handler(nodeRequest("/connect"), result);
		assert.equal(result.status, 403);
		const resource = await webServer.exact.get("/remote-root").resource(new Request("http://dsh.example/remote-root"));
		assert.equal(resource.status, 403);
	});
});

test("dsh 0.2.3 auth: named Node handlers preserve the admitted Peer for Connection routes", async () => {
	const peer = { principal: { kind: "owner" } };
	await withPlugin({ coreAuth: true, routes: [{
		kind: "prefix",
		path: "/api",
		auth: "required",
		handler(_req, res, admitted) {
			res.writeHead(admitted === peer ? 200 : 500);
			res.end(admitted === peer ? "peer preserved" : "peer lost");
		}
	}] }, async ({ webServer }) => {
		const result = response();
		await webServer.prefixes.get("/api").handler(nodeRequest("/api/session.list", sessionCookie()), result, peer);
		assert.equal(result.status, 200);
		assert.equal(result.body, "peer preserved");
	});
});

test("dsh 0.2.3 auth: an HTTP resource Peer does not replace dsh-remote auth, while readResource peers pass", async () => {
	const peer = { principal: { kind: "owner" } };
	await withPlugin({ coreAuth: true }, async ({ webServer }) => {
		webServer.register({
			kind: "exact",
			path: "/private-resource",
			auth: "required",
			resource: async (_request, admitted) => new Response(admitted === peer ? "resource reached" : "peer lost")
		});
		const route = webServer.exact.get("/private-resource");
		const url = "http://dsh.example/private-resource";
		const unauthenticated = await route.resource(new Request(url), peer);
		assert.equal(unauthenticated.status, 403, "an HTTP Peer alone must not skip dsh-remote login");
		const authenticated = await route.resource(new Request(url, { headers: { cookie: sessionCookie() } }), peer);
		assert.equal(authenticated.status, 200);
		assert.equal(await authenticated.text(), "resource reached");
		const inProcess = await webServer.readResource(new Request(url), peer);
		assert.equal(inProcess.status, 200, "the host's admitted in-process read remains direct");
		assert.equal(await inProcess.text(), "resource reached");
	});
});

test("dsh 0.2.3 auth: Node upgrade handlers preserve the admitted Peer", async () => {
	const peer = { principal: { kind: "owner" } };
	await withPlugin({ coreAuth: true }, async ({ webServer }) => {
		let seenPeer;
		webServer.registerUpgrade({
			path: "/api/remote.mux",
			auth: "required",
			handler(_req, _socket, _head, admitted) { seenPeer = admitted; }
		});
		const socket = { writable: true, destroyed: false, end() {}, destroy() { this.destroyed = true; } };
		webServer.upgrades.get("/api/remote.mux").handler(nodeRequest("/api/remote.mux", sessionCookie()), socket, Buffer.alloc(0), peer);
		assert.equal(seenPeer, peer);
	});
});

test("dsh 0.2.3 auth: Node fallback handlers preserve the admitted Peer", async () => {
	const peer = { principal: { kind: "owner" } };
	let seenPeer;
	await withPlugin({ coreAuth: true, fallback: {
		auth: "required",
		handler(_req, res, admitted) {
			seenPeer = admitted;
			res.writeHead(200, { "content-type": "text/html" });
			res.end("index");
		}
	} }, async ({ webServer }) => {
		const result = response();
		await webServer.fallback.handler(nodeRequest("/", sessionCookie()), result, peer);
		assert.equal(result.status, 200);
		assert.equal(seenPeer, peer);
	});
});

test("dsh 0.2.3 auth: dsh-remote's own auth routes and SPA fallback are host-anonymous but still gated by dsh-remote", async () => {
	const fallback = {
		resource: async () => new Response("core index")
	};
	await withPlugin({ coreAuth: true, fallback }, async ({ webServer }) => {
		assert.equal(webServer.exact.get("/auth/login").auth, "anonymous");
		assert.equal(webServer.fallback.auth, "anonymous");
		const page = await webServer.fallback.resource(new Request("http://dsh.example/"));
		assert.equal(page.status, 200);
		assert.match(await page.text(), /<form/i);
	});
});
