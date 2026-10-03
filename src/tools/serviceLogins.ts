import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { evaluateConfigWrite } from "../safety.js";
import { supervisorApi, unwrap } from "./addons.js";
import { readIfExists, writeConfigFile } from "./configFiles.js";
import { errorResult, jsonResult, runTool, type ToolContext } from "./helpers.js";

/**
 * A login for a *program* — an MQTT client, a Zigbee bridge, an energy
 * manager — whose password no person or agent ever sees.
 *
 * Wiring a new device into a home usually stalls on one step: someone has to
 * invent a password and type it into two places, the account and the thing
 * that uses it. An agent cannot do that step honestly (it would be choosing
 * and handling a credential), so a setup that was otherwise hands-off stopped
 * and waited for a person. Here the password is generated in this process,
 * written straight into the consumer's own configuration, and dropped. The
 * reply says where it went, never what it is.
 *
 * Because the secret is never returned, a login that could not be delivered
 * anywhere would be a standing account nobody can use or audit, so a fresh
 * login is deleted again when every delivery fails.
 *
 * What it will not do:
 *  - make an admin. A program needs a valid login, not the keys to the house;
 *  - rotate a login it did not create. Rotation is limited to accounts
 *    carrying its own name marker, so it can never reset the owner's or
 *    another person's password;
 *  - deliver outside Home Assistant. A consumer with no add-on options or
 *    secrets file is out of reach from here, and the owner has to be asked.
 */

export const SERVICE_LOGIN_MARKER = "(service login)";

const ROLE_TO_GROUP = { read_only: "system-read-only", user: "system-users" } as const;

const USERNAME = /^[a-z][a-z0-9._-]{1,31}$/;
const SLUG = /^[a-z0-9_]+$/;
const OPTION_PATH = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;
const SECRET_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

const addonTarget = z.object({
	kind: z.literal("addon_options"),
	slug: z.string().regex(SLUG).describe("Add-on slug, e.g. '45df7312_zigbee2mqtt'."),
	username_option: z
		.string()
		.regex(OPTION_PATH)
		.describe("Dotted path of the username in the add-on's options, e.g. 'mqtt.user'."),
	password_option: z
		.string()
		.regex(OPTION_PATH)
		.describe("Dotted path of the password, e.g. 'mqtt.password'."),
	restart: z.boolean().optional().describe("Restart the add-on afterwards so it picks the login up.")
});

const secretsTarget = z.object({
	kind: z.literal("secrets_file"),
	path: z
		.string()
		.optional()
		.describe("Secrets file relative to the config root. Default 'secrets.yaml'; ESPHome uses 'esphome/secrets.yaml'."),
	password_key: z.string().regex(SECRET_KEY).describe("Key the password is stored under, e.g. 'mqtt_password'."),
	username_key: z.string().regex(SECRET_KEY).optional().describe("Optional key for the username too.")
});

type Target = z.infer<typeof addonTarget> | z.infer<typeof secretsTarget>;

interface HaUserRow {
	id: string;
	username?: string | null;
	name: string;
	is_owner: boolean;
	system_generated: boolean;
	group_ids: string[];
}

/** 128 bits, hex: no character that needs quoting in YAML, JSON or a URL. */
export function generateServicePassword(): string {
	return randomBytes(16).toString("hex");
}

/**
 * Set ``key`` at the top level of a secrets file, keeping every other line.
 * Top level only: an indented ``key:`` belongs to some other mapping.
 */
export function upsertSecret(content: string | null, key: string, value: string): string {
	const line = `${key}: "${value}"`;
	const lines = (content ?? "").split("\n");
	const at = lines.findIndex((l) => new RegExp(`^${key}\\s*:`).test(l));
	if (at >= 0) {
		lines[at] = line;
		return lines.join("\n");
	}
	const body = (content ?? "").replace(/\n*$/, "");
	return (body ? `${body}\n` : "") + `${line}\n`;
}

/** Set a dotted path in an options object, creating intermediate maps. */
export function setOption(options: Record<string, unknown>, path: string, value: unknown): void {
	const parts = path.split(".");
	const leaf = parts.pop() as string;
	let node: Record<string, unknown> = options;
	for (const part of parts) {
		const next = node[part];
		if (next === null || typeof next !== "object" || Array.isArray(next)) {
			node[part] = {};
		}
		node = node[part] as Record<string, unknown>;
	}
	node[leaf] = value;
}

