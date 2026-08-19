import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { gunzipSync } from "node:zlib";
import {
	ORIGINAL_HOST,
	isRemoteOrigin,
	shouldGzip,
	shouldCache,
	makeGzipRes,
} from "../lib/index.js";

// ── unit: isRemoteOrigin ───────────────────────────────────────────────────────

test("isRemoteOrigin: loopback hosts are local", () => {
	for (const host of ["127.0.0.1:3080", "localhost:3080", "[::1]:3080", "127.0.0.1"]) {
		assert.equal(isRemoteOrigin({ [ORIGINAL_HOST]: host }), false, `expected local: ${host}`);
	}
});

test("isRemoteOrigin: non-loopback hosts are remote", () => {
	for (const host of ["dsh.facaix.fun", "192.168.1.10:3080", "10.0.0.5"]) {
		assert.equal(isRemoteOrigin({ [ORIGINAL_HOST]: host }), true, `expected remote: ${host}`);
	}
});

test("isRemoteOrigin: missing original host is treated as remote", () => {
	assert.equal(isRemoteOrigin({}), true);
});

// ── unit: shouldCache ──────────────────────────────────────────────────────────

test("shouldCache: rev-hashed / asset URLs are cacheable", () => {
	for (const url of ["/assets/index-abc123.js", "/plugins/foo.js?rev=1", "/favicon.svg", "/manifest.webmanifest", "/assets/index.css"]) {
		assert.equal(shouldCache({ url }), true, `expected cacheable: ${url}`);
	}
});

test("shouldCache: dynamic paths are not long-cached", () => {
	for (const url of ["/api/session.history", "/", "/some/spa/route", "/auth/me"]) {
		assert.equal(shouldCache({ url }), false, `expected not cacheable: ${url}`);
	}
});

// ── unit: shouldGzip ───────────────────────────────────────────────────────────

const reqFor = (accept = "gzip", url = "/", host) => {
	const req = { headers: { "accept-encoding": accept }, url };
	req[ORIGINAL_HOST] = host ?? "dsh.facaix.fun"; // remote by default
	return req;
};

test("shouldGzip: gzips compressible text for remote clients", () => {
	const req = reqFor("gzip, deflate", "/", "dsh.facaix.fun");
	assert.equal(shouldGzip(req, 200, { "content-type": "text/html; charset=utf-8", "content-length": "5000" }, true, 1024), true);
	assert.equal(shouldGzip(req, 200, { "content-type": "application/json", "content-length": "5000" }, true, 1024), true);
	assert.equal(shouldGzip(req, 200, { "content-type": "image/svg+xml", "content-length": "5000" }, true, 1024), true);
});

test("shouldGzip: skips when client does not accept gzip", () => {
	const req = reqFor("br", "/", "dsh.facaix.fun");
	assert.equal(shouldGzip(req, 200, { "content-type": "text/html", "content-length": "5000" }, true, 1024), false);
});

test("shouldGzip: local (loopback) original host is not compressed by default", () => {
	const req = reqFor("gzip", "/", "127.0.0.1:3080");
	assert.equal(shouldGzip(req, 200, { "content-type": "text/html", "content-length": "5000" }, true, 1024), false);
});

test("shouldGzip: remoteOnly=false compresses local too", () => {
	const req = reqFor("gzip", "/", "127.0.0.1:3080");
	assert.equal(shouldGzip(req, 200, { "content-type": "text/html", "content-length": "5000" }, false, 1024), true);
});

test("shouldGzip: never compresses SSE or already-compressed", () => {
	const req = reqFor("gzip", "/", "dsh.facaix.fun");
	assert.equal(shouldGzip(req, 200, { "content-type": "text/event-stream" }, true, 1024), false, "SSE");
	assert.equal(shouldGzip(req, 200, { "content-type": "text/html", "content-encoding": "br" }, true, 1024), false, "already compressed");
});

test("shouldGzip: skips binary content types", () => {
	const req = reqFor("gzip", "/", "dsh.facaix.fun");
	for (const ct of ["image/png", "font/woff2", "application/octet-stream", "video/mp4"]) {
		assert.equal(shouldGzip(req, 200, { "content-type": ct, "content-length": "5000" }, true, 1024), false, ct);
	}
});

test("shouldGzip: respects minBytes threshold when content-length is known", () => {
	const req = reqFor("gzip", "/", "dsh.facaix.fun");
	assert.equal(shouldGzip(req, 200, { "content-type": "text/html", "content-length": "100" }, true, 1024), false, "below min");
	assert.equal(shouldGzip(req, 200, { "content-type": "text/html", "content-length": "5000" }, true, 1024), true, "above min");
});

test("shouldGzip: skips status codes that carry no body", () => {
	const req = reqFor("gzip", "/", "dsh.facaix.fun");
	for (const status of [204, 206, 304]) {
		assert.equal(shouldGzip(req, status, { "content-type": "text/html", "content-length": "5000" }, true, 1024), false, `status ${status}`);
	}
});

test("shouldGzip: falls back to URL extension when content-type missing", () => {
	const req = reqFor("gzip", "/assets/app.js", "dsh.facaix.fun");
	assert.equal(shouldGzip(req, 200, { "content-length": "5000" }, true, 1024), true, "js");
	const reqCss = reqFor("gzip", "/assets/app.css", "dsh.facaix.fun");
	assert.equal(shouldGzip(reqCss, 200, { "content-length": "5000" }, true, 1024), true, "css");
});

// ── integration: makeGzipRes over a real node:http server ─────────────────────

