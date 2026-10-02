import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../logger.js";

/**
 * Which instance each client last chose, kept across restarts of the server.
 *
 * Held only in memory, the choice was lost on every restart — and the hosted
 * server restarts on every deploy — so the next session for every client fell
 * back to the first instance on the account, and agents carried on talking
 * about the wrong house until someone noticed and switched back by hand.
 *
 * Keys are the caller's (a token *hash* plus the client's name); no token is
 * ever written. Entries unused for {@link MAX_AGE_MS} are dropped, as is the
 * oldest beyond {@link MAX_ENTRIES}. Without a state directory, or when the
 * file cannot be written, it carries on in memory: forgetting on restart is
 * the old behaviour, not a failure worth refusing sessions over.
 */
export interface InstanceMemory {
	get(key: string): RememberedInstance | undefined;
	set(key: string, instanceId: string): void;
}

export interface RememberedInstance {
	instanceId: string;
	at: number;
}

const FILE_NAME = "active-instances.json";
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 10_000;

export function createInstanceMemory(
	stateDir: string | null,
	logger: Logger,
	now: () => number = Date.now
): InstanceMemory {
	const entries = new Map<string, RememberedInstance>();
	const file = stateDir ? join(stateDir, FILE_NAME) : null;
	let hasWarned = false;

	if (file) {
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8")) as { entries?: Record<string, RememberedInstance> };
			const cutoff = now() - MAX_AGE_MS;
			for (const [key, value] of Object.entries(parsed.entries ?? {})) {
				if (typeof value?.instanceId === "string" && typeof value.at === "number" && value.at >= cutoff) {
					entries.set(key, { instanceId: value.instanceId, at: value.at });
				}
			}
			logger.debug(`Loaded ${entries.size} remembered instance choice(s) from ${file}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				logger.warn(`Could not read ${file}; starting with no remembered instances: ${String(error)}`);
			}
		}
	}

	function persist(): void {
		if (!file || !stateDir) {
			return;
		}
		try {
			mkdirSync(stateDir, { recursive: true });
			// Write-then-rename, so a crash mid-write leaves the previous file whole.
			const temp = `${file}.${process.pid}.tmp`;
			writeFileSync(temp, JSON.stringify({ version: 1, entries: Object.fromEntries(entries) }), { mode: 0o600 });
			renameSync(temp, file);
		} catch (error) {
			if (!hasWarned) {
				hasWarned = true;
				logger.warn(`Could not save remembered instances to ${file}; they will not survive a restart: ${String(error)}`);
			}
		}
	}

	return {
		get: (key) => entries.get(key),
		set(key, instanceId) {
			entries.delete(key); // re-insert, so the map stays oldest-first
			entries.set(key, { instanceId, at: now() });
			while (entries.size > MAX_ENTRIES) {
				const oldest = entries.keys().next().value;
				if (oldest === undefined) {
					break;
				}
				entries.delete(oldest);
			}
			persist();
		}
	};
}

/**
 * The state directory from systemd's `StateDirectory=`, which sets
 * `$STATE_DIRECTORY` (a colon-separated list when several are configured).
 */
export function stateDirectoryFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
	const first = (env.STATE_DIRECTORY ?? "").split(":")[0]?.trim();
	return first ? first : null;
}
