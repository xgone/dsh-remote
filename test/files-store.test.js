import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesRootsStore } from "../lib/files-store.js";

const dir = () => mkdtempSync(join(tmpdir(), "dsh-remote-files-root-"));

test("FilesRootsStore: starts empty on a fresh path", () => {
	const store = new FilesRootsStore(join(dir(), "files.json"));
	store.load();
	assert.deepEqual(store.list(), []);
});

test("FilesRootsStore: add persists and reloads across instances", () => {
	const path = join(dir(), "files.json");
	const store = new FilesRootsStore(path);
	store.load();
	assert.equal(store.add("/srv/data"), true);
	assert.equal(store.add("  /srv/data  "), false);       // trims to the same root → dup
	assert.equal(store.add(""), false);                    // empty rejected
	assert.equal(store.add("/dup"), true);
	assert.equal(store.add("/dup"), false);                // exact-dup rejected
	store.save();

	const reload = new FilesRootsStore(path);
	reload.load();
	assert.deepEqual(reload.list(), ["/srv/data", "/dup"]);
});

test("FilesRootsStore: remove deletes a stored root and persists", () => {
	const path = join(dir(), "files.json");
	const store = new FilesRootsStore(path);
	store.load();
	store.add("/a");
	store.add("/b");
	store.save();
	assert.equal(store.remove("/b"), true);
	assert.equal(store.remove("/missing"), false);
	store.save();

	const reload = new FilesRootsStore(path);
	reload.load();
	assert.deepEqual(reload.list(), ["/a"]);
});

test("FilesRootsStore: an invalid/corrupt file loads as empty, never throws", () => {
	const path = join(dir(), "files.json");
	writeFileSync(path, "not json {");
	const store = new FilesRootsStore(path);
	store.load();
	assert.deepEqual(store.list(), []);
});

test("FilesRootsStore: written file is valid JSON with a version and roots", () => {
	const path = join(dir(), "files.json");
	const store = new FilesRootsStore(path);
	store.load();
	store.add("/x");
	store.save();
	const parsed = JSON.parse(readFileSync(path, "utf8"));
	assert.equal(parsed.version, 1);
	assert.deepEqual(parsed.roots, ["/x"]);
	rmSync(path, { force: true });
});

test("FilesRootsStore: set replaces the whole list", () => {
	const store = new FilesRootsStore(join(dir(), "files.json"));
	store.load();
	store.add("/a");
	store.set(["/p", "", "/q"]);
	assert.deepEqual(store.list(), ["/p", "/q"]);
});
