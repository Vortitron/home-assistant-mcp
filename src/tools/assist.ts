import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { evaluateConfigWrite } from "../safety.js";
import { errorResult, jsonResult, runTool, type ToolContext } from "./helpers.js";

/**
 * Assist pipelines: which conversation agent, speech-to-text, text-to-speech
 * and wake word each voice assistant uses (Settings → Voice assistants).
 * Home Assistant has no REST API for them, only WebSocket, and keeps them in
 * .storage, which Vome never reads; so without these tools an agent could not
 * tell a satellite to use another speech-to-text engine.
 */

type Pipeline = Record<string, unknown> & { id?: string; name?: string };

interface PipelineList {
	pipelines?: Pipeline[];
	preferred_pipeline?: string | null;
}

/** The fields a caller may change; anything else the pipeline has is sent back as it was. */
const SETTABLE = [
	"name",
	"language",
	"conversation_engine",
	"conversation_language",
	"stt_engine",
	"stt_language",
	"tts_engine",
	"tts_language",
	"tts_voice",
	"wake_word_entity",
	"wake_word_id",
	"prefer_local_intents"
] as const;

/** The select a satellite picks its pipeline with: options are "preferred" plus the pipeline names. */
function isPipelineSelect(state: { entity_id?: string; attributes?: Record<string, unknown> }): boolean {
	const id = state.entity_id ?? "";
	if (!id.startsWith("select.") || !/_(assistant|assist_pipeline|pipeline)$/.test(id)) {
		return false;
	}
	const options = state.attributes?.options;
	return Array.isArray(options) && options.includes("preferred");
}

/**
 * The body for assist_pipeline/pipeline/update. HA replaces the whole pipeline
 * with what it is sent and requires every field, so a one-field update is the
 * pipeline as it stands with that field changed: never the field alone.
 */
export function mergePipelineUpdate(current: Pipeline, changes: Record<string, unknown>): Record<string, unknown> {
	const { id, ...rest } = current;
	const body: Record<string, unknown> = { ...rest };
	for (const [key, value] of Object.entries(changes)) {
		if (value !== undefined) {
			body[key] = value;
		}
	}
	return { type: "assist_pipeline/pipeline/update", pipeline_id: id, ...body };
}

function findPipeline(pipelines: Pipeline[], ref: string): Pipeline | Pipeline[] | undefined {
	const byId = pipelines.find((p) => p.id === ref);
	if (byId) return byId;
	const byName = pipelines.filter((p) => typeof p.name === "string" && p.name.toLowerCase() === ref.toLowerCase());
	if (byName.length === 1) return byName[0];
	return byName.length > 1 ? byName : undefined;
}

