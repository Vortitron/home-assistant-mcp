import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * How often each tool is called on the hosted server, and how often it fails.
 *
 * Why: the hosted server logged only failures, so nobody could say whether a
 * tool (the Assist pipeline tools, say) was ever used, or by how many. This
 * counts calls per tool name and logs one summary line per window.
 *
 * What it deliberately does not keep: which token, account, session or home
 * made a call, or any argument. Tool names and counts only, summed across
 * every session, so a summary line cannot be traced back to anyone. Who is
 * calling is the portal's business: it already audits each brokered call
 * against the user and token that made it.
 */
export class ToolUsage {
	private calls = new Map<string, { ok: number; failed: number }>();
	private since = Date.now();

	record(name: string, ok: boolean): void {
		const entry = this.calls.get(name) ?? { ok: 0, failed: 0 };
		if (ok) entry.ok += 1;
		else entry.failed += 1;
		this.calls.set(name, entry);
	}

	/**
	 * The window's summary, busiest tool first, and a fresh window; null when
	 * nothing was called, so a quiet server writes nothing.
	 */
	flush(now: number = Date.now()): string | null {
		const entries = [...this.calls.entries()];
		const minutes = Math.max(1, Math.round((now - this.since) / 60_000));
		this.calls = new Map();
		this.since = now;
		if (entries.length === 0) return null;
		entries.sort((a, b) => b[1].ok + b[1].failed - (a[1].ok + a[1].failed) || a[0].localeCompare(b[0]));
		let total = 0;
		const parts = entries.map(([name, { ok, failed }]) => {
			total += ok + failed;
			return failed > 0 ? `${name}=${ok + failed} (${failed} failed)` : `${name}=${ok}`;
		});
		return `Tool calls in the last ${minutes} min: ${total} total; ${parts.join(", ")}`;
	}
}

/**
 * Wraps a server so every tool it registers is counted in `usage`. A reply
 * with isError counts as failed, and so does a handler that throws (the throw
 * is passed on untouched).
 */
export function withToolUsage(server: McpServer, usage: ToolUsage): McpServer {
	const original = server.registerTool.bind(server);
	const wrapped = ((name: string, config: unknown, handler: unknown) => {
		const counted = async (...args: unknown[]): Promise<CallToolResult> => {
			try {
				const result = await (handler as (...a: unknown[]) => Promise<CallToolResult>)(...args);
				usage.record(name, !result?.isError);
				return result;
			} catch (error) {
				usage.record(name, false);
				throw error;
			}
		};
		return (original as (n: string, c: unknown, h: unknown) => unknown)(name, config, counted);
	}) as unknown as McpServer["registerTool"];

	return new Proxy(server, {
		get(target, prop, receiver) {
			if (prop === "registerTool") return wrapped;
			const value = Reflect.get(target, prop, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		}
	}) as McpServer;
}
