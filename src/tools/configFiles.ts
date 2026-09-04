import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { evaluateConfigWrite } from "../safety.js";
import { errorResult, jsonResult, runTool, textResult, type ToolContext } from "./helpers.js";

/**
 * Files under Home Assistant's config directory — configuration.yaml and its
 * neighbours.
 *
 * A hosted Home Assistant has no SSH and no host shell, so anything with no UI
 * equivalent could only be edited through a file-editor add-on in a browser.
 * Every "add this to your configuration.yaml" instruction therefore became a
 * manual step for the owner, however capable the agent was.
 *
 * Gated on its own `ha:files` scope, which covers **reads as well as writes**:
 * configuration.yaml and secrets.yaml are where a home's credentials live, so a
 * monitoring token must not be able to fetch them. That also means file access
 * can be withheld — or removed later — without giving up automation editing.
 *
 * Confinement is enforced on the component running in the home: it resolves the
 * path inside the config directory before checking containment, so a symlink
 * pointing out is refused as well as `..`, and Home Assistant's internal
 * `.storage` is never served.
 */

const NEEDS_RELAY =
	"Config files are served by the Vome component running on the home, so this " +
	"needs a VomeHome relay-connected Home Assistant. A hosted instance without the " +
	"Vome add-on has no route to its own files.";

async function filesRequest<T>(
	ctx: ToolContext,
	path: string,
	init: { method: "GET" | "POST"; body?: Record<string, unknown> }
): Promise<T> {
	if (!ctx.config.brokered) {
		throw new Error(NEEDS_RELAY);
	}
	const instanceId = ctx.instances.activeId();
	const url =
		`${ctx.config.vomehome.apiUrl}/api/v1/instances/` +
		`${encodeURIComponent(instanceId)}/ha/files${path}`;
	const response = await fetch(url, {
		method: init.method,
		headers: {
			Authorization: `Bearer ${ctx.config.vomehome.token}`,
			"Content-Type": "application/json"
		},
		body: init.body === undefined ? undefined : JSON.stringify(init.body)
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`${init.method} ${path} failed (${response.status}): ${text.slice(0, 400)}`);
	}
	return (text ? JSON.parse(text) : undefined) as T;
}

/** Current contents of a file, or null when it does not exist yet. */
async function readIfExists(ctx: ToolContext, path: string): Promise<string | null> {
	try {
		const result = await filesRequest<{ content?: string }>(
			ctx,
			`/read?path=${encodeURIComponent(path)}`,
			{ method: "GET" }
		);
		return result?.content ?? "";
	} catch {
		// Missing, unreadable, or not text. Either way there is nothing to
		// restore to, which the caller is told rather than left to infer.
		return null;
	}
}

function write(
	ctx: ToolContext,
	path: string,
	content: string
): Promise<Record<string, unknown>> {
	return filesRequest<Record<string, unknown>>(
		ctx,
		`/write?path=${encodeURIComponent(path)}`,
		{ method: "POST", body: { content } }
	);
}

/** Home Assistant reports `result: "valid"` when the configuration checks out. */
function isValid(check: { result?: string; errors?: string | null }): boolean {
	return check?.result === "valid" && !check?.errors;
}

