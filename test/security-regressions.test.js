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

function nodeRequest(url, { method = "GET", cookie, body, host = "dsh.example", remoteAddress = "127.0.0.1", headers = {} } = {}) {
	const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
	req.url = url;
	req.method = method;
	req.headers = { host, ...headers };
	if (cookie !== undefined) req.headers.cookie = cookie;
	req.socket = { remoteAddress };
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

test("bootstrap: a remote client cannot bootstrap by forging a loopback Host", async () => {
	await withPlugin({ accounts: [] }, async ({ webServer }) => {
		const route = webServer.exact.get("/auth/bootstrap");
		assert.ok(route, "bootstrap route registered");
		const forged = [
			// Remote socket + loopback Host (the old exploit).
			nodeRequest("/auth/bootstrap", {
				method: "POST", host: "127.0.0.1", remoteAddress: "203.0.113.5",
				body: JSON.stringify({ username: "attacker", password: "hunter22" })
			}),
			// Loopback socket but a proxied request (forwarding header present).
			nodeRequest("/auth/bootstrap", {
				method: "POST", host: "127.0.0.1",
				headers: { "x-forwarded-for": "203.0.113.5" },
				body: JSON.stringify({ username: "attacker", password: "hunter22" })
			}),
			// Public Host on a loopback socket (an nginx-style proxy preserving Host).
			nodeRequest("/auth/bootstrap", {
				method: "POST", host: "gateway.example",
				body: JSON.stringify({ username: "attacker", password: "hunter22" })
			})
		];
		for (const request of forged) {
			const res = response();
			await route.handler(request, res);
			assert.equal(res.status, 403, `${request.headers.host} ${request.socket.remoteAddress}`);
		}
	});
});

test("bootstrap: a local browser keeps the username + password flow (no token)", async () => {
	await withPlugin({ accounts: [] }, async ({ webServer }) => {
		const res = response();
		await webServer.exact.get("/auth/bootstrap").handler(nodeRequest("/auth/bootstrap", {
			method: "POST", host: "127.0.0.1",
			body: JSON.stringify({ username: "firstadmin", password: "hunter22" })
		}), res);
		assert.equal(res.status, 200);
		assert.equal(JSON.parse(res.body).ok, true);
	});
});

test("bootstrap: a proxied deployment may configure a bootstrap token", async () => {
	await withPlugin({ accounts: [], bootstrapToken: BOOTSTRAP_TOKEN }, async ({ webServer }) => {
		const route = webServer.exact.get("/auth/bootstrap");
		const proxied = (token) => nodeRequest("/auth/bootstrap", {
			method: "POST", host: "gateway.example",
			headers: { "x-forwarded-for": "203.0.113.5" },
			body: JSON.stringify({ username: "firstadmin", password: "hunter22", bootstrapToken: token })
		});
		const denied = response();
		await route.handler(proxied("wrong-token-value"), denied);
		assert.equal(denied.status, 403);
		const allowed = response();
		await route.handler(proxied(BOOTSTRAP_TOKEN), allowed);
		assert.equal(allowed.status, 200);
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
