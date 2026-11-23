/**
 * dsh-remote — administrator-managed paths that bypass the browser-session gate.
 *
 * The allowlist is for plugin routes that perform their own authentication,
 * such as a key-authenticated MCP bridge. Entries are literal URL path prefixes
 * with segment-boundary matching. The file is stored under DSH_HOME and written
 * atomically with 0600 permissions.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";

export const MAX_ANONYMOUS_PATHS = 100;
const PATH_CHARS = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@\/]+$/;

/** Default store location under the harness home. */
export function anonymousPathsPath() {
	return join(dshHomePath(), "dsh-remote-anonymous-paths.json");
}

/**
 * Validate and canonicalize one path prefix.
 * Percent-encoded, query, fragment, whitespace and backslash forms are rejected
 * so the gate can compare the raw request pathname without decode ambiguity.
 */
export function normalizeAnonymousPath(value) {
	const path = typeof value === "string" ? value.trim() : "";
	if (path.length === 0) return { ok: false, error: "path is required" };
	if (path.length > 512) return { ok: false, error: "path must be 512 characters or fewer" };
	if (!path.startsWith("/") || path.startsWith("//") || !PATH_CHARS.test(path)) {
		return { ok: false, error: "path must be an absolute URL path without query, fragment, encoding, or backslash" };
	}
	if (path.includes("//")) return { ok: false, error: "path must not contain empty segments" };
	const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
	if (trimmed === "/") return { ok: false, error: "the root path cannot be made anonymous" };
	const segments = trimmed.slice(1).split("/");
	if (segments.some((part) => part === "." || part === "..")) {
		return { ok: false, error: "path must not contain dot segments" };
	}
	if (trimmed === "/api" || trimmed.startsWith("/api/") || trimmed === "/auth" || trimmed.startsWith("/auth/")) {
		return { ok: false, error: "the /api and /auth paths cannot be made anonymous" };
	}
	return { ok: true, path: trimmed };
}

/** Match an un-decoded request pathname at a whole path-segment boundary. */
export function matchesAnonymousPath(requestPath, allowedPaths) {
	if (typeof requestPath !== "string" || !Array.isArray(allowedPaths)) return false;
	// Do not let encoded separators/dot-segments or literal traversal cross the
	// prefix boundary after the webserver parses or canonicalizes the URL.
	if (requestPath.includes("%") || requestPath.includes("\\")) return false;
	if (requestPath.split("/").some((part) => part === "." || part === "..")) return false;
	return allowedPaths.some((prefix) => requestPath === prefix || requestPath.startsWith(`${prefix}/`));
}

/**
 * The anonymous-path store. Bad or corrupt files fail closed to an empty list.
 * A change takes effect immediately; callers read list() on each request.
 */
export class AnonymousPathsStore {
	constructor(path = anonymousPathsPath()) {
		this.path = path;
		this.paths = [];
	}

	load() {
		let raw = null;
		try {
			raw = readFileSync(this.path, "utf8");
		} catch (error) {
			if (error?.code !== "ENOENT") this.paths = [];
		}
		if (raw === null) {
			this.paths = [];
			return;
		}
		try {
			const parsed = JSON.parse(raw);
			this.set(parsed?.paths);
		} catch {
			this.paths = [];
		}
	}

	save() {
		mkdirSync(dirname(this.path), { recursive: true });
		const tmp = `${this.path}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify({ version: 1, paths: this.paths }, null, 2)}\n`, { mode: 0o600 });
		renameSync(tmp, this.path);
		try {
			chmodSync(this.path, 0o600);
		} catch {
			// best effort
		}
	}

	list() {
		return [...this.paths];
	}

	add(value) {
		const normalized = normalizeAnonymousPath(value);
		if (!normalized.ok) return normalized;
		if (this.paths.includes(normalized.path)) return { ok: true, changed: false, path: normalized.path };
		if (this.paths.length >= MAX_ANONYMOUS_PATHS) {
			return { ok: false, error: `at most ${MAX_ANONYMOUS_PATHS} paths can be allowed` };
		}
		this.paths.push(normalized.path);
		return { ok: true, changed: true, path: normalized.path };
	}

	remove(value) {
		const normalized = normalizeAnonymousPath(value);
		const path = normalized.ok ? normalized.path : value;
		const index = this.paths.indexOf(path);
		if (index === -1) return false;
		this.paths.splice(index, 1);
		return true;
	}

	set(paths) {
		const result = [];
		if (Array.isArray(paths)) {
			for (const value of paths) {
				const normalized = normalizeAnonymousPath(value);
				if (!normalized.ok || result.includes(normalized.path)) continue;
				result.push(normalized.path);
				if (result.length >= MAX_ANONYMOUS_PATHS) break;
			}
		}
		this.paths = result;
	}
}
