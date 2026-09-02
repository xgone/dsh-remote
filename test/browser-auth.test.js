/**
 * Unit tests for the dsh browser-session cookie minting helpers (issue #10).
 *
 * The "interop" vectors below are REAL values captured from a live
 * dsh 0.1.2-alpha.3 instance: the signing secret as stored in
 * $DSH_HOME/.credentials.yaml under `client-connection/browser-session`, and a
 * cookie minted by that instance's own `?token=` exchange. Passing these
 * proves byte-level compatibility with the core's browser-auth implementation
 * (packages/client/connection/src/browser-auth.ts), not just self-consistency.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
	BROWSER_SESSION_RECORD_KEY,
	canonicalAuthority,
	dshAuthCookieName,
	encodeDshAuthCookie,
	decodeDshAuthCookie,
	cookieValueOf,
	readBrowserAuthSecret,
	hasLiveDshAuthCookie
} from "../lib/index.js";

// Live-captured interop vector (see file header).
const SECRET_B64 = "VXR-ucE76-HH617FbGd5-GNygvIqvPFvAjK9YfVvopM";
const CORE_AUTHORITY = "127.0.0.1:4123";
const CORE_COOKIE_NAME = "dsh-auth-YVtZjAk-O-As0CPrK4Smou5Cy2QJPP7nYVHErLbFhXo";
const CORE_COOKIE_VALUE = "v1.eyJ2ZXJzaW9uIjoxLCJhdXRob3JpdHkiOiIxMjcuMC4wLjE6NDEyMyIsImlzc3VlZEF0IjoxNzg4MzEwOTgzMDg5LCJleHBpcmVzQXQiOjE3OTA5MDI5ODMwODl9.6JAxy85Pvvsx1QCyrpuWqbnk-hFyBO5a1H8A-9SDSfE";
const CORE_ISSUED_AT = 1788310983089;

test("canonicalAuthority mirrors the core's WHATWG normalization", () => {
	assert.equal(canonicalAuthority("127.0.0.1:4123"), "127.0.0.1:4123");
	assert.equal(canonicalAuthority("remote.example.com"), "remote.example.com");
	assert.equal(canonicalAuthority("Example.COM"), "example.com");
	assert.equal(canonicalAuthority("example.com:443"), "example.com:443"); // 443 is not http's default port
	assert.equal(canonicalAuthority("example.com:80"), "example.com"); // 80 is stripped as http default
	assert.equal(canonicalAuthority("[::1]:8080"), "[::1]:8080");
	assert.equal(canonicalAuthority(""), null);
	assert.equal(canonicalAuthority(undefined), null);
	assert.equal(canonicalAuthority("bad host"), null);
});

test("cookie name matches the core-derived name for a live authority", () => {
	assert.equal(dshAuthCookieName(CORE_AUTHORITY), CORE_COOKIE_NAME);
});

test("decode accepts a cookie minted by the real dsh core", () => {
	const secret = Buffer.from(SECRET_B64, "base64url");
	const payload = decodeDshAuthCookie(CORE_COOKIE_VALUE, secret, CORE_AUTHORITY, CORE_ISSUED_AT + 1000);
	assert.notEqual(payload, null);
	assert.equal(payload.version, 1);
	assert.equal(payload.authority, CORE_AUTHORITY);
	assert.equal(payload.issuedAt, CORE_ISSUED_AT);
	assert.equal(payload.expiresAt, 1790902983089);
});

test("encode/decode roundtrip and live-cookie detection", () => {
	const secret = randomBytes(32);
	const ttl = 7 * 24 * 60 * 60 * 1000;
	const now = Date.now();
	const { name, value, cookie } = encodeDshAuthCookie("remote.example.com", secret, ttl, now);
	assert.equal(name, dshAuthCookieName("remote.example.com"));
	assert.ok(cookie.startsWith(`${name}=${value}; Max-Age=604800; Path=/;`));
	assert.ok(cookie.includes("HttpOnly") && cookie.includes("SameSite=Strict"));
	const payload = decodeDshAuthCookie(value, secret, "remote.example.com", now + 2000);
	assert.notEqual(payload, null);
	assert.equal(payload.issuedAt, now);
	assert.equal(payload.expiresAt, now + ttl);
	assert.equal(hasLiveDshAuthCookie(`foo=bar; ${name}=${value}; baz=qux`, "remote.example.com", secret), true);
	assert.equal(hasLiveDshAuthCookie(`${name}=${value}`, "other.example.com", secret), false);
	assert.equal(hasLiveDshAuthCookie("unrelated=1", "remote.example.com", secret), false);
	assert.equal(hasLiveDshAuthCookie(undefined, "remote.example.com", secret), false);
	assert.equal(hasLiveDshAuthCookie(`${name}=${value}`, "remote.example.com", null), false);
});

test("decode rejects tampered, foreign, expired and overlong cookies", () => {
	const secret = randomBytes(32);
	const { value } = encodeDshAuthCookie("a.example", secret, 1000, 0);
	// tampered payload
	const parts = value.split(".");
	const tamperedBody = Buffer.from(JSON.stringify({ version: 1, authority: "a.example", issuedAt: 0, expiresAt: 900 }), "utf8").toString("base64url");
	assert.equal(decodeDshAuthCookie(`v1.${tamperedBody}.${parts[2]}`, secret, "a.example", 10), null);
	// wrong key
	assert.equal(decodeDshAuthCookie(value, randomBytes(32), "a.example", 10), null);
	// wrong authority
	assert.equal(decodeDshAuthCookie(value, secret, "b.example", 10), null);
	// expired
	assert.equal(decodeDshAuthCookie(value, secret, "a.example", 1001), null);
	// overlong window (beyond the core's default cookieMaxAgeDays bound)
	const { value: overlong } = encodeDshAuthCookie("a.example", secret, 31 * 24 * 60 * 60 * 1000, 0);
	assert.equal(decodeDshAuthCookie(overlong, secret, "a.example", 10), null);
	// malformed shapes
	assert.equal(decodeDshAuthCookie("garbage", secret, "a.example", 10), null);
	assert.equal(decodeDshAuthCookie("v2.a.b", secret, "a.example", 10), null);
	assert.equal(decodeDshAuthCookie("v1.a", secret, "a.example", 10), null);
});

test("readBrowserAuthSecret validates the credential record shape", () => {
	const secret = readBrowserAuthSecret({
		kind: "grant",
		payload: { version: 1, secret: SECRET_B64 }
	});
	assert.notEqual(secret, null);
	assert.equal(secret.byteLength, 32);
	assert.equal(secret.toString("base64url"), SECRET_B64);
	assert.equal(readBrowserAuthSecret(undefined), null);
	assert.equal(readBrowserAuthSecret(null), null);
	assert.equal(readBrowserAuthSecret({ kind: "api-key", payload: { version: 1, secret: SECRET_B64 } }), null);
	assert.equal(readBrowserAuthSecret({ kind: "grant", payload: { version: 2, secret: SECRET_B64 } }), null);
	assert.equal(readBrowserAuthSecret({ kind: "grant", payload: { version: 1, secret: "short" } }), null);
	assert.equal(readBrowserAuthSecret({ kind: "grant", payload: { version: 1 } }), null);
});

test("cookieValueOf reads exact names out of a raw Cookie header", () => {
	assert.equal(cookieValueOf("a=1; dsh_session=v1.x.y; b=2", "dsh_session"), "v1.x.y");
	assert.equal(cookieValueOf("dsh_session=v1.x.y", "dsh_session"), "v1.x.y");
	assert.equal(cookieValueOf("x_dsh_session=v1.x.y", "dsh_session"), null);
	assert.equal(cookieValueOf("", "dsh_session"), null);
	assert.equal(cookieValueOf(undefined, "dsh_session"), null);
});

test("the credential record key targets client-connection's browser session", () => {
	assert.equal(BROWSER_SESSION_RECORD_KEY, "client-connection/browser-session");
});
