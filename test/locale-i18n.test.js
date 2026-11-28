import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	SUPPORTED_LOCALES,
	normalizeLocale,
	localeFromAcceptLanguage,
	pickLoginLang
} from "../lib/index.js";
import { renderLoginPage, LOGIN_LOCALES } from "../lib/login-page.js";

// ── locale ids ────────────────────────────────────────────────────────────────

test("SUPPORTED_LOCALES matches the languages DSH ships", () => {
	assert.deepEqual(SUPPORTED_LOCALES, ["en", "zh", "ja", "es", "fr", "de", "ru", "pt"]);
	assert.deepEqual(LOGIN_LOCALES, SUPPORTED_LOCALES);
});

test("normalizeLocale maps tags to a supported primary subtag", () => {
	assert.equal(normalizeLocale("zh-CN"), "zh");
	assert.equal(normalizeLocale("pt_BR"), "pt");
	assert.equal(normalizeLocale("JA"), "ja");
	assert.equal(normalizeLocale("en-US"), "en");
	assert.equal(normalizeLocale("ko-KR"), null);
	assert.equal(normalizeLocale(""), null);
	assert.equal(normalizeLocale(undefined), null);
	assert.equal(normalizeLocale(null), null);
});

// ── Accept-Language negotiation ───────────────────────────────────────────────

test("localeFromAcceptLanguage picks the highest-quality supported language", () => {
	assert.equal(localeFromAcceptLanguage("ja-JP,en;q=0.8"), "ja");
	assert.equal(localeFromAcceptLanguage("ko-KR, fr-FR;q=0.9"), "fr");
	assert.equal(localeFromAcceptLanguage("de;q=0.2, es;q=0.7"), "es");
	assert.equal(localeFromAcceptLanguage("pt-PT"), "pt");
	assert.equal(localeFromAcceptLanguage("en-US,en;q=0.9"), "en");
});

test("localeFromAcceptLanguage ignores wildcards, empty values and unsupported languages", () => {
	assert.equal(localeFromAcceptLanguage(""), null);
	assert.equal(localeFromAcceptLanguage("*"), null);
	assert.equal(localeFromAcceptLanguage("ko-KR, th-TH"), null);
	assert.equal(localeFromAcceptLanguage(undefined), null);
	assert.equal(localeFromAcceptLanguage("en;q=0, ja;q=0"), null);
});

test("pickLoginLang prefers the stored DSH preference, then the browser", () => {
	assert.equal(pickLoginLang("ja", "zh-CN"), "ja");
	assert.equal(pickLoginLang("pt", "en-US"), "pt");
	// A stale/unknown stored value is ignored in favour of the browser.
	assert.equal(pickLoginLang("ko", "ru-RU"), "ru");
	assert.equal(pickLoginLang(null, "fr-FR,en;q=0.5"), "fr");
	assert.equal(pickLoginLang(null, null), "en");
});

// ── server-rendered login page ────────────────────────────────────────────────

const LOGIN_MARKERS = {
	en: { lang: "en", text: "Sign in to DeepSeek Harness" },
	zh: { lang: "zh-CN", text: "登录 DeepSeek Harness" },
	ja: { lang: "ja", text: "ログイン" },
	es: { lang: "es", text: "Iniciar sesión" },
	fr: { lang: "fr", text: "Connexion" },
	de: { lang: "de", text: "Anmelden" },
	ru: { lang: "ru", text: "Вход" },
	pt: { lang: "pt-BR", text: "Entrar" }
};

test("renderLoginPage renders every supported language and sets <html lang>", () => {
	for (const locale of LOGIN_LOCALES) {
		const html = renderLoginPage({ bootstrap: false, lang: locale });
		const { lang, text } = LOGIN_MARKERS[locale];
		assert.match(html, new RegExp(`<html lang="${lang}">`), `html lang for ${locale}`);
		assert.ok(html.includes(text), `${locale} heading should contain ${JSON.stringify(text)}`);
		// Shared structure stays intact whatever the language.
		assert.match(html, /<form/i);
		assert.match(html, /\/auth\/login/);
	}
});

test("renderLoginPage falls back to English for an unknown language", () => {
	const html = renderLoginPage({ bootstrap: false, lang: "ko-KR" });
	assert.match(html, /<html lang="en">/);
	assert.ok(html.includes("Sign in to DeepSeek Harness"));
});

test("renderLoginPage keeps bootstrap copy localized and pointed at /auth/bootstrap", () => {
	const html = renderLoginPage({ bootstrap: true, lang: "de" });
	assert.ok(html.includes("Administratorkonto"), "German bootstrap headings present");
	assert.match(html, /\/auth\/bootstrap/);
});

// ── browser bundle dictionaries ───────────────────────────────────────────────

const clientSource = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

test("client bundle registers a dictionary for every supported locale", () => {
	const register = clientSource.match(/ctx\.locale\.register\(NS, \{([\s\S]*?)\}\);/);
	assert.ok(register, "locale registration block present");
	for (const locale of ["en", "zh", "ja", "es", "fr", "de", "ru", "pt"]) {
		assert.match(register[1], new RegExp(`\\b${locale}: copy\\.${locale}\\b`), `registers ${locale}`);
	}
});

test("client bundle resolves the standalone language from the primary subtag", () => {
	assert.match(clientSource, /const primary = lang\.replace\(\/_\/g, "-"\)\.split\("-"\)\[0\];/);
	assert.match(clientSource, /const table = copy\[primary\] \?\? copy\.en;/);
});

test("client bundle tables share the English key set and preserve placeholders", () => {
	function tableOf(locale) {
		const lines = clientSource.split("\n");
		const start = lines.findIndex((line) => line.trim() === "const copy = {");
		let collecting = false;
		const table = {};
		for (let index = start + 1; index < lines.length; index += 1) {
			if (/^\t\t\};\s*$/.test(lines[index])) break;
			const head = lines[index].match(/^\t\t\t(\w+): \{\s*$/);
			if (head) {
				collecting = head[1] === locale;
				continue;
			}
			if (!collecting) continue;
			if (/^\t\t\t\},?\s*$/.test(lines[index])) break;
			const entry = lines[index].match(/^\t\t\t\t"((?:[^"\\]|\\.)*)": (".*")(,?)$/);
			if (entry) table[JSON.parse(`"${entry[1]}"`)] = JSON.parse(entry[2]);
		}
		return table;
	}
	const english = tableOf("en");
	const keys = Object.keys(english);
	assert.ok(keys.length > 100, "English dictionary is populated");
	for (const locale of ["zh", "ja", "es", "fr", "de", "ru", "pt"]) {
		const table = tableOf(locale);
		assert.equal(Object.keys(table).length, keys.length, `${locale} key count`);
		for (const key of keys) {
			assert.ok(key in table, `${locale} is missing ${key}`);
			const placeholders = (text) => (text.match(/\{[A-Za-z]+\}/g) ?? []).sort().join(",");
			assert.equal(placeholders(table[key]), placeholders(english[key]), `${locale}.${key} placeholders`);
		}
	}
});

test("client and login dictionaries contain no zero-width or BOM characters", () => {
	assert.doesNotMatch(clientSource, /[\u200B\uFEFF]/, "client bundle is clean");
	const loginSource = readFileSync(new URL("../lib/login-page.js", import.meta.url), "utf8");
	assert.doesNotMatch(loginSource, /[\u200B\uFEFF]/, "login page is clean");
});