function describeTarget(t: Target): string {
	return t.kind === "addon_options"
		? `add-on ${t.slug} (${t.username_option}, ${t.password_option})`
		: `${t.path ?? "secrets.yaml"} (${[t.username_key, t.password_key].filter(Boolean).join(", ")})`;
}

async function addonOptions(ctx: ToolContext, slug: string): Promise<Record<string, unknown>> {
	const info = unwrap(await supervisorApi(ctx, `/addons/${slug}/info`, "get")) as
		| { options?: Record<string, unknown> }
		| undefined;
	if (!info || typeof info.options !== "object" || info.options === null) {
		throw new Error(`add-on ${slug} is not installed, or has no options to set`);
	}
	return info.options;
}

async function deliver(
	ctx: ToolContext,
	target: Target,
	username: string,
	password: string
): Promise<{ restarted?: boolean }> {
	if (target.kind === "addon_options") {
		const options = await addonOptions(ctx, target.slug);
		setOption(options, target.username_option, username);
		setOption(options, target.password_option, password);
		await supervisorApi(ctx, `/addons/${target.slug}/options`, "post", { options });
		if (target.restart) {
			await supervisorApi(ctx, `/addons/${target.slug}/restart`, "post");
			return { restarted: true };
		}
		return {};
	}
	const path = target.path ?? "secrets.yaml";
	let content = await readIfExists(ctx, path, "utf8");
	content = upsertSecret(content, target.password_key, password);
	if (target.username_key) {
		content = upsertSecret(content, target.username_key, username);
	}
	await writeConfigFile(ctx, path, content, "utf8");
	return {};
}