export function registerAssistTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"ha_list_assist_pipelines",
		{
			title: "List Assist pipelines (voice assistants)",
			description:
				"List the home's voice assistants (Settings → Voice assistants): for each, the id, name, " +
				"language, conversation agent, speech-to-text and text-to-speech engines with their " +
				"language and voice, wake word, and whether local intents are tried first. Says which " +
				"is preferred, and which satellites use each one (their Assistant select; a satellite on " +
				"'preferred' follows the preferred one). Change one with ha_set_assist_pipeline.",
			inputSchema: {},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async () =>
			runTool(ctx.logger, "ha_list_assist_pipelines", async () => {
				const listed = await ctx.rest.sendWsCommand<PipelineList>({ type: "assist_pipeline/pipeline/list" });
				const pipelines = Array.isArray(listed?.pipelines) ? listed.pipelines : [];
				const preferred = listed?.preferred_pipeline ?? null;

				const users = new Map<string, string[]>();
				let satellitesError: string | undefined;
				try {
					const states = await ctx.rest.getStates();
					for (const state of states ?? []) {
						if (!isPipelineSelect(state)) continue;
						const picked = String(state.state);
						const pipeline =
							picked === "preferred"
								? pipelines.find((p) => p.id === preferred)
								: pipelines.find((p) => p.name === picked);
						const key = pipeline?.id ?? `unknown:${picked}`;
						users.set(key, [...(users.get(key) ?? []), state.entity_id]);
					}
				} catch (err) {
					satellitesError = err instanceof Error ? err.message : String(err);
				}

				return jsonResult({
					count: pipelines.length,
					preferred_pipeline: preferred,
					pipelines: pipelines.map((p) => ({
						...p,
						preferred: p.id === preferred,
						used_by: users.get(String(p.id)) ?? []
					})),
					...(satellitesError ? { satellites_error: satellitesError } : {})
				});
			})
	);

	server.registerTool(
		"ha_set_assist_pipeline",
		{
			title: "Change an Assist pipeline (voice assistant)",
			description:
				"Change one voice assistant's settings, e.g. its speech-to-text engine " +
				"(stt_engine: 'stt.vome_hearing'). Name the pipeline by id or name (ha_list_assist_pipelines) " +
				"and give only the fields to change: the rest are kept, because the pipeline is read " +
				"first and sent back whole (Home Assistant replaces it with whatever it is sent). " +
				"null clears an optional engine (no speech-to-text, no wake word). make_preferred " +
				"also makes it the preferred assistant. Requires config-write (ha:config).",
			inputSchema: {
				pipeline: z.string().describe("Pipeline id or name, from ha_list_assist_pipelines."),
				name: z.string().optional(),
				language: z.string().optional(),
				conversation_engine: z.string().optional().describe("e.g. 'conversation.home_assistant'"),
				conversation_language: z.string().optional(),
				stt_engine: z.string().nullable().optional().describe("e.g. 'stt.vome_hearing'"),
				stt_language: z.string().nullable().optional(),
				tts_engine: z.string().nullable().optional(),
				tts_language: z.string().nullable().optional(),
				tts_voice: z.string().nullable().optional(),
				wake_word_entity: z.string().nullable().optional(),
				wake_word_id: z.string().nullable().optional(),
				prefer_local_intents: z.boolean().optional(),
				make_preferred: z.boolean().optional().describe("Also make this the preferred assistant.")
			},
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
		},
		async (args) =>
			runTool(ctx.logger, "ha_set_assist_pipeline", async () => {
				const decision = evaluateConfigWrite(ctx.instances.currentSafety());
				if (!decision.allowed) {
					return errorResult(`Refused: ${decision.reason}`);
				}
				const listed = await ctx.rest.sendWsCommand<PipelineList>({ type: "assist_pipeline/pipeline/list" });
				const pipelines = Array.isArray(listed?.pipelines) ? listed.pipelines : [];
				const found = findPipeline(pipelines, args.pipeline);
				if (!found) {
					return errorResult(
						`No pipeline '${args.pipeline}'. There are: ${pipelines.map((p) => `${p.name} (${p.id})`).join(", ") || "none"}.`
					);
				}
				if (Array.isArray(found)) {
					return errorResult(
						`More than one pipeline is called '${args.pipeline}': ${found.map((p) => p.id).join(", ")}. Name it by id.`
					);
				}

				const changes: Record<string, unknown> = {};
				for (const key of SETTABLE) {
					if (args[key] !== undefined) changes[key] = args[key];
				}
				const changed = Object.keys(changes).filter(
					(key) => JSON.stringify(found[key] ?? null) !== JSON.stringify(changes[key])
				);
				if (changed.length === 0 && !args.make_preferred) {
					return jsonResult({ pipeline_id: found.id, changed: [], note: "Nothing to change." });
				}

				let updated: Pipeline = found;
				if (changed.length > 0) {
					updated = await ctx.rest.sendWsCommand<Pipeline>(mergePipelineUpdate(found, changes));
				}
				let preferred: boolean | undefined;
				if (args.make_preferred && listed?.preferred_pipeline !== found.id) {
					await ctx.rest.sendWsCommand({ type: "assist_pipeline/pipeline/set_preferred", pipeline_id: found.id });
					preferred = true;
				}
				return jsonResult({
					pipeline_id: found.id,
					changed,
					before: Object.fromEntries(changed.map((key) => [key, found[key] ?? null])),
					pipeline: updated ?? null,
					...(preferred ? { made_preferred: true } : {})
				});
			})
	);
}
