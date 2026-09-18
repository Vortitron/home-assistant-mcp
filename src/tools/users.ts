import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { evaluateConfigWrite } from "../safety.js";
import { errorResult, jsonResult, runTool, type ToolContext } from "./helpers.js";

/**
 * Home Assistant user and login-credential management, over HA's own
 * `config/auth/*` and `config/auth_provider/homeassistant/*` WebSocket
 * commands — there is no REST API for this.
 *
 * **A created user + password is a permanent credential outside VomeHome's
 * revocable PAT model.** Every other write tool here acts *through* the
 * calling API key: revoke the key and the access is gone. A Home Assistant
 * login is not scoped by that key at all — it is a standing account on the
 * home itself, so it survives the PAT that created it being revoked. That
 * makes this the highest-blast-radius tool group in the server: a key that
 * can call ha_create_user (or ha_set_user_credentials on an existing one)
 * can mint itself a durable admin login that outlives its own access.
 * Gated the same way as the other high-privilege tools (local write+config
 * guard, then the portal's ha:config scope decides), but that gate is a
 * revocable key, not a second factor on the *credential itself* — treat
 * granting ha:config on an instance as equivalent to trusting the holder
 * with permanent account creation on that home.
 *
 * `role` maps to Home Assistant's three built-in groups rather than taking
 * raw group_ids, and is required (no default) on create — an accidental
 * default of "admin" would be exactly the wrong direction to fail in.
 */

const ROLE_TO_GROUP: Record<"admin" | "user" | "read_only", string> = {
	admin: "system-admin",
	user: "system-users",
	read_only: "system-read-only"
};

interface HaUserRow {
	id: string;
	username?: string | null;
	name: string;
	is_owner: boolean;
	is_active: boolean;
	local_only: boolean;
	system_generated: boolean;
	group_ids: string[];
	[key: string]: unknown;
}

async function authCommand<T>(ctx: ToolContext, command: Record<string, unknown>): Promise<T> {
	return ctx.ws.sendCommand<T>(command);
}

function refuseWrite(ctx: ToolContext): string {
	return ctx.instances.brokered
		? "Refused: user management is blocked locally for this instance " +
				"(write/config false in VOMEHOME_INSTANCES). Otherwise the API key decides."
		: "Refused: user management needs HA_ALLOW_WRITE and HA_ALLOW_CONFIG_WRITE in direct mode.";
}

const roleSchema = z
	.enum(["admin", "user", "read_only"])
	.describe(
		"'admin' (system-admin, full access), 'user' (system-users, normal dashboard access, no settings), " +
			"or 'read_only' (system-read-only, cannot change anything)."
	);

