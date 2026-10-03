import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { decodeImage, downsample, shrink } from "../ha/pixels.js";
import { jsonResult, runTool, type ToolContext } from "./helpers.js";

/**
 * Everything a dashboard view draws, in one call.
 *
 * A dashboard pane refreshing a view used to make four to six calls each time
 * (states, every Markdown template, every history graph, every camera), each
 * a round trip and each counted against the key's limits. This takes the
 * whole list at once and answers it together: states from one read of every
 * state, templates rendered, history as a few points a series, camera stills
 * as small grids of pixels. A part that fails says so in its place; the rest
 * still answers.
 */

const MAX_ENTITIES = 200;

export function registerSnapshotTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"ha_view_snapshot",
		{
			title: "Snapshot of a dashboard view",
			description:
				"In one call, everything a dashboard view shows: the state and attributes of each entity, each " +
				"Markdown template rendered, history as a few points per series, and camera stills as small RGB " +
				"grids. For a client drawing a dashboard (such as a pane in Claude Code); to read a few entities " +
				"yourself, ha_get_state is simpler. Parts that fail carry an error; the rest still answers. Camera " +
				"stills need the key's Cameras tick through VomeHome.",
			inputSchema: {
				entity_ids: z.array(z.string()).max(MAX_ENTITIES).optional().describe("Entities whose state to return."),
				templates: z
					.record(z.string(), z.string())
					.optional()
					.describe("Templates to render, by a key of the caller's choosing (at most 10)."),
				history: z
					.array(
						z.object({
							key: z.string(),
							entity_ids: z.array(z.string()).min(1).max(20),
							hours: z.number().positive().max(24 * 14),
							max_points: z.number().int().min(2).max(1000)
						})
					)
					.max(8)
					.optional()
					.describe("History graphs: per key, the entities, how many hours back, and points per series."),
				frames: z
					.array(
						z.object({
							key: z.string(),
							entity_id: z.string(),
							width: z.number().int().min(4).max(160),
							height: z.number().int().min(4).max(160)
						})
					)
					.max(4)
					.optional()
					.describe("Camera stills: per key, the camera and the most pixels across and down.")
			},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ entity_ids, templates, history, frames }) =>
			runTool(ctx.logger, "ha_view_snapshot", async () => {
				const fail = (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) });
				const templateEntries = Object.entries(templates ?? {}).slice(0, 10);
				const [states, rendered, graphs, stills] = await Promise.all([
					entity_ids?.length
						? ctx.rest
								.getStates()
								.then((all) => {
									const byId = new Map(all.map((state) => [state.entity_id, state]));
									return Object.fromEntries(
										entity_ids.map((id) => {
											const state = byId.get(id);
											return [id, state ? { state: state.state, attributes: state.attributes ?? {} } : null];
										})
									);
								})
								.catch(fail)
						: Promise.resolve({}),
					Promise.all(
						templateEntries.map(([key, template]) =>
							ctx.rest
								.renderTemplate(template)
								.then((text) => [key, text] as const)
								.catch((error) => [key, fail(error)] as const)
						)
					),
					Promise.all(
						(history ?? []).map((graph) =>
							ctx.rest
								.getHistory({
									entityIds: graph.entity_ids,
									startTime: new Date(Date.now() - graph.hours * 3600_000).toISOString(),
									minimalResponse: true,
									significantChangesOnly: false
								})
								.then(
									(series) =>
										[
											graph.key,
											series.map((list, i) => ({
												entity_id: list[0]?.entity_id ?? graph.entity_ids[i] ?? null,
												unit: (list[0]?.attributes?.unit_of_measurement as string | undefined) ?? null,
												points: downsample(list, graph.max_points)
											}))
										] as const
								)
								.catch((error) => [graph.key, fail(error)] as const)
						)
					),
					Promise.all(
						(frames ?? []).map((frame) =>
							(/^camera\.[a-z0-9_]+$/.test(frame.entity_id)
								? ctx.rest.getCameraImage(frame.entity_id, Math.max(320, frame.width * 4)).then((image) => {
										const pixels = shrink(decodeImage(image.data, image.mimeType), frame.width, frame.height);
										return { width: pixels.width, height: pixels.height, rgb: pixels.rgb.toString("base64") };
									})
								: Promise.reject(new Error(`'${frame.entity_id}' is not a camera entity.`))
							)
								.then((result) => [frame.key, result] as const)
								.catch((error) => [frame.key, fail(error)] as const)
						)
					)
				]);
				return jsonResult({
					at: new Date().toISOString(),
					states,
					templates: Object.fromEntries(rendered),
					history: Object.fromEntries(graphs),
					frames: Object.fromEntries(stills)
				});
			})
	);
}
