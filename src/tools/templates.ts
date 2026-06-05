import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { textResult, runTool, type ToolContext } from "./helpers.js";

export function registerTemplateTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"ha_render_template",
		{
			title: "Render a Jinja template",
			description:
				"Render a Home Assistant Jinja2 template against live state and return the result. Ideal for iterating on template sensors, automation conditions and value_templates until they produce the expected output. Example: \"{{ states('sensor.outside_temp') | float < 5 }}\".",
			inputSchema: {
				template: z.string().describe("The Jinja2 template to render."),
				variables: z
					.record(z.string(), z.unknown())
					.optional()
					.describe("Optional variables made available to the template.")
			},
			annotations: { readOnlyHint: true, openWorldHint: true }
		},
		async ({ template, variables }) =>
			runTool(ctx.logger, "ha_render_template", async () => {
				const rendered = await ctx.rest.renderTemplate(template, variables);
				return textResult(rendered);
			})
	);
}