export function registerServiceLoginTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"ha_provision_service_login",
		{
			title: "Give a program its own Home Assistant login, without anyone seeing the password",
			description:
				"Create a non-admin Home Assistant login for a program (an MQTT client such as " +
				"Zigbee2MQTT or an energy manager, an ESPHome device, a bridge), generate its password " +
				"here, and write it straight into where that program reads it: an add-on's options " +
				"and/or a secrets file. **The password is never returned** — not to you and not to the " +
				"owner — so you never have to choose, see or type one. The Mosquitto add-on accepts " +
				"Home Assistant logins, so this is all an MQTT client on this home needs.\n\n" +
				"Ask the owner before calling it: it creates a standing account on their home that " +
				"outlives the API key that made it. Every delivery target is checked before anything " +
				"is created; a new login that could be delivered nowhere is deleted again. Use " +
				"rotate=true to issue a new password to a login this tool created earlier (the old one " +
				"stops working); it refuses any other account. A program outside Home Assistant with " +
				"neither add-on options nor a secrets file cannot be reached from here — ask the owner " +
				"to set its login. Revoke with ha_delete_user. Requires ha:config, plus ha:files for " +
				"secrets_file targets.",
			inputSchema: {
				instance_id: z
					.string()
					.describe(
						"The instance this login is for (as listed by vomehome_list_instances). Checked " +
							"against the one this session is targeting; refused if they differ."
					),
				name: z.string().min(1).max(60).describe("What the login is for, e.g. 'Zigbee2MQTT'."),
				username: z.string().regex(USERNAME).describe("Login name: lowercase, e.g. 'zigbee2mqtt'."),
				role: z
					.enum(["read_only", "user"])
					.optional()
					.describe("'read_only' (default) is enough for MQTT; 'user' if the program drives HA itself."),
				local_only: z
					.boolean()
					.optional()
					.describe("Accept sign-in from the local network only (default true)."),
				deliver_to: z
					.array(z.discriminatedUnion("kind", [addonTarget, secretsTarget]))
					.min(1)
					.max(4)
					.describe("Where the program reads its login. At least one."),
				rotate: z
					.boolean()
					.optional()
					.describe("Re-issue the password of an existing login this tool created, and redeliver it.")
			},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
		},
		async ({ instance_id, name, username, role, local_only, deliver_to, rotate }) => {
			const password = generateServicePassword();
			// Defence in depth: no reply, log line or error leaves with it in.
			const scrub = (text: string) => text.split(password).join("[redacted]");
			const result = await runTool(ctx.logger, "ha_provision_service_login", async () => {
				try {
					return await provision();
				} catch (error) {
					throw new Error(scrub(error instanceof Error ? error.message : String(error)));
				}
			});
			for (const part of result.content) {
				if (part.type === "text") part.text = scrub(part.text);
			}
			return result;

			async function provision() {
				const meant = (instance_id ?? "").trim();
				const targeting = ctx.instances.activeId();
				if (ctx.config.brokered && meant !== targeting) {
					return errorResult(
						`Refused: this session is targeting "${targeting}", but the request names ` +
							`"${meant}". No login was created. Select it with vomehome_use_instance first ` +
							`if "${meant}" is the home you mean.`
					);
				}
				const decision = evaluateConfigWrite(ctx.instances.currentSafety());
				if (!decision.allowed) {
					return errorResult(`Refused: ${decision.reason}`);
				}
				const targets = deliver_to as Target[];
				if (targets.some((t) => t.kind === "secrets_file") && !ctx.config.brokered) {
					return errorResult(
						"Refused: secrets_file targets are written by the Vome component on the home, " +
							"which needs a VomeHome relay-connected Home Assistant. No login was created."
					);
				}
				// Every target must be reachable before an account exists that
				// depends on reaching it.
				for (const t of targets) {
					if (t.kind === "addon_options") {
						try {
							await addonOptions(ctx, t.slug);
						} catch (error) {
							return errorResult(
								`Refused: ${describeTarget(t)} cannot be written ` +
									`(${error instanceof Error ? error.message : String(error)}). No login was created.`
							);
						}
					}
				}

				const users = await ctx.ws.sendCommand<HaUserRow[]>({ type: "config/auth/list" });
				const existing = users.find((u) => (u.username ?? "").toLowerCase() === username);
				let userId: string;
				let created = false;
				if (existing) {
					const ours =
						existing.name.endsWith(SERVICE_LOGIN_MARKER) &&
						!existing.is_owner &&
						!existing.system_generated &&
						!existing.group_ids.includes("system-admin");
					if (!rotate) {
						return errorResult(
							`Refused: the username "${username}" is already taken` +
								(ours
									? ". It is a service login made by this tool: pass rotate=true to issue it a new password and redeliver it."
									: " by an account this tool did not create. Choose another username.")
						);
					}
					if (!ours) {
						return errorResult(
							`Refused: "${username}" is not a service login made by this tool, so its ` +
								"password is not this tool's to change."
						);
					}
					await ctx.ws.sendCommand({
						type: "config/auth_provider/homeassistant/admin_change_password",
						user_id: existing.id,
						password
					});
					userId = existing.id;
				} else {
					if (rotate) {
						return errorResult(`Refused: there is no login "${username}" to rotate. Call again without rotate.`);
					}
					const fresh = await ctx.ws.sendCommand<{ user: HaUserRow }>({
						type: "config/auth/create",
						name: `${name} ${SERVICE_LOGIN_MARKER}`,
						group_ids: [ROLE_TO_GROUP[role ?? "read_only"]],
						local_only: local_only ?? true
					});
					userId = fresh.user.id;
					try {
						await ctx.ws.sendCommand({
							type: "config/auth_provider/homeassistant/create",
							user_id: userId,
							username,
							password
						});
					} catch (error) {
						await ctx.ws.sendCommand({ type: "config/auth/delete", user_id: userId });
						throw error;
					}
					created = true;
				}

				const delivered: Array<Record<string, unknown>> = [];
				const failed: Array<Record<string, unknown>> = [];
				for (const t of targets) {
					try {
						const outcome = await deliver(ctx, t, username, password);
						delivered.push({ target: describeTarget(t), ...outcome });
					} catch (error) {
						failed.push({
							target: describeTarget(t),
							error: error instanceof Error ? error.message : String(error)
						});
					}
				}

				if (delivered.length === 0 && created) {
					await ctx.ws.sendCommand({ type: "config/auth/delete", user_id: userId });
					return errorResult(
						JSON.stringify({
							created: false,
							rolled_back: true,
							failed,
							note: "The login could not be delivered anywhere, so it was deleted again."
						})
					);
				}
				return jsonResult({
					user_id: userId,
					username,
					[created ? "created" : "rotated"]: true,
					password_returned: false,
					delivered,
					...(failed.length > 0
						? {
								failed,
								note:
									"Some targets did not receive the login. Fix them and call again with " +
									"rotate=true, which issues a new password to every target at once."
							}
						: {}),
					revoke: `ha_delete_user with user_id '${userId}'`
				});
			}
		}
	);
}
