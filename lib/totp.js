/**
 * dsh-remote — TOTP (RFC 6238) and backup-code helpers.
 *
 * Zero-dependency: HMAC-SHA1 from node:crypto, base32 from a small table.
 * Tested against the RFC 6238 SHA-1 appendix vectors.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Encode bytes as RFC 4648 base32 (no padding). */
export function base32Encode(buffer) {
	let bits = 0;
	let value = 0;
	let out = "";
	for (const byte of buffer) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
	return out;
}

/** Decode RFC 4648 base32 (padding optional, case-insensitive). */
export function base32Decode(text) {
	const cleaned = String(text).toUpperCase().replace(/=+$/g, "").replace(/\s+/g, "");
	let bits = 0;
	let value = 0;
	const bytes = [];
	for (const char of cleaned) {
		const index = BASE32_ALPHABET.indexOf(char);
		if (index === -1) throw new Error("invalid base32 character");
		value = (value << 5) | index;
		bits += 5;
		if (bits >= 8) {
			bytes.push((value >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}
	return Buffer.from(bytes);
}

export const TOTP_PERIOD = 30;
export const TOTP_DIGITS = 6;

/**
 * Compute the current TOTP code for a base32 secret at a given counter.
 * @param {string} secretBase32 - the shared secret (base32, no padding).
 * @param {number} counter - the time counter (defaults to now / period).
 * @returns {string} the zero-padded 6-digit code.
 */
export function totp(secretBase32, counter = Math.floor(Date.now() / 1000 / TOTP_PERIOD)) {
	const key = base32Decode(secretBase32);
	const message = Buffer.alloc(8);
	message.writeBigUInt64BE(BigInt(counter));
	const digest = createHmac("sha1", key).update(message).digest();
	const offset = digest[digest.length - 1] & 0x0f;
	const binary = ((digest[offset] & 0x7f) << 24) |
		((digest[offset + 1] & 0xff) << 16) |
		((digest[offset + 2] & 0xff) << 8) |
		(digest[offset + 3] & 0xff);
	return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/**
 * Verify a submitted code against a base32 secret, allowing a ±window of
 * time steps around the current one (clock drift / slow entry).
 * @returns {boolean} whether the code matched any step in the window.
 */
export function verifyTotp(secretBase32, code, window = 1) {
	if (typeof code !== "string" || !/^\d{6}$/.test(code)) return false;
	const current = Math.floor(Date.now() / 1000 / TOTP_PERIOD);
	for (let offset = -window; offset <= window; offset += 1) {
		if (totp(secretBase32, current + offset) === code) return true;
	}
	return false;
}

/** A fresh 20-byte TOTP secret, base32 (32 chars). */
export function generateTotpSecret() {
	return base32Encode(randomBytes(20));
}

/**
 * The otpauth:// URI for an authenticator app.
 * @param {object} options - { secret, account, issuer }.
 */
export function otpauthUri({ secret, account, issuer }) {
	const label = `${issuer}:${account}`;
	const params = new URLSearchParams({
		secret,
		issuer,
		algorithm: "SHA1",
		digits: String(TOTP_DIGITS),
		period: String(TOTP_PERIOD)
	});
	return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

/** N one-time backup codes (8 chars, unambiguous alphabet). */
export function generateBackupCodes(count = 10) {
	const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
	const codes = [];
	for (let i = 0; i < count; i += 1) {
		const bytes = randomBytes(8);
		let code = "";
		for (let j = 0; j < 8; j += 1) code += alphabet[bytes[j] % alphabet.length];
		codes.push(code);
	}
	return codes;
}

/** SHA-256 hex of a backup code (the only form stored on disk). */
export function hashBackupCode(code) {
	return createHash("sha256").update(String(code)).digest("hex");
}

/**
 * Match a submitted backup code against stored hashes, returning the
 * matching stored entry (for marking used) or null.
 * @param {string} code - the submitted code.
 * @param {Array<{hash: string, usedAt?: number}>} entries - stored hashes.
 */
export function findBackupCode(code, entries) {
	const submitted = String(code).trim().toUpperCase();
	const hash = hashBackupCode(submitted);
	return entries.find((entry) => entry.hash === hash && entry.usedAt === undefined) ?? null;
}