/** Build a tiny server that serves through makeGzipRes like the plugin gate would. */
function serve(makeResponse) {
	const server = createServer(async (req, res) => {
		// Simulate the gate: stash original host + wrap res.
		req[ORIGINAL_HOST] = String(req.headers.host);
		const wrapped = makeGzipRes(res, req, { enabled: true, remoteOnly: true, minBytes: 1024 });
		await makeResponse(req, wrapped);
	});
	return server;
}

/**
 * Raw node http request so we control the `Host` header (undici/fetch would
 * override it from the socket address, defeating the remote-origin test).
 * Collects the raw compressed bytes so we can gunzip them.
 */
async function sendRaw(server, { path = "/", hostHeader = "dsh.facaix.fun", acceptEncoding = "gzip" } = {}) {
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;
	return new Promise((resolve, reject) => {
		const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers: { host: hostHeader, "accept-encoding": acceptEncoding } }, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
			res.on("error", reject);
		});
		req.on("error", reject);
		// Hard cap so a regression (e.g. gzip drain deadlock) fails fast instead of hanging.
		req.setTimeout(8000, () => { reject(new Error("sendRaw timed out (possible gzip drain deadlock)")); req.destroy(); });
		req.end();
	});
}

test("makeGzipRes: gzips a large HTML response for a remote client", async () => {
	const server = serve((req, res) => {
		const body = "<html>".repeat(2000); // 12000 bytes, well above minBytes
		res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": String(body.length) });
		res.end(body);
	});
	server.listen(0);
	try {
		const r = await sendRaw(server, { hostHeader: "dsh.facaix.fun" });
		assert.equal(r.status, 200);
		assert.equal(r.headers["content-encoding"], "gzip");
		assert.equal(gunzipSync(r.body).toString("utf8"), "<html>".repeat(2000));
	} finally {
		await new Promise((rr) => server.close(rr));
	}
});

test("makeGzipRes: gzips a large JSON via sequential writes WITH bridge-style drain (regression)", async () => {
	// Reproduces the real http-bridge backpressure: it does
	//   if (!res.write(chunk)) await waitForDrain()
	// The gzip wrapper must return a truthy "accepted" so the bridge never waits
	// on a 'drain' that cannot arrive (the real res is fed by the gzip pipe, not
	// by direct res.write). Regression: a falsy return deadlocked the response.
	const server = serve(async (req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		const body = JSON.stringify({ big: "y".repeat(400000) }); // ~400KB → gzip branch
		const chunkSize = 16384;
		for (let i = 0; i < body.length; i += chunkSize) {
			const chunk = Buffer.from(body.slice(i, i + chunkSize));
			if (!res.write(chunk, "utf8")) {
				await new Promise((resolve) => {
					res.once("drain", resolve);
					res.once("close", resolve);
				});
			}
		}
		res.end();
	});
	server.listen(0);
	try {
		const r = await sendRaw(server, { hostHeader: "dsh.facaix.fun", path: "/api/session.history" });
		assert.equal(r.headers["content-encoding"], "gzip");
		const plain = gunzipSync(r.body).toString("utf8");
		assert.match(plain, /"big"/);
		assert.ok(r.body.length < 5000, "gzip should compress 400KB well below 5KB, got " + r.body.length);
	} finally {
		await new Promise((rr) => server.close(rr));
	}
});

test("makeGzipRes: adds cache headers to rev-hashed assets", async () => {
	const server = serve((req, res) => {
		const body = "const x = 1; " + "y".repeat(4000);
		res.writeHead(200, { "content-type": "application/javascript", "content-length": String(body.length) });
		res.end(body);
	});
	server.listen(0);
	try {
		const r = await sendRaw(server, { hostHeader: "dsh.facaix.fun", path: "/assets/app-abc123.js" });
		assert.equal(r.headers["content-encoding"], "gzip");
		assert.match(String(r.headers["cache-control"] || ""), /immutable/);
		assert.match(String(r.headers["cdn-cache-control"] || ""), /public/);
		assert.ok(gunzipSync(r.body).toString("utf8").startsWith("const x = 1;"));
	} finally {
		await new Promise((rr) => server.close(rr));
	}
});

test("makeGzipRes: does not gzip binary content and strips no content-length", async () => {
	const server = serve((req, res) => {
		const body = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
		res.writeHead(200, { "content-type": "image/png", "content-length": String(body.length) });
		res.end(body);
	});
	server.listen(0);
	try {
		const r = await sendRaw(server, { hostHeader: "dsh.facaix.fun" });
		assert.equal(r.headers["content-encoding"], undefined, "binary must not be gzipped");
		assert.deepEqual([...r.body], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
	} finally {
		await new Promise((rr) => server.close(rr));
	}
});

test("makeGzipRes: local (loopback) client is not compressed", async () => {
	const server = serve((req, res) => {
		const body = "<html>".repeat(2000);
		res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": String(body.length) });
		res.end(body);
	});
	server.listen(0);
	try {
		const r = await sendRaw(server, { hostHeader: "127.0.0.1:3080" });
		assert.equal(r.headers["content-encoding"], undefined, "loopback should skip gzip");
	} finally {
		await new Promise((rr) => server.close(rr));
	}
});

test("makeGzipRes: streams an SSE-like response uncompressed and intact", async () => {
	const server = serve((req, res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write(": connected\n\n");
		res.write("data: hello\n\n");
		res.end();
	});
	server.listen(0);
	try {
		const r = await sendRaw(server, { hostHeader: "dsh.facaix.fun" });
		assert.equal(r.headers["content-encoding"], undefined, "SSE must not be gzipped");
		assert.match(r.body.toString("utf8"), /data: hello/);
	} finally {
		await new Promise((rr) => server.close(rr));
	}
});
