/**
 * Unit tests for the remote file panel's wire-shape matcher
 * (lib/client.js `extractNativeOpenPath`).
 *
 * dsh renamed the native-open RPC between generations:
 *   rc    — POST /api/host.openPath             payload { path }
 *   alpha — POST /api/session/openWorkspacePath payload { args: { request: { path } } }
 * The matcher must accept both spellings so one bundle serves both dsh
 * generations (issue #11: after the dsh upgrade the sidebar never opened
 * because the patch only matched the rc spelling — and alpha additionally
 * hides the open affordances unless ctx.remote.$host.isLoopback is true,
 * which the plugin now flips for remote pages in apply()).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Evaluate the self-contained browser bundle and return its module exports
 *  plus the page `window` object the bundle closed over (the whole source is
 *  one `new Function("window", …)` body, so `window` is that lexical). */
function loadClientBundle() {
	const here = dirname(fileURLToPath(import.meta.url));
	const source = readFileSync(join(here, "..", "lib", "client.js"), "utf8");
	const loaded = [];
	const stubRequire = (name) => {
		if (name === "react/jsx-runtime") return { jsx: () => null };
		if (name === "react-dom/client") return { createRoot: () => ({ render: () => {}, unmount: () => {} }) };
		if (name === "@deepseek-ai/dsh-client-ui-primitives") throw new Error("primitives are optional");
		return {}; // react and every other shell module
	};
	const pageWindow = { __ModuleLoader__: { load: (definition) => loaded.push(definition) } };
	new Function("window", source)(pageWindow);
	assert.equal(loaded.length, 1, "the bundle must register exactly one module");
	return { exports: loaded[0].factory(stubRequire), pageWindow };
}

const { exports: bundle, pageWindow } = loadClientBundle();
const extract = bundle.extractNativeOpenPath;

// ── rc generation: dotted endpoint, free-form payload ──────────────────────────

test("extractNativeOpenPath: rc dotted host.openPath with payload.path", () => {
	const body = JSON.stringify({
		type: "client-request", rpcId: "rc-1", method: "host.openPath",
		payload: { path: "/home/you/report.md" }
	});
	assert.deepEqual(extract("/api/host.openPath", body), { path: "/home/you/report.md", rpcId: "rc-1" });
	assert.deepEqual(extract("http://127.0.0.1:3080/api/host.openPath", body), { path: "/home/you/report.md", rpcId: "rc-1" });
});

// ── alpha generation: slash endpoint, args keyed by authored parameter name ────

test("extractNativeOpenPath: alpha session/openWorkspacePath with args.request.path", () => {
	// Captured shape: the gateway wraps method arguments in payload.args,
	// keyed by the authored parameter name (`request` for openWorkspacePath).
	const body = JSON.stringify({
		type: "client-request", rpcId: "al-1", method: "session/openWorkspacePath",
		payload: { args: { request: { path: "/home/you/report.md" } } }
	});
	assert.deepEqual(extract("/api/session/openWorkspacePath", body), { path: "/home/you/report.md", rpcId: "al-1" });
	assert.deepEqual(extract("https://dsh.example.com/api/session/openWorkspacePath", body), { path: "/home/you/report.md", rpcId: "al-1" });
});

test("extractNativeOpenPath: alpha args are matched generically, not by fixed key", () => {
	const body = JSON.stringify({
		type: "client-request", rpcId: "al-2", method: "session/openWorkspacePath",
		payload: { args: { dir: { path: "/home/you" } } }
	});
	assert.deepEqual(extract("/api/session/openWorkspacePath", body), { path: "/home/you", rpcId: "al-2" });
});

test("extractNativeOpenPath: a missing rpcId still matches with a null id", () => {
	const body = JSON.stringify({
		type: "client-request", method: "session/openWorkspacePath",
		payload: { args: { request: { path: "/tmp/a.md" } } }
	});
	assert.deepEqual(extract("/api/session/openWorkspacePath", body), { path: "/tmp/a.md", rpcId: null });
});

// ── pass-through: anything that is not a native-open must fall through ─────────

test("extractNativeOpenPath: unrelated endpoints return null", () => {
	const body = JSON.stringify({
		type: "client-request", rpcId: "x", method: "settings.describe",
		payload: { args: { request: { path: "/etc/passwd" } } }
	});
	assert.equal(extract("/api/settings.describe", body), null);
	assert.equal(extract("/api/settings/describe", body), null);
	assert.equal(extract("/api/session/openWorkspacePathX", null), null);
});

test("extractNativeOpenPath: unreadable or pathless bodies return null", () => {
	const url = "/api/session/openWorkspacePath";
	assert.equal(extract(url, undefined), null);
	assert.equal(extract(url, null), null);
	assert.equal(extract(url, "{not json"), null);
	assert.equal(extract(url, JSON.stringify({ type: "client-request", rpcId: "x", payload: {} })), null);
	assert.equal(extract(url, JSON.stringify({ type: "client-request", rpcId: "x", payload: { args: { request: { path: 42 } } } })), null);
	const rcUrl = "/api/host.openPath";
	assert.equal(extract(rcUrl, JSON.stringify({ type: "client-request", rpcId: "x", payload: { path: { nested: true } } })), null);
});