export function registerConfigFileTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"ha_list_config_files",
		{
			title: "List files in the config directory",
			description:
				"List a directory under Home Assistant's config directory. Omit 'path' for the root, " +
				"where configuration.yaml lives.\n\n" +
				"Requires the ha:files scope, which covers reads as well as writes because these files " +
				"hold credentials. Home Assistant's internal .storage is never listed.",
			inputSchema: {
				path: z
					.string()
					.optional()
					.describe("Directory relative to the config root, e.g. 'packages'. Omit for the root.")
			},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ path }) =>
			runTool(ctx.logger, "ha_list_config_files", async () => {
				const query = `?path=${encodeURIComponent(path ?? "")}`;
				return jsonResult(await filesRequest(ctx, `/list${query}`, { method: "GET" }));
			})
	);

	server.registerTool(
		"ha_read_config_file",
		{
			title: "Read a config file",
			description:
				"Read a UTF-8 text file under Home Assistant's config directory — configuration.yaml, " +
				"a package, an included YAML file.\n\n" +
				"Read this before writing it: ha_write_config_file replaces the whole file, so the way " +
				"to add a section is read, append, write back. Requires the ha:files scope.",
			inputSchema: {
				path: z.string().describe("File relative to the config root, e.g. 'configuration.yaml'.")
			},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ path }) =>
			runTool(ctx.logger, "ha_read_config_file", async () => {
				const result = await filesRequest<{ content?: string }>(
					ctx,
					`/read?path=${encodeURIComponent(path)}`,
					{ method: "GET" }
				);
				return textResult(result?.content ?? "");
			})
	);

	server.registerTool(
		"ha_write_config_file",
		{
			title: "Write a config file",
			description:
				"Write a UTF-8 text file under Home Assistant's config directory. **This replaces the " +
				"entire file** — read it first with ha_read_config_file and send back the full content " +
				"with your change applied, or you will delete everything else in it.\n\n" +
				"By default the configuration is checked afterwards and **the file is put back if the " +
				"check fails**, so a bad edit cannot leave Home Assistant unable to start. The result " +
				"says whether it was verified, and whether it was rolled back.\n\n" +
				"Pass verify=false when writing several files that are only valid together, then call " +
				"ha_check_config yourself at the end.\n\n" +
				"A successful write does not apply the change: restart Home Assistant, or reload the " +
				"relevant domain, for it to take effect.\n\n" +
				"Requires the ha:files scope. Prefer a purpose-built tool where one exists: helpers via " +
				"ha_set_helper and automations via ha_set_automation both apply immediately and cannot " +
				"break startup.",
			inputSchema: {
				path: z.string().describe("File relative to the config root, e.g. 'configuration.yaml'."),
				content: z.string().describe("The complete new contents of the file."),
				verify: z
					.boolean()
					.optional()
					.describe(
						"Check the configuration afterwards and restore the file if it fails. Default true."
					)
			},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
		},
		async ({ path, content, verify }) =>
			runTool(ctx.logger, "ha_write_config_file", async () => {
				const decision = evaluateConfigWrite(ctx.instances.currentSafety());
				if (!decision.allowed) {
					return errorResult(`Refused: ${decision.reason}`);
				}
				const shouldVerify = verify !== false;
				// Captured before the write so the file can be put back. A file that
				// does not exist yet reads as null, and there is nothing to restore
				// to — see below.
				const previous = shouldVerify ? await readIfExists(ctx, path) : null;

				const result = await write(ctx, path, content);
				if (!shouldVerify) {
					return jsonResult({
						...result,
						verified: false,
						next: "Run ha_check_config when the set of files is complete."
					});
				}

				const check = await ctx.rest.checkConfig();
				if (isValid(check)) {
					return jsonResult({
						...result,
						verified: true,
						next: "Restart Home Assistant, or reload the relevant domain, to apply it."
					});
				}

				if (previous === null) {
					// Nothing to restore to. A brand-new file usually cannot break the
					// configuration unless something !includes it, so leaving it is
					// less surprising than deleting a file the caller just asked for.
					return jsonResult({
						...result,
						verified: false,
						rolled_back: false,
						errors: check.errors,
						note:
							"The configuration does not check out, and this file was new so there was " +
							"nothing to restore. It is left in place. If something !includes it, fix or " +
							"remove it before restarting Home Assistant."
					});
				}

				await write(ctx, path, previous);
				const after = await ctx.rest.checkConfig();
				return jsonResult({
					path,
					written: false,
					verified: false,
					rolled_back: true,
					errors: check.errors,
					// Distinguishing these two matters: rolling back an edit that was
					// *fixing* a pre-existing fault, and blaming the caller for it,
					// would send an agent hunting for a mistake it did not make.
					already_invalid_before_this_edit: !isValid(after),
					note: isValid(after)
						? "The change broke the configuration, so the file was put back as it was."
						: "The configuration was already failing this check before this edit. The " +
							"file was still put back. If you are fixing it in stages, write again " +
							"with verify=false and check at the end."
				});
			})
	);
}