export function registerUserTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"ha_list_users",
		{
			title: "List Home Assistant users",
			description:
				"List every user on this Home Assistant instance: id, name, username (if they have a " +
				"local login), role (from group_ids), is_active, is_owner, and whether they're " +
				"system-generated (Supervisor's internal users — leave those alone).",
			inputSchema: {},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async () =>
			runTool(ctx.logger, "ha_list_users", async () => {
				const users = await authCommand<HaUserRow[]>(ctx, { type: "config/auth/list" });
				return jsonResult({ count: users.length, users });
			})
	);

	server.registerTool(
		"ha_create_user",
		{
			title: "Create a Home Assistant user",
			description:
				"Create a new Home Assistant user with no login yet — call ha_set_user_credentials " +
				"afterwards to give them a username and password, or they exist but cannot sign in.\n\n" +
				"**A user this creates is a standing account on the home, independent of any API key.** " +
				"Deleting the token that created it does not remove the user. Choose 'role' deliberately: " +
				"'admin' grants full control of this Home Assistant, equivalent to the owner. Requires " +
				"ha:config.",
			inputSchema: {
				name: z.string().describe("Display name for the new user."),
				role: roleSchema,
				local_only: z
					.boolean()
					.optional()
					.describe("Restrict this user to local-network sign-in only (no remote/cloud access).")
			},
			annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true }
		},
		async ({ name, role, local_only }) =>
			runTool(ctx.logger, "ha_create_user", async () => {
				const decision = evaluateConfigWrite(ctx.instances.currentSafety());
				if (!decision.allowed) {
					return errorResult(refuseWrite(ctx));
				}
				const command: Record<string, unknown> = { type: "config/auth/create", name, group_ids: [ROLE_TO_GROUP[role]] };
				if (local_only !== undefined) {
					command.local_only = local_only;
				}
				const result = await authCommand<{ user: HaUserRow }>(ctx, command);
				return jsonResult({
					created: true,
					user: result.user,
					next: `Call ha_set_user_credentials with user_id '${result.user.id}' to give them a login.`
				});
			})
	);

	server.registerTool(
		"ha_update_user",
		{
			title: "Update a Home Assistant user",
			description:
				"Change a user's name, role, active state, or local-only restriction. Omit a field to " +
				"leave it unchanged. Setting is_active=false disables sign-in without deleting the " +
				"account. Cannot modify the owner's active state, or any system-generated (Supervisor) " +
				"user. Requires ha:config.",
			inputSchema: {
				user_id: z.string().describe("User id from ha_list_users."),
				name: z.string().optional(),
				role: roleSchema.optional(),
				is_active: z.boolean().optional().describe("false disables sign-in without deleting the account."),
				local_only: z.boolean().optional()
			},
			annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true }
		},
		async ({ user_id, name, role, is_active, local_only }) =>
			runTool(ctx.logger, "ha_update_user", async () => {
				const decision = evaluateConfigWrite(ctx.instances.currentSafety());
				if (!decision.allowed) {
					return errorResult(refuseWrite(ctx));
				}
				const command: Record<string, unknown> = { type: "config/auth/update", user_id };
				if (name !== undefined) command.name = name;
				if (role !== undefined) command.group_ids = [ROLE_TO_GROUP[role]];
				if (is_active !== undefined) command.is_active = is_active;
				if (local_only !== undefined) command.local_only = local_only;
				const result = await authCommand<{ user: HaUserRow }>(ctx, command);
				return jsonResult({ updated: true, user: result.user });
			})
	);

	server.registerTool(
		"ha_delete_user",
		{
			title: "Delete a Home Assistant user",
			description:
				"Permanently delete a user and any login credentials attached to it. Cannot delete the " +
				"account currently in use (the broker's own owner account) or a system-generated user. " +
				"Requires ha:config.",
			inputSchema: {
				user_id: z.string().describe("User id from ha_list_users.")
			},
			annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true }
		},
		async ({ user_id }) =>
			runTool(ctx.logger, "ha_delete_user", async () => {
				const decision = evaluateConfigWrite(ctx.instances.currentSafety());
				if (!decision.allowed) {
					return errorResult(refuseWrite(ctx));
				}
				await authCommand(ctx, { type: "config/auth/delete", user_id });
				return jsonResult({ deleted: true, user_id });
			})
	);

	server.registerTool(
		"ha_set_user_credentials",
		{
			title: "Give a user a username and password",
			description:
				"Create a local username/password login and attach it to an existing user that has none " +
				"yet (use ha_create_user first). Fails if that username is already taken, or the user " +
				"already has a login (use ha_change_user_password instead).\n\n" +
				"**This mints a standing Home Assistant login independent of any VomeHome API key** — " +
				"revoking the key that called this does not revoke the login. Only do this for an " +
				"account the home's owner actually wants to exist. Requires ha:config.",
			inputSchema: {
				user_id: z.string().describe("User id from ha_list_users or ha_create_user."),
				username: z.string().describe("Login username."),
				password: z.string().describe("Login password, chosen by the caller.")
			},
			annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true }
		},
		async ({ user_id, username, password }) =>
			runTool(ctx.logger, "ha_set_user_credentials", async () => {
				const decision = evaluateConfigWrite(ctx.instances.currentSafety());
				if (!decision.allowed) {
					return errorResult(refuseWrite(ctx));
				}
				await authCommand(ctx, {
					type: "config/auth_provider/homeassistant/create",
					user_id,
					username,
					password
				});
				return jsonResult({ created: true, user_id, username });
			})
	);

	server.registerTool(
		"ha_change_user_password",
		{
			title: "Change a user's password",
			description:
				"Reset the password for a user that already has a local login (created via " +
				"ha_set_user_credentials or Home Assistant's own UI). Only works when the broker is " +
				"acting as the home's owner account, which is how it always authenticates. Requires " +
				"ha:config.",
			inputSchema: {
				user_id: z.string().describe("User id from ha_list_users."),
				password: z.string().describe("New password.")
			},
			annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true }
		},
		async ({ user_id, password }) =>
			runTool(ctx.logger, "ha_change_user_password", async () => {
				const decision = evaluateConfigWrite(ctx.instances.currentSafety());
				if (!decision.allowed) {
					return errorResult(refuseWrite(ctx));
				}
				await authCommand(ctx, {
					type: "config/auth_provider/homeassistant/admin_change_password",
					user_id,
					password
				});
				return jsonResult({ changed: true, user_id });
			})
	);

	server.registerTool(
		"ha_remove_user_credentials",
		{
			title: "Remove a user's login without deleting the user",
			description:
				"Remove the local username/password login from a user, without deleting the user record " +
				"itself. The user still exists (and keeps any other login method) but can no longer sign " +
				"in with this username. Use ha_delete_user to remove the account entirely. Requires " +
				"ha:config.",
			inputSchema: {
				username: z.string().describe("The username to remove (not the user id).")
			},
			annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true }
		},
		async ({ username }) =>
			runTool(ctx.logger, "ha_remove_user_credentials", async () => {
				const decision = evaluateConfigWrite(ctx.instances.currentSafety());
				if (!decision.allowed) {
					return errorResult(refuseWrite(ctx));
				}
				await authCommand(ctx, { type: "config/auth_provider/homeassistant/delete", username });
				return jsonResult({ removed: true, username });
			})
	);
}
