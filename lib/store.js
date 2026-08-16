/**
 * dsh-remote — account store and credential crypto.
 *
 * The authoritative account store lives at $DSH_HOME/auth/store.json:
 *   { version: 1, secret: <base64url 32 bytes>, accounts: [...] }
 * Passwords are stored as scrypt hashes (`scrypt$<saltB64>$<hashB64>`),
 * never plaintext. The store file is written 0600.
 */
import { createHmac, randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { hashBackupCode } from "./totp.js";

const scryptAsync = promisify(scrypt);

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

/** Hash a password with scrypt (synchronous — boot-time seeding only). */
export function hashPasswordSync(password) {
	const salt = randomBytes(16);
	const derived = scryptSync(String(password), salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
	return `scrypt$${salt.toString("base64")}$${derived.toString("base64")}`;
}

/** Verify a password against a stored hash (async — login path). */
export async function verifyPassword(password, stored) {
	if (typeof stored !== "string" || stored.length === 0) return false;
	if (!stored.startsWith("scrypt$")) {
		// Plaintext legacy entry: compare constant-time. The UI never stores this.
		const a = Buffer.from(String(password));
		const b = Buffer.from(String(stored));
		return a.length === b.length && timingSafeEqual(a, b);
	}
	const parts = stored.split("$");
	if (parts.length !== 3) return false;
	const [, saltB64, hashB64] = parts;
	let salt;
	let expected;
	try {
		salt = Buffer.from(saltB64, "base64");
		expected = Buffer.from(hashB64, "base64");
	} catch {
		return false;
	}
	if (salt.length === 0 || expected.length === 0) return false;
	const derived = await scryptAsync(String(password), salt, expected.length, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
	return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** HMAC-SHA256 signature helper. */
export function hmac(secret, message) {
	return createHmac("sha256", secret).update(message).digest();
}

/** Random signing secret (base64url). */
export function generateSecret() {
	return randomBytes(32).toString("base64url");
}

/** Default store location under the harness home. */
export function defaultStorePath() {
	return join(dshHomePath(), "auth", "store.json");
}

/**
 * The account store. All I/O is synchronous: the plugin apply is synchronous
 * in Cordis, and the file is small and only touched at boot or on admin
 * edits. Writes are atomic (tmp file + rename) and chmod 0600.
 */
export class AccountStore {
	constructor(path = defaultStorePath()) {
		this.path = path;
		this.data = null;
	}

	/** Load the store; creates an empty one on first run. */
	load() {
		let raw = null;
		try {
			raw = readFileSync(this.path, "utf8");
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
		if (raw === null) {
			this.data = { version: 1, secret: generateSecret(), accounts: [] };
			this.save();
			return;
		}
		const parsed = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.accounts)) {
			throw new Error(`dsh-remote: invalid account store at ${this.path}`);
		}
		this.data = {
			version: 1,
			secret: typeof parsed.secret === "string" && parsed.secret.length >= 32 ? parsed.secret : generateSecret(),
			accounts: parsed.accounts.filter((a) => typeof a?.username === "string" && typeof a?.passwordHash === "string")
		};
		// Migration: the FIRST account ever created is the root — it cannot be
		// removed or demoted, only its password can be reset. Mark it protected
		// when the store predates the flag (oldest by createdAt, array order as
		// a tiebreak) and persist the migration.
		if (this.data.accounts.length > 0 && !this.data.accounts.some((a) => a.protected === true)) {
			const first = [...this.data.accounts].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))[0];
			first.protected = true;
			this.save();
		}
	}

	/** Persist the store atomically. */
	save() {
		mkdirSync(dirname(this.path), { recursive: true });
		const tmp = `${this.path}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
		renameSync(tmp, this.path);
		try {
			// Keep permissions tight even if umask widened them.
			chmodSync(this.path, 0o600);
		} catch {
			// best effort
		}
	}

	get secret() {
		return this.data.secret;
	}

	/** Whether any account exists (bootstrap state). */
	get hasAccounts() {
		return this.data.accounts.length > 0;
	}

	/** Public view of the account list (no hashes, no secrets). */
	list() {
		return this.data.accounts.map((a) => ({
			username: a.username,
			role: a.role ?? "user",
			protected: a.protected === true,
			mfa: a.totp?.verified === true,
			mfaPending: a.totp !== undefined && a.totp.verified !== true,
			createdAt: a.createdAt,
			updatedAt: a.updatedAt,
			lastLoginAt: a.lastLoginAt ?? null
		}));
	}

	/** Public MFA status for one account (never the secret). */
	mfaInfo(username) {
		const account = this.find(username);
		if (!account || !account.totp) return { enabled: false, pending: false };
		return {
			enabled: account.totp.verified === true,
			pending: account.totp.verified !== true,
			createdAt: account.totp.createdAt
		};
	}

	/**
	 * Begin TOTP setup for an account: store the secret unverified plus the
	 * hashed one-time backup codes. Any previous MFA state is replaced.
	 */
	beginTotpSetup(username, secretBase32, backupCodeHashes) {
		const account = this.find(username);
		if (!account) return false;
		account.totp = {
			secret: secretBase32,
			verified: false,
			createdAt: Date.now()
		};
		account.backupCodes = backupCodeHashes.map((hash) => ({ hash }));
		account.updatedAt = Date.now();
		return true;
	}

	/** Confirm a pending TOTP setup (code verified). */
	confirmTotp(username) {
		const account = this.find(username);
		if (!account?.totp || account.totp.verified) return false;
		account.totp.verified = true;
		account.updatedAt = Date.now();
		return true;
	}

	/** Remove MFA (secret + backup codes) from an account. */
	disableTotp(username) {
		const account = this.find(username);
		if (!account) return false;
		const had = account.totp !== undefined;
		delete account.totp;
		delete account.backupCodes;
		account.updatedAt = Date.now();
		return had;
	}

	/**
	 * Consume a backup code: mark its stored hash used and return true.
	 * @param {string} username - the account.
	 * @param {string} code - the submitted code (case-insensitive).
	 */
	consumeBackupCode(username, code) {
		const account = this.find(username);
		if (!account || !Array.isArray(account.backupCodes)) return false;
		const entry = account.backupCodes.find(
			(b) => b.hash === hashBackupCode(String(code).trim().toUpperCase()) && b.usedAt === undefined
		);
		if (!entry) return false;
		entry.usedAt = Date.now();
		account.updatedAt = Date.now();
		return true;
	}

	find(username) {
		return this.data.accounts.find((a) => a.username === username) ?? null;
	}

	/** Create or update an account. Password hash is caller-provided. */
	upsert({ username, role, passwordHash }) {
		const now = Date.now();
		const existing = this.find(username);
		if (existing) {
			existing.role = role ?? existing.role ?? "user";
			if (passwordHash !== undefined && passwordHash !== "") existing.passwordHash = passwordHash;
			existing.updatedAt = now;
			return existing;
		}
		const account = {
			username,
			role: role ?? "user",
			passwordHash: passwordHash ?? "",
			// The account that first fills an empty store is the root: protected.
			protected: this.data.accounts.length === 0,
			createdAt: now,
			updatedAt: now,
			lastLoginAt: null
		};
		this.data.accounts.push(account);
		return account;
	}

	remove(username) {
		const before = this.data.accounts.length;
		this.data.accounts = this.data.accounts.filter((a) => a.username !== username);
		return this.data.accounts.length < before;
	}

	markLogin(username) {
		const account = this.find(username);
		if (account) account.lastLoginAt = Date.now();
	}

	/** Count of accounts with the given role (or total when role is null). */
	countAdmins() {
		return this.data.accounts.filter((a) => (a.role ?? "user") === "admin").length;
	}
}
