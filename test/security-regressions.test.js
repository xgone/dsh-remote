import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, Config } from "../lib/index.js";
import { normalizeNextPath, renderLoginPage } from "../lib/login-page.js";

const SECRET = "a".repeat(64);
const BOOTSTRAP_TOKEN = "test-bootstrap-token-9f2c";

function sessionCookie(role = "admin") {
	const payload = { sub: "admin", role, iat: Date.now(), exp: Date.now() + 3600_000 };
	const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
	const signature = createHmac("sha256", SECRET).update(`v1.${encoded}`).digest("base64url");
	return `dsh_session=v1.${encoded}.${signature}`;
}

function makeWebServer() {
	const exact = new Map();
	const server = {
		exact, prefixes: new Map(), upgrades: new Map(), fallback: undefined, port: 3080,
		register(route) {
			(route.kind === "prefix" ? server.prefixes : exact).set(route.path, route);
			return () => {};
		},
		registerUpgrade() { return () => {}; },
		registerFallback(value) { server.fallback = value; return () => {}; },
		async readResource() { return new Response(null, { status: 404 }); }
	};
	return server;
}

function nodeRequest(url, { method = "GET", cookie, body, host = "dsh.example" } = {}) {
	const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
	req.url = url;
	req.method = method;
	req.headers = { host };
	if (cookie !== undefined) req.headers.cookie = cookie;
	req.socket = { remoteAddress: "127.0.0.1" };
	return req;
}

function response() {
	return {
		status: 200, headers: {}, body: "",
		setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; return this; },
		getHeader(name) { return this.headers[String(name).toLowerCase()]; },
		appendHeader(name, value) { this.headers[String(name).toLowerCase()] = value; return this; },
		writeHead(status, headers = {}) {
			this.status = status;
			for (const [name, value] of Object.entries(headers)) this.headers[name.toLowerCase()] = value;
			return this;
		},
		end(body = "") { this.body = String(body); return this; }
	};
}

