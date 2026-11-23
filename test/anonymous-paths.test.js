import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Readable } from "node:stream";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnonymousPathsStore, matchesAnonymousPath, normalizeAnonymousPath } from "../lib/anonymous-paths-store.js";
import { apply, Config } from "../lib/index.js";

const HARNESS_SECRET = "0".repeat(64);

function sessionCookie(username = "admin") {
	const payload = { sub: username, role: "admin", iat: Date.now(), exp: Date.now() + 3600_000 };
	const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
	const signature = createHmac("sha256", HARNESS_SECRET).update(`v1.${encoded}`).digest("base64url");
	return `dsh_session=v1.${encoded}.${signature}`;
}

function webServer() {
	const exact = new Map();
	const prefixes = new Map();
	const upgrades = new Map();
	const server = {
		exact, prefixes, upgrades, fallback: undefined, port: 3080,
		register(route) {
			const map = route.kind === "prefix" ? prefixes : exact;
			map.set(route.path, route);
			return () => map.delete(route.path);
		},
		registerUpgrade(route) {
			upgrades.set(route.path, route);
			return () => upgrades.delete(route.path);
		},
		registerFallback(fallback) {
			server.fallback = fallback;
			return () => { server.fallback = undefined; };
		}
	};
	return server;
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

function nodeRequest(url, { method = "GET", cookie, body } = {}) {
	const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
	req.url = url;
	req.method = method;
	req.headers = { host: "dsh.example" };
	if (cookie !== undefined) req.headers.cookie = cookie;
	req.socket = { remoteAddress: "127.0.0.1" };
	return req;
}

async function withPlugin(paths, run) {
	const dir = mkdtempSync(join(tmpdir(), "dsh-remote-anonymous-paths-"));
	const server = webServer();
	const pathStore = new AnonymousPathsStore(join(dir, "anonymous-paths.json"));
	for (const path of paths) {
		const result = pathStore.add(path);
		assert.equal(result.ok, true, result.error);
	}
	pathStore.save();
	const ctx = {
		webServer: server,
		logger: { info() {}, warn() {}, error() {}, debug() {} },
		inject() { throw new Error("credentials service is not configured in this test"); },
		emit() {},
		effect(fn) { fn(); return () => {}; },
		dir
	};
	apply(ctx, Config({
		enabled: true,
		secret: HARNESS_SECRET,
		storePath: join(dir, "accounts.json"),
		filesRootsPath: join(dir, "files-roots.json"),
		anonymousPathsPath: join(dir, "anonymous-paths.json"),
		accounts: [{ username: "admin", password: "test-password", role: "admin" }],
		files: { enabled: false }
	}));
	try {
		return await run({ server, dir });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

async function callNode(handler, url, options) {
	const res = response();
	await handler(nodeRequest(url, options), res);
	return res;
}

test("anonymous paths: normalizes prefixes and rejects dangerous or ambiguous forms", () => {
	assert.deepEqual(normalizeAnonymousPath(" /plugin/mcp/ "), { ok: true, path: "/plugin/mcp" });
	for (const path of ["", "/", "relative", "//host/path", "/api", "/api/other", "/auth", "/auth/files", "/x/%2e%2e", "/x?a=1", "/x#hash", "/x\\y", "/x//y", "/x/../y"]) {
		assert.equal(normalizeAnonymousPath(path).ok, false, path);
	}
});

test("anonymous paths: matches exact paths and descendants at segment boundaries only", () => {
	const allowed = ["/dsh-oh-my-claude/mcp"];
	assert.equal(matchesAnonymousPath("/dsh-oh-my-claude/mcp", allowed), true);
	assert.equal(matchesAnonymousPath("/dsh-oh-my-claude/mcp/session-1", allowed), true);
	assert.equal(matchesAnonymousPath("/dsh-oh-my-claude/mcpfoo", allowed), false);
	assert.equal(matchesAnonymousPath("/dsh-oh-my-claude/mcp/%2e%2e/api", allowed), false);
	assert.equal(matchesAnonymousPath("/dsh-oh-my-claude/mcp/../api", allowed), false);
});

test("anonymous paths: store normalizes, persists, deduplicates and removes entries", () => {
	const dir = mkdtempSync(join(tmpdir(), "dsh-remote-anonymous-store-"));
	try {
		const path = join(dir, "paths.json");
		const store = new AnonymousPathsStore(path);
		store.load();
		assert.deepEqual(store.add("/plugin/mcp/"), { ok: true, changed: true, path: "/plugin/mcp" });
		assert.deepEqual(store.add("/plugin/mcp"), { ok: true, changed: false, path: "/plugin/mcp" });
		store.add("/plugin/webhook");
		store.save();
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).paths, ["/plugin/mcp", "/plugin/webhook"]);
		const loaded = new AnonymousPathsStore(path);
		loaded.load();
		assert.deepEqual(loaded.list(), ["/plugin/mcp", "/plugin/webhook"]);
		assert.equal(loaded.remove("/plugin/mcp/"), true);
		assert.deepEqual(loaded.list(), ["/plugin/webhook"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("anonymous paths: an admin can add an endpoint live; the route then bypasses the session gate", async () => {
	await withPlugin([], async ({ server, dir }) => {
		server.register({
			kind: "prefix",
			path: "/plugin/bridge",
			handler(_req, res) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end("bridge reached");
			}
		});
		const bridge = server.prefixes.get("/plugin/bridge");
		assert.equal((await callNode(bridge.handler, "/plugin/bridge/session-1", { method: "POST" })).status, 403);

		const management = server.exact.get("/auth/anonymous-paths");
		const denied = await callNode(management.handler, "/auth/anonymous-paths", { method: "POST", body: { action: "add", path: "/plugin/bridge" } });
		assert.equal(denied.status, 401, "the settings endpoint requires an admin session");

		const added = await callNode(management.handler, "/auth/anonymous-paths", {
			method: "POST", cookie: sessionCookie(), body: { action: "add", path: "/plugin/bridge" }
		});
		assert.equal(added.status, 200);
		assert.deepEqual(JSON.parse(added.body).paths, ["/plugin/bridge"]);
		assert.deepEqual(JSON.parse(readFileSync(join(dir, "anonymous-paths.json"), "utf8")).paths, ["/plugin/bridge"]);

		const passed = await callNode(bridge.handler, "/plugin/bridge/session-1", { method: "POST" });
		assert.equal(passed.status, 200);
		assert.equal(passed.body, "bridge reached");
		const sibling = await callNode(bridge.handler, "/plugin/bridgefoo", { method: "POST" });
		assert.equal(sibling.status, 403, "prefix matching must respect the path-segment boundary");
	});
});

test("anonymous paths: resource routes bypass only configured raw prefixes", async () => {
	await withPlugin(["/plugin/mcp"], async ({ server }) => {
		server.register({
			kind: "prefix",
			path: "/plugin/mcp",
			resource: async () => new Response("resource reached")
		});
		const route = server.prefixes.get("/plugin/mcp");
		const allowed = await route.resource(new Request("http://dsh.example/plugin/mcp/session-1", { method: "POST" }));
		assert.equal(allowed.status, 200);
		assert.equal(await allowed.text(), "resource reached");
		const sibling = await route.resource(new Request("http://dsh.example/plugin/mcpfoo", { method: "POST" }));
		assert.equal(sibling.status, 403);
	});
});
