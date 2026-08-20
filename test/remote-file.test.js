import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } from "node:fs";
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
	// Simulate the win32 realpath-casing bug on any host: create a probe
	// directory and address its root with a differently-cased spelling.
	//  - case-sensitive host (CI Linux): the upper-cased spelling is a real,
	//    distinct directory — realpath resolves it, and the comparison decides.
	//  - case-insensitive host (macOS/Windows): mkdir with the upper-cased
	//    spelling collides, and realpath returns the canonical spelling no
	//    matter which case addressed it — exactly the win32 behavior.
	const lower = join(root, "caseprobe");
	const upper = join(root, "CASEPROBE");
	mkdirSync(lower);
	try {
		mkdirSync(upper);
	} catch {
		// case-insensitive filesystem: same directory, skip
	}
	const extraRoot = realpathSync(upper); // canonical spelling of the root
	writeFileSync(join(lower, "CaseProbe.txt"), "x");
	const verdict = checkFilePathAgainst(join(lower, "CaseProbe.txt"), [extraRoot], { caseInsensitive: true });
	assert.equal(verdict.ok, true, "differently-cased root must match");
	// Strict (case-sensitive) comparison must reject the pair — but only on
	// hosts where the two spellings are genuinely distinct paths; on a
	// case-insensitive host realpath collapses them and strict passes, which
	// is exactly why the win32 fix folds case there.
	const strict = checkFilePathAgainst(join(lower, "CaseProbe.txt"), [extraRoot], { caseInsensitive: false });
	if (realpathSync(upper) !== realpathSync(lower)) {
		assert.equal(strict.ok, false);
	}
});
