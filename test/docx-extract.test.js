/**
 * Unit tests for the .docx plain-text extraction behind the viewer panel's
 * Word strategy (lib/index.js `extractDocxText` + `zipEntries`).
 *
 * A .docx is a ZIP of XML — the extractor parses the central directory,
 * inflates word/document.xml with Node's own zlib, turns paragraph ends into
 * newlines and strips the remaining tags. The ZIP fixtures below are built
 * byte-by-byte (no dependency): stored (method 0) and deflated (method 8)
 * entries, exactly the two methods the reader supports.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { extractDocxText, zipEntries } from "../lib/index.js";

const LFH_SIG = 0x04034b50;
const CD_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

/** Build a minimal ZIP buffer from { name, data, deflate? } entries. */
function buildZip(entries) {
	const locals = [];
	const centrals = [];
	let offset = 0;
	for (const entry of entries) {
		const nameBuf = Buffer.from(entry.name, "utf8");
		const method = entry.deflate === true ? 8 : 0;
		const payload = method === 8 ? deflateRawSync(entry.data) : entry.data;
		const lfh = Buffer.alloc(30);
		lfh.writeUInt32LE(LFH_SIG, 0);
		lfh.writeUInt16LE(20, 4);
		lfh.writeUInt16LE(0, 6);
		lfh.writeUInt16LE(method, 8);
		lfh.writeUInt32LE(payload.length, 18);
		lfh.writeUInt32LE(entry.data.length, 22);
		lfh.writeUInt16LE(nameBuf.length, 26);
		locals.push(lfh, nameBuf, payload);
		const cd = Buffer.alloc(46);
		cd.writeUInt32LE(CD_SIG, 0);
		cd.writeUInt16LE(method, 10);
		cd.writeUInt32LE(payload.length, 20);
		cd.writeUInt32LE(entry.data.length, 24);
		cd.writeUInt16LE(nameBuf.length, 28);
		cd.writeUInt32LE(offset, 42);
		centrals.push(cd, nameBuf);
		offset += 30 + nameBuf.length + payload.length;
	}
	const centralBuf = Buffer.concat(centrals);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(EOCD_SIG, 0);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(centralBuf.length, 12);
	eocd.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, centralBuf, eocd]);
}

const DOCUMENT = "<w:document><w:body>"
	+ "<w:p><w:r><w:t>Hello &amp; &lt;world&gt;</w:t></w:r></w:p>"
	+ "<w:p><w:r><w:t>A<w:br/>B<w:tab/>C</w:t></w:r></w:p>"
	+ "</w:body></w:document>";

test("extractDocxText: paragraphs become newlines, entities decode, br/tab honored", () => {
	const zip = buildZip([
		{ name: "[Content_Types].xml", data: Buffer.from("<Types/>") },
		{ name: "word/document.xml", data: Buffer.from(DOCUMENT), deflate: true }
	]);
	assert.equal(extractDocxText(zip), "Hello & <world>\nA\nB\tC\n");
});

test("extractDocxText: stored (method 0) entries work too", () => {
	const zip = buildZip([{ name: "word/document.xml", data: Buffer.from("<w:p><w:r><w:t>plain</w:t></w:r></w:p>") }]);
	assert.equal(extractDocxText(zip), "plain\n");
});

test("extractDocxText: unrelated zip / missing main part / garbage all yield null", () => {
	assert.equal(extractDocxText(buildZip([{ name: "other/file.xml", data: Buffer.from("<x/>") }])), null);
	assert.equal(extractDocxText(Buffer.from("not a zip at all")), null);
	assert.equal(extractDocxText(Buffer.alloc(0)), null);
	// truncated central directory
	const zip = buildZip([{ name: "word/document.xml", data: Buffer.from(DOCUMENT) }]);
	assert.equal(extractDocxText(zip.slice(0, zip.length - 10)), null);
});

test("extractDocxText: non-buffer / oversize guards", () => {
	assert.equal(extractDocxText(undefined), null);
	assert.equal(extractDocxText("string"), null);
	const huge = Buffer.alloc(65 * 1024 * 1024 + 1);
	assert.equal(extractDocxText(huge), null);
});

test("zipEntries: maps every entry to its payload start", () => {
	const zip = buildZip([
		{ name: "a.txt", data: Buffer.from("AAA") },
		{ name: "b/c.bin", data: Buffer.from("BBBBBB"), deflate: true }
	]);
	const entries = zipEntries(zip);
	assert.ok(entries instanceof Map);
	assert.equal(entries.size, 2);
	assert.equal(entries.get("a.txt").method, 0);
	assert.equal(zip.slice(entries.get("a.txt").dataStart, entries.get("a.txt").dataStart + 3).toString(), "AAA");
	assert.equal(entries.get("b/c.bin").method, 8);
	const { dataStart, compSize } = entries.get("b/c.bin");
	const roundTrip = deflateRawSync(Buffer.from("BBBBBB"));
	assert.equal(zip.slice(dataStart, dataStart + compSize).equals(roundTrip), true);
});