async function withPlugin(config, run) {
	const dir = mkdtempSync(join(tmpdir(), "dsh-remote-sec-"));
	const webServer = makeWebServer();
	const ctx = {
		webServer,
		logger: { info() {}, warn() {}, error() {}, debug() {} },
		inject() { throw new Error("no optional services in this harness"); },
		emit() {},
		effect(fn) { fn(); return () => {}; }
	};
	apply(ctx, Config({
		enabled: true,
		secret: SECRET,
		storePath: join(dir, "accounts.json"),
		filesRootsPath: join(dir, "files-roots.json"),
		anonymousPathsPath: join(dir, "anonymous-paths.json"),
		gzip: { enabled: false },
		...config
	}));
	try {
		return await run({ webServer, dir });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── first-admin bootstrap ────────────────────────────────────────────────────

test("bootstrap: a loopback-looking Host is not enough without the bootstrap token", async () => {
	await withPlugin({ accounts: [], bootstrapToken: BOOTSTRAP_TOKEN }, async ({ webServer }) => {
		const route = webServer.exact.get("/auth/bootstrap");
		assert.ok(route, "bootstrap route registered");
		for (const payload of [
			{ username: "attacker", password: "hunter22" },
			{ username: "attacker", password: "hunter22", bootstrapToken: "wrong-token" }
		]) {
			const res = response();
			await route.handler(nodeRequest("/auth/bootstrap", {
				method: "POST",
				// A remote client can forge this header; the token is the real gate.
				host: "127.0.0.1",
				body: JSON.stringify(payload)
			}), res);
			assert.equal(res.status, 403, JSON.stringify(payload));
		}
	});
});

test("bootstrap: the correct token creates the first admin", async () => {
	await withPlugin({ accounts: [], bootstrapToken: BOOTSTRAP_TOKEN }, async ({ webServer }) => {
		const route = webServer.exact.get("/auth/bootstrap");
		const res = response();
		await route.handler(nodeRequest("/auth/bootstrap", {
			method: "POST",
			body: JSON.stringify({ username: "firstadmin", password: "hunter22", bootstrapToken: BOOTSTRAP_TOKEN })
		}), res);
		assert.equal(res.status, 200);
		assert.equal(JSON.parse(res.body).ok, true);
	});
});

// ── file viewer hardening ────────────────────────────────────────────────────

test("files: active content is served as plain text with a sandbox CSP", async () => {
	await withPlugin({ accounts: [{ username: "admin", password: "pw123456", role: "admin" }], files: { enabled: true, roots: [] } }, async ({ webServer, dir }) => {
		// Add the temp dir as an allowed root at runtime through the same store API.
		const filesRoute = webServer.exact.get("/auth/files");
		const add = response();
		await filesRoute.handler(nodeRequest("/auth/files", {
			method: "POST",
			cookie: sessionCookie("admin"),
			body: JSON.stringify({ action: "add", path: dir })
		}), add);
		assert.equal(add.status, 200, add.body);

		const file = join(dir, "report.html");
		writeFileSync(file, "<script>fetch('/auth/files')</script>");
		const route = webServer.exact.get("/auth/file");
		const res = response();
		await route.handler(nodeRequest(`/auth/file?path=${encodeURIComponent(file)}`, { method: "HEAD", cookie: sessionCookie("admin") }), res);
		assert.equal(res.status, 200);
		assert.match(String(res.headers["content-type"]), /^text\/plain/);
		assert.match(String(res.headers["content-security-policy"]), /sandbox/);
		assert.equal(res.headers["x-content-type-options"], "nosniff");
	});
});

test("files: the viewer route is absent when the feature is disabled", async () => {
	await withPlugin({ accounts: [{ username: "admin", password: "pw123456", role: "admin" }], files: { enabled: false } }, async ({ webServer }) => {
		assert.equal(webServer.exact.get("/auth/file"), undefined);
	});
});

test("session: logout revokes previously issued tokens server-side", async () => {
	await withPlugin({ accounts: [{ username: "admin", password: "pw123456", role: "admin" }], files: { enabled: false } }, async ({ webServer }) => {
		const cookie = sessionCookie("admin");
		const me1 = response();
		await webServer.exact.get("/auth/me").handler(nodeRequest("/auth/me", { cookie }), me1);
		assert.equal(JSON.parse(me1.body).authenticated, true);

		const out = response();
		await webServer.exact.get("/auth/logout").handler(nodeRequest("/auth/logout", { method: "POST", cookie, body: "{}" }), out);
		assert.equal(out.status, 200);

		const me2 = response();
		await webServer.exact.get("/auth/me").handler(nodeRequest("/auth/me", { cookie }), me2);
		assert.equal(JSON.parse(me2.body).authenticated, false, "the old token must be dead after logout");
	});
});

test("files: the account store is never readable even when its directory is an allowed root", async () => {
	await withPlugin({ accounts: [{ username: "admin", password: "pw123456", role: "admin" }], files: { enabled: true, roots: [] } }, async ({ webServer, dir }) => {
		const filesRoute = webServer.exact.get("/auth/files");
		const add = response();
		await filesRoute.handler(nodeRequest("/auth/files", {
			method: "POST",
			cookie: sessionCookie("admin"),
			body: JSON.stringify({ action: "add", path: dir })
		}), add);
		assert.equal(add.status, 200, add.body);
		const secretFile = join(dir, "accounts.json"); // == the configured storePath
		writeFileSync(secretFile, '{"secret":"do-not-leak"}');
		const res = response();
		await webServer.exact.get("/auth/file").handler(
			nodeRequest(`/auth/file?path=${encodeURIComponent(secretFile)}`, { method: "HEAD", cookie: sessionCookie("admin") }), res);
		assert.equal(res.status, 403);
	});
});

test("mfa: starting a binding without the current password is refused", async () => {
	await withPlugin({ accounts: [{ username: "admin", password: "pw123456", role: "admin" }], files: { enabled: false } }, async ({ webServer }) => {
		const res = response();
		await webServer.exact.get("/auth/mfa/setup").handler(
			nodeRequest("/auth/mfa/setup", { method: "POST", cookie: sessionCookie("admin"), body: "{}" }), res);
		assert.equal(res.status, 400);
	});
});

// ── redirect target sanitisation ─────────────────────────────────────────────

test("login page: only same-origin absolute next paths survive", () => {
	assert.equal(normalizeNextPath("/dashboard"), "/dashboard");
	assert.equal(normalizeNextPath("/a/b?x=1#f"), "/a/b?x=1#f");
	for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example", "javascript:alert(1)", "", null, "/a\nb", "/a\rb"]) {
		assert.equal(normalizeNextPath(bad), "/", String(bad));
	}
	const html = renderLoginPage({ bootstrap: false, next: "//evil.example", lang: "en" });
	assert.ok(html.includes('var next = "/"'), "reflected next is neutralised");
	assert.doesNotMatch(html, /var next = "\/\/evil\.example"/);
	assert.match(html, /<script nonce="/, "inline script carries a CSP nonce");
	assert.match(html, /script-src 'nonce-/, "CSP nonce policy present");
});
