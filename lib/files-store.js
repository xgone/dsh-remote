/**
 * dsh-remote — allowed-file-root store.
 *
 * The file viewer (/auth/file) reads only inside the DSH home, the process
 * working directory, and the roots listed in `files.roots` (cordis config).
 * Editing that config is clunky for a remote user, so this store keeps a
 * runtime-editable list of user-added roots (absolute paths) that is layered
 * ON TOP of the config roots. The effective roots are therefore
 *
 *     config `files.roots`  +  this store's roots
 *
 * and the store only ever holds what the user added through the settings UI
 * (never the config-provided roots).
 *
 * Persistence mirrors the account store: a single JSON file at
 * `$DSH_HOME/dsh-remote-files.json`, written atomically with 0600 perms and
 * re-read at boot. No restart is needed to apply an add/remove — the /auth/file
 * handler reads `list()` per request.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";

/** Default store location under the harness home. */
export function filesRootsPath() {
	return join(dshHomePath(), "dsh-remote-files.json");
}

/**
 * The allowed-file-roots store. Synchronous I/O like the account store: the
 * file is tiny and touched only on admin edits or at boot. Writes are atomic
 * (tmp + rename) and chmod 0600.
 */
export class FilesRootsStore {
	constructor(path = filesRootsPath()) {
		this.path = path;
		this.roots = [];
	}

	/** Load the store; an absent/invalid file starts empty (never throws). */
	load() {
		let raw = null;
		try {
			raw = readFileSync(this.path, "utf8");
		} catch (error) {
			if (error?.code !== "ENOENT") {
				// Unreadable store — keep the in-memory empty list, don't crash boot.
				this.roots = [];
				return;
			}
		}
		if (raw === null) {
			this.roots = [];
			return;
		}
		try {
			const parsed = JSON.parse(raw);
			this.roots = Array.isArray(parsed?.roots)
				? parsed.roots.filter((r) => typeof r === "string" && r.trim() !== "")
				: [];
		} catch {
			this.roots = [];
		}
	}

	/** Persist the store atomically (0600). */
	save() {
		mkdirSync(dirname(this.path), { recursive: true });
		const tmp = `${this.path}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify({ version: 1, roots: this.roots }, null, 2)}\n`, { mode: 0o600 });
		renameSync(tmp, this.path);
		try {
			chmodSync(this.path, 0o600);
		} catch {
			// best effort
		}
	}

	/** Snapshot of the user-added roots (as typed, deduped, no realpathing). */
	list() {
		return [...this.roots];
	}

	/**
	 * Add one root if it is a non-empty string and not already present
	 * (exact-string identity; realpath dedupe happens in fileRootsFor).
	 * @returns {boolean} true when the store changed.
	 */
	add(root) {
		const trimmed = typeof root === "string" ? root.trim() : "";
		if (trimmed === "" || this.roots.includes(trimmed)) return false;
		this.roots.push(trimmed);
		return true;
	}

	/**
	 * Remove one root by its stored string form.
	 * @returns {boolean} true when the store changed.
	 */
	remove(root) {
		const index = this.roots.indexOf(root);
		if (index === -1) return false;
		this.roots.splice(index, 1);
		return true;
	}

	/** Replace the whole user-added list (used by tests). */
	set(roots) {
		this.roots = Array.isArray(roots) ? roots.filter((r) => typeof r === "string" && r.trim() !== "") : [];
	}
}
