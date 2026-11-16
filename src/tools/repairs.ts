import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { evaluateConfigWrite } from "../safety.js";
import { errorResult, jsonResult, runTool, type ToolContext } from "./helpers.js";

/**
 * Repairs (Settings → Repairs): the issues integrations raise when something
 * needs a person, such as a deprecated YAML option, a broken device, or a
 * breaking change on the way. Home Assistant has them over WebSocket only, and
 * an issue carries just a translation key: the words are in the
 * integration's translations, so this fetches those and fills the
 * placeholders in. Found on GamlaBio, 16 Nov 2026: Supernotify raised one about
 * YAML recipients, and an agent could fix the YAML but not see the repair, nor
 * tell whether it had gone.
 */

export interface RepairIssue {
	issue_id: string;
	domain: string;
	issue_domain?: string | null;
	translation_key?: string | null;
	translation_placeholders?: Record<string, string> | null;
	severity?: string;
	is_fixable?: boolean;
	ignored?: boolean;
	created?: string;
	breaks_in_ha_version?: string | null;
	learn_more_url?: string | null;
	dismissed_version?: string | null;
	[key: string]: unknown;
}

const SEVERITIES = ["critical", "error", "warning"] as const;

function fill(text: string | undefined, placeholders: Record<string, string> | null | undefined): string | undefined {
	if (text === undefined) return undefined;
	return text.replace(/\{([a-zA-Z0-9_]+)\}/g, (whole, key: string) =>
		placeholders && key in placeholders ? String(placeholders[key]) : whole
	);
}

/** The title and description an issue shows in the UI, from the translations of the integration that owns the key. */
export function describeIssue(issue: RepairIssue, resources: Record<string, string>) {
	const owner = issue.issue_domain || issue.domain;
	const base = `component.${owner}.issues.${issue.translation_key ?? issue.issue_id}`;
	const placeholders = issue.translation_placeholders ?? undefined;
	const title = fill(resources[`${base}.title`], placeholders);
	const description = fill(
		resources[`${base}.description`] ?? resources[`${base}.fix_flow.step.confirm.description`],
		placeholders
	);
	return { title: title ?? null, description: description ?? null };
}

export function registerRepairTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"ha_list_repairs",
		{
			title: "List repairs (Settings → Repairs)",
			description:
				"List the issues integrations have raised in Settings → Repairs, in the words the UI " +
				"shows: title and description, with severity, the integration, whether HA can fix it " +
				"from the UI (is_fixable), the version it breaks in, and a learn-more link. Ignored ones " +
				"are left out unless include_ignored. Use after editing configuration to see whether a " +
				"repair has gone; most clear only after a restart or a reload of the integration.",
			inputSchema: {
				domain: z
					.string()
					.optional()
					.describe("Only issues raised by this integration (or about it), e.g. 'supernotify'."),
				include_ignored: z.boolean().optional().describe("Also list issues someone has ignored."),
				language: z.string().optional().describe("Language for the text (default 'en').")
			},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ domain, include_ignored, language }) =>
			runTool(ctx.logger, "ha_list_repairs", async () => {
				const listed = await ctx.rest.sendWsCommand<{ issues?: RepairIssue[] }>({ type: "repairs/list_issues" });
				const all = Array.isArray(listed?.issues) ? listed.issues : [];
				const issues = all.filter(
					(issue) =>
						(include_ignored || !issue.ignored) &&
						(!domain || issue.domain === domain || issue.issue_domain === domain)
				);

				let resources: Record<string, string> = {};
				let translationsError: string | undefined;
				const owners = [...new Set(issues.map((issue) => issue.issue_domain || issue.domain))];
				if (owners.length > 0) {
					try {
						const got = await ctx.rest.sendWsCommand<{ resources?: Record<string, string> }>({
							type: "frontend/get_translations",
							language: language ?? "en",
							category: "issues",
							integration: owners
						});
						resources = got?.resources ?? {};
					} catch (err) {
						translationsError = err instanceof Error ? err.message : String(err);
					}
				}

				const rank = (s?: string) => {
					const i = SEVERITIES.indexOf((s ?? "") as (typeof SEVERITIES)[number]);
					return i < 0 ? SEVERITIES.length : i;
				};
				const rows = issues
					.map((issue) => ({
						...describeIssue(issue, resources),
						domain: issue.domain,
						issue_id: issue.issue_id,
						severity: issue.severity ?? null,
						is_fixable: issue.is_fixable ?? false,
						ignored: issue.ignored ?? false,
						created: issue.created ?? null,
						breaks_in_ha_version: issue.breaks_in_ha_version ?? null,
						learn_more_url: issue.learn_more_url ?? null,
						translation_key: issue.translation_key ?? null,
						translation_placeholders: issue.translation_placeholders ?? null,
						...(issue.issue_domain && issue.issue_domain !== issue.domain ? { issue_domain: issue.issue_domain } : {})
					}))
					.sort((a, b) => rank(a.severity ?? undefined) - rank(b.severity ?? undefined));

				return jsonResult({
					count: rows.length,
					ignored_hidden: include_ignored ? 0 : all.filter((issue) => issue.ignored).length,
					issues: rows,
					...(translationsError ? { translations_error: translationsError } : {})
				});
			})
	);

	server.registerTool(
		"ha_ignore_repair",
		{
			title: "Ignore or un-ignore a repair",
			description:
				"Ignore a repair (Settings → Repairs → Ignore), or bring an ignored one back with " +
				"ignore: false. This hides it; it fixes nothing. Fix the cause where you can and use " +
				"this for issues that are known and accepted. Get domain and issue_id from " +
				"ha_list_repairs. Requires config-write (ha:config).",
			inputSchema: {
				domain: z.string().describe("The issue's domain, from ha_list_repairs."),
				issue_id: z.string().describe("The issue's issue_id, from ha_list_repairs."),
				ignore: z.boolean().optional().describe("false un-ignores it (default true).")
			},
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
		},
		async ({ domain, issue_id, ignore }) =>
			runTool(ctx.logger, "ha_ignore_repair", async () => {
				const decision = evaluateConfigWrite(ctx.instances.currentSafety());
				if (!decision.allowed) {
					return errorResult(`Refused: ${decision.reason}`);
				}
				const listed = await ctx.rest.sendWsCommand<{ issues?: RepairIssue[] }>({ type: "repairs/list_issues" });
				const found = (listed?.issues ?? []).find((issue) => issue.domain === domain && issue.issue_id === issue_id);
				if (!found) {
					return errorResult(`No repair ${domain}/${issue_id}. ha_list_repairs (include_ignored) lists them.`);
				}
				const wanted = ignore ?? true;
				await ctx.rest.sendWsCommand({ type: "repairs/ignore_issue", domain, issue_id, ignore: wanted });
				return jsonResult({ domain, issue_id, ignored: wanted, was_ignored: found.ignored ?? false });
			})
	);
}
