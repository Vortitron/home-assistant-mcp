/**
 * Tiny stderr logger.
 *
 * IMPORTANT: when this process runs as an MCP stdio server, stdout is the
 * JSON-RPC channel and must never be polluted with log output. Every log line
 * therefore goes to stderr.
 */

export type LogLevel = "error" | "warn" | "info" | "debug";

export interface Logger {
	error(message: string, meta?: unknown): void;
	warn(message: string, meta?: unknown): void;
	info(message: string, meta?: unknown): void;
	debug(message: string, meta?: unknown): void;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
	error: 0,
	warn: 1,
	info: 2,
	debug: 3
};

function serialiseMeta(meta: unknown): string {
	if (meta === undefined) {
		return "";
	}
	if (typeof meta === "string") {
		return ` ${meta}`;
	}
	try {
		return ` ${JSON.stringify(meta)}`;
	} catch {
		return " [unserialisable meta]";
	}
}

export function createLogger(level: LogLevel): Logger {
	const threshold = LEVEL_WEIGHT[level] ?? LEVEL_WEIGHT.info;

	function write(lineLevel: LogLevel, message: string, meta?: unknown): void {
		if (LEVEL_WEIGHT[lineLevel] > threshold) {
			return;
		}
		const timestamp = new Date().toISOString();
		const line = `${timestamp} [${lineLevel.toUpperCase()}] ${message}${serialiseMeta(meta)}\n`;
		process.stderr.write(line);
	}

	return {
		error: (message, meta) => write("error", message, meta),
		warn: (message, meta) => write("warn", message, meta),
		info: (message, meta) => write("info", message, meta),
		debug: (message, meta) => write("debug", message, meta)
	};
}
