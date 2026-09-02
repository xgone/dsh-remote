/**
 * Unit tests for the viewer panel's file-kind classifier
 * (lib/client.js `kindOf`) — the extension table that picks each file's
 * presentation: rendered markdown, highlighted code (the shell's CodeBlock,
 * grammar hints mirroring the read card's LANG_BY_EXTENSION), plain text,
 * inline media, server-extracted Word text, or the download-only card.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Evaluate the self-contained browser bundle (same harness as the
 *  wire-shape tests). */
function loadClientBundle() {
	const here = dirname(fileURLToPath(import.meta.url));
	const source = readFileSync(join(here, "..", "lib", "client.js"), "utf8");
	const loaded = [];
	const stubRequire = (name) => {
		if (name === "react/jsx-runtime") return { jsx: () => null };
		if (name === "react-dom/client") return { createRoot: () => ({ render: () => {}, unmount: () => {} }) };
		if (name === "@deepseek-ai/dsh-client-ui-primitives") throw new Error("primitives are optional");
		return {};
	};
	const pageWindow = { __ModuleLoader__: { load: (definition) => loaded.push(definition) } };
	new Function("window", source)(pageWindow);
	return loaded[0].factory(stubRequire);
}

const { kindOf } = loadClientBundle();

test("kindOf: markdown family renders as markdown", () => {
	assert.equal(kindOf("report.md").kind, "markdown");
	assert.equal(kindOf("README.markdown").kind, "markdown");
	assert.equal(kindOf("notes.mdx").kind, "markdown");
	assert.equal(kindOf("C:\\dir\\报告.MD").kind, "markdown"); // case + windows path
});

test("kindOf: code family carries the read card's grammar hints", () => {
	assert.deepEqual(kindOf("app.ts"), { kind: "code", lang: "ts" });
	assert.deepEqual(kindOf("component.tsx"), { kind: "code", lang: "tsx" });
	assert.deepEqual(kindOf("server.py"), { kind: "code", lang: "py" });
	assert.deepEqual(kindOf("lib.rs"), { kind: "code", lang: "rs" });
	assert.deepEqual(kindOf("Main.java"), { kind: "code", lang: "java" });
	assert.deepEqual(kindOf("kernel.c"), { kind: "code", lang: "c" });
	assert.deepEqual(kindOf("widget.hpp"), { kind: "code", lang: "cpp" });
	assert.deepEqual(kindOf("deploy.sh"), { kind: "code", lang: "sh" });
	assert.deepEqual(kindOf("config.yml"), { kind: "code", lang: "yaml" });
	assert.deepEqual(kindOf("page.html"), { kind: "code", lang: "html" });
	assert.deepEqual(kindOf("theme.scss"), { kind: "code", lang: "scss" });
});

test("kindOf: json files are code views with the json grammar", () => {
	assert.deepEqual(kindOf("package.json"), { kind: "json", lang: null });
	assert.deepEqual(kindOf("tsconfig.jsonc"), { kind: "json", lang: "json" });
});

test("kindOf: plain readable text", () => {
	for (const name of ["notes.txt", "build.log", "table.csv", "data.tsv", ".gitignore", ".env.local", "app.properties"]) {
		assert.equal(kindOf(name).kind, "text", name);
	}
});

test("kindOf: media and pdf are inline kinds", () => {
	assert.equal(kindOf("shot.png").kind, "image");
	assert.equal(kindOf("photo.jpeg").kind, "image");
	assert.equal(kindOf("chart.svg").kind, "image");
	assert.equal(kindOf("doc.pdf").kind, "pdf");
	assert.equal(kindOf("clip.mp4").kind, "video");
	assert.equal(kindOf("song.mp3").kind, "audio");
});

test("kindOf: docx is the extractable kind; legacy office stays download-only", () => {
	assert.equal(kindOf("报告.docx").kind, "docx");
	assert.equal(kindOf("old.doc").kind, "binary");
	assert.equal(kindOf("sheet.xlsx").kind, "binary");
	assert.equal(kindOf("deck.pptx").kind, "binary");
	assert.equal(kindOf("bundle.zip").kind, "binary");
});

test("kindOf: extensionless build files render as code", () => {
	assert.deepEqual(kindOf("Dockerfile"), { kind: "code", lang: "dockerfile" });
	assert.deepEqual(kindOf("Makefile"), { kind: "code", lang: "makefile" });
	assert.deepEqual(kindOf("justfile").kind, "code");
});

test("kindOf: unknown extensions fall back to the served content-type, else binary", () => {
	assert.deepEqual(kindOf("mystery.foo", "text/plain"), { kind: "text", lang: null });
	assert.deepEqual(kindOf("mystery.foo", "application/octet-stream"), { kind: "binary", lang: null });
	assert.deepEqual(kindOf("mystery.foo", undefined), { kind: "binary", lang: null });
	assert.deepEqual(kindOf("blob", "image/png"), { kind: "image", lang: null });
	assert.deepEqual(kindOf("stream", "video/webm"), { kind: "video", lang: null });
	assert.deepEqual(kindOf("paper", "application/pdf"), { kind: "pdf", lang: null });
});
