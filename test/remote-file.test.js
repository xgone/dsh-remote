import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFilePathAgainst } from "../lib/index.js";

const root = mkdtempSync(join(tmpdir(), "dsh-remote-file-"));
const outside = mkdtempSync(join(tmpdir(), "dsh-remote-outside-"));

test.after(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
});

test("checkFilePathAgainst: accepts files under an extra root", () => {
	writeFileSync(join(root, "report.md"), "# hello");
	const verdict = checkFilePathAgainst(join(root, "report.md"), [root]);
	assert.equal(verdict.ok, true);
	assert.equal(verdict.isDirectory, false);
	assert.equal(verdict.size, "# hello".length);
});

test("checkFilePathAgainst: accepts directories (listing case)", () => {
	mkdirSync(join(root, "sub"));
	const verdict = checkFilePathAgainst(join(root, "sub"), [root]);
	assert.equal(verdict.ok, true);
	assert.equal(verdict.isDirectory, true);
});

test("checkFilePathAgainst: rejects paths outside every root", () => {
	writeFileSync(join(outside, "secret.txt"), "x");
	const verdict = checkFilePathAgainst(join(outside, "secret.txt"), [root]);
	assert.equal(verdict.ok, false);
	assert.equal(verdict.reason, "outside-roots");
});

test("checkFilePathAgainst: rejects traversal escaping the root", () => {
	const verdict = checkFilePathAgainst(join(root, "..", "..", "etc", "passwd"), [root]);
	assert.ok(!verdict.ok);
	assert.ok(verdict.reason === "outside-roots" || verdict.reason === "not-found");
});

test("checkFilePathAgainst: rejects missing / empty / non-file paths", () => {
	assert.equal(checkFilePathAgainst("", [root]).reason, "no-path");
	assert.equal(checkFilePathAgainst(null).reason, "no-path");
	assert.equal(checkFilePathAgainst(join(root, "nope.txt"), [root]).reason, "not-found");
});

test("checkFilePathAgainst: case-insensitive comparison (Windows-style) matches differently-cased roots", () => {
	// On a case-insensitive filesystem (win32) realpath returns one canonical
	// spelling while the configured root may use another; the comparison must
	// fold case. The flag lets this run on case-sensitive hosts too.
	const upperRoot = root.replace(root.split("/").pop(), root.split("/").pop().toUpperCase());
	writeFileSync(join(root, "CaseProbe.txt"), "x");
	const verdict = checkFilePathAgainst(join(root, "CaseProbe.txt"), [upperRoot], { caseInsensitive: true });
	assert.equal(verdict.ok, true, "differently-cased root must match");
	// Without the flag the same pair is rejected (case-sensitive comparison).
	const strict = checkFilePathAgainst(join(root, "CaseProbe.txt"), [upperRoot], { caseInsensitive: false });
	assert.equal(strict.ok, false);
});