// ── bundle surface sanity ──────────────────────────────────────────────────────

test("client bundle keeps the client-plugin contract and version marker", () => {
	assert.equal(typeof bundle.apply, "function");
	assert.ok(Array.isArray(bundle.inject), "inject must be exported");
	assert.ok(bundle.inject.includes("connection"), "inject must include connection for the isLoopback flip");
	assert.equal(typeof extract, "function");
	assert.equal(typeof bundle.installRemoteFileOpen, "function");
});

// ── the installed fetch patch answers native-open calls without the network ────

test("installRemoteFileOpen: intercepted native-open returns a compliant server-response", async () => {
	const reached = [];
	const originalFetch = (input) => {
		reached.push(String(input));
		return Promise.resolve(new Response("{}", { status: 200 }));
	};
	pageWindow.fetch = originalFetch;
	bundle.installRemoteFileOpen();
	assert.notEqual(pageWindow.fetch, originalFetch, "install must wrap the current fetch");
	const patchedFetch = pageWindow.fetch;

	const alphaBody = JSON.stringify({
		type: "client-request", rpcId: "e2e-alpha", method: "session/openWorkspacePath",
		payload: { args: { request: { path: "/home/you/a.md" } } }
	});
	const response = await patchedFetch("/api/session/openWorkspacePath", { method: "POST", body: alphaBody });
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		type: "server-response", rpcId: "e2e-alpha",
		result: { ok: true, value: { opened: true } }
	});

	const rcBody = JSON.stringify({
		type: "client-request", rpcId: "e2e-rc", method: "host.openPath",
		payload: { path: "/home/you/b.md" }
	});
	const rcResponse = await patchedFetch("https://host/api/host.openPath", { method: "POST", body: rcBody });
	assert.deepEqual(await rcResponse.json(), {
		type: "server-response", rpcId: "e2e-rc",
		result: { ok: true, value: { opened: true } }
	});

	assert.deepEqual(reached, [], "intercepted calls must never reach the real fetch");

	// Anything else passes through untouched.
	await patchedFetch("/api/settings.describe", { method: "POST", body: "{}" });
	assert.deepEqual(reached, ["/api/settings.describe"]);
});

test("installRemoteFileOpen: un-previewable kinds download directly instead of opening the panel", async () => {
	const clicks = [];
	const anchorStub = {
		href: "",
		download: "",
		click: () => clicks.push(anchorStub.href),
		remove: () => {}
	};
	// The bundle's downloadFile reaches `document` as the page global.
	const previousDocument = globalThis.document;
	globalThis.document = {
		createElement: () => anchorStub,
		body: { appendChild: () => {}, removeChild: () => {} }
	};
	try {
		// install() is idempotent — the wrapper from the previous test is
		// still on pageWindow.fetch; drive that one.
		bundle.installRemoteFileOpen();
		const patchedFetch = pageWindow.fetch;

		// A binary kind (.zip) must NOT open a pane — it downloads via the
		// anchor and still answers the RPC with the compliant ok envelope.
		const zipBody = JSON.stringify({
			type: "client-request", rpcId: "dl-1", method: "session/openWorkspacePath",
			payload: { args: { request: { path: "/home/you/archive.zip" } } }
		});
		const zipResponse = await patchedFetch("/api/session/openWorkspacePath", { method: "POST", body: zipBody });
		assert.deepEqual(await zipResponse.json(), {
			type: "server-response", rpcId: "dl-1",
			result: { ok: true, value: { opened: true } }
		});
		assert.deepEqual(clicks, ["/auth/file?path=" + encodeURIComponent("/home/you/archive.zip")], "binary click must trigger the download anchor");

		// A previewable kind keeps the panel path — no download anchor.
		const mdBody = JSON.stringify({
			type: "client-request", rpcId: "dl-2", method: "session/openWorkspacePath",
			payload: { args: { request: { path: "/home/you/notes.md" } } }
		});
		const mdResponse = await patchedFetch("/api/session/openWorkspacePath", { method: "POST", body: mdBody });
		assert.equal((await mdResponse.json()).result.ok, true);
		assert.equal(clicks.length, 1, "previewable click must not download");

		// The docx kind is previewable (extracted text) — also no download.
		const docxBody = JSON.stringify({
			type: "client-request", rpcId: "dl-3", method: "host.openPath",
			payload: { path: "/home/you/报告.docx" }
		});
		const docxResponse = await patchedFetch("https://host/api/host.openPath", { method: "POST", body: docxBody });
		assert.equal((await docxResponse.json()).result.ok, true);
		assert.equal(clicks.length, 1, "docx click must not download");
	} finally {
		if (previousDocument === undefined) delete globalThis.document;
		else globalThis.document = previousDocument;
	}
});
