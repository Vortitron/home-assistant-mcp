import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HaApiError } from "../ha/restClient.js";
import { errorResult, getFriendlyName, runTool, type ToolContext } from "./helpers.js";

/**
 * Looking through a camera. An agent could take a snapshot with
 * camera.snapshot but never see it: nothing returned an image. This returns
 * the camera's current still as MCP image content, so the model can check
 * framing, exposure or what is at the door.
 *
 * Through VomeHome it needs the API key's Cameras tick (Sensitive devices),
 * the same one camera services need: seeing into a house is at least as
 * sensitive as switching a camera off.
 */

const DEFAULT_WIDTH = 1024;

export function registerCameraTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"ha_camera_image",
		{
			title: "Look at a camera",
			description:
				"Return a camera's current still as an image you can see — to check framing, exposure, or what the camera shows. For a camera entity that shows the latest snapshot file, this is that snapshot. Home Assistant scales it to 'width' pixels wide (default 1024). Through VomeHome the API key needs Cameras ticked under Sensitive devices.",
			inputSchema: {
				entity_id: z.string().describe("The camera entity, e.g. 'camera.front_door'."),
				width: z
					.number()
					.int()
					.min(64)
					.max(3840)
					.optional()
					.describe(`Width in pixels to scale the still to (default ${DEFAULT_WIDTH}).`)
			},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ entity_id, width }) =>
			runTool(ctx.logger, "ha_camera_image", async () => {
				if (!/^camera\.[a-z0-9_]+$/.test(entity_id)) {
					return errorResult(`'${entity_id}' is not a camera entity (camera.something).`);
				}
				let image;
				try {
					image = await ctx.rest.getCameraImage(entity_id, width ?? DEFAULT_WIDTH);
				} catch (error) {
					if (error instanceof HaApiError && error.status === 404) {
						return errorResult(
							`No image for ${entity_id}: no such camera, or it has nothing to show yet. List cameras with ha_list_entities domain=camera.`
						);
					}
					throw error;
				}
				// What was looked at, and how recent it is: a snapshot camera shows
				// whatever was last written, which may be old.
				let caption = entity_id;
				try {
					const state = await ctx.rest.getState(entity_id);
					const name = getFriendlyName(state.attributes);
					caption = `${name ? `${name} (${entity_id})` : entity_id}, state '${state.state}', last updated ${state.last_updated ?? "unknown"}.`;
				} catch {
					// The picture is the answer; a missing caption is not worth failing for.
				}
				return {
					content: [
						{ type: "image" as const, data: image.data, mimeType: image.mimeType },
						{ type: "text" as const, text: caption }
					]
				};
			})
	);
}
