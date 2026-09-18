import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import type { HaRestClient } from "../src/ha/restClient.js";
import type { HaWsClient } from "../src/ha/wsClient.js";
import { createUnavailableEsphomeClient } from "../src/esphome/client.js";
import { createNodeRedClient } from "../src/nodered/client.js";
import { createVomeHomeClient, type VomeHomeClient } from "../src/vomehome/client.js";
import { createInstanceManager } from "../src/vomehome/instances.js";
import { registerAllTools } from "../src/tools/index.js";
import type { ToolContext } from "../src/tools/helpers.js";

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<CallToolResult>;

class FakeServer {
	readonly tools = new Map<string, Handler>();
	registerTool(name: string, _config: unknown, handler: Handler): void {
		this.tools.set(name, handler);
	}
	async call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
		const handler = this.tools.get(name);
		if (!handler) {
			throw new Error(`tool not registered: ${name}`);
		}
		return handler(args, {});
	}
}

function textOf(result: CallToolResult): string {
	const first = result.content[0];
	return first && first.type === "text" ? first.text : "";
}

function jsonOf(result: CallToolResult): any {
	return JSON.parse(textOf(result));
}

const logger = createLogger("error");

function buildHarness(
	options: {
		env?: Record<string, string>;
		rest?: Partial<HaRestClient>;
		ws?: Partial<HaWsClient>;
		vomehome?: Partial<VomeHomeClient>;
	} = {}
): FakeServer {
	const config = loadConfig({ HA_URL: "http://ha.local:8123", HA_TOKEN: "tok", ...options.env });
	const mockRest = (options.rest ?? {}) as unknown as HaRestClient;
	const instances = createInstanceManager(config, logger, mockRest);
	const ctx: ToolContext = {
		config,
		logger,
		rest: mockRest,
		ws: (options.ws ?? {}) as unknown as HaWsClient,
		esphome: createUnavailableEsphomeClient(),
		nodered: createNodeRedClient(config, logger),
		vomehome: (options.vomehome ?? createVomeHomeClient(config, logger)) as VomeHomeClient,
		instances
	};
	const server = new FakeServer();
	registerAllTools(server as unknown as McpServer, ctx);
	return server;
}

describe("ha_call_service safety", () => {
	it("refuses when writes are disabled", async () => {
		const callService = vi.fn();
		const server = buildHarness({ rest: { callService } });
		const result = await server.call("ha_call_service", {
			domain: "light",
			service: "turn_on",
			target: { entity_id: "light.k" }
		});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/HA_ALLOW_WRITE/);
		expect(callService).not.toHaveBeenCalled();
	});

	it("refuses a denied domain even with writes enabled", async () => {
		const callService = vi.fn();
		const server = buildHarness({ env: { HA_ALLOW_WRITE: "true" }, rest: { callService } });
		const result = await server.call("ha_call_service", {
			domain: "lock",
			service: "unlock",
			target: { entity_id: "lock.front" }
		});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/deny/i);
		expect(callService).not.toHaveBeenCalled();
	});

	it("blocks cross-domain bypass via homeassistant.turn_on targeting a lock", async () => {
		const callService = vi.fn();
		const server = buildHarness({ env: { HA_ALLOW_WRITE: "true" }, rest: { callService } });
		const result = await server.call("ha_call_service", {
			domain: "homeassistant",
			service: "turn_on",
			data: { entity_id: "lock.front" }
		});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/lock\.front/);
		expect(callService).not.toHaveBeenCalled();
	});

	it("blocks a denied entity_id nested deep inside data", async () => {
		const callService = vi.fn();
		const server = buildHarness({ env: { HA_ALLOW_WRITE: "true" }, rest: { callService } });
		const result = await server.call("ha_call_service", {
			domain: "homeassistant",
			service: "turn_on",
			data: { options: { extra: { entity_id: ["lock.front"] } } }
		});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/lock\.front/);
		expect(callService).not.toHaveBeenCalled();
	});

	it("blocks generic services targeting an area while a deny-list is active", async () => {
		const callService = vi.fn();
		const server = buildHarness({ env: { HA_ALLOW_WRITE: "true" }, rest: { callService } });
		const result = await server.call("ha_call_service", {
			domain: "homeassistant",
			service: "turn_off",
			target: { area_id: "bedroom" }
		});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/area\/device\/label/);
		expect(callService).not.toHaveBeenCalled();
	});

	it("allows a domain-specific service to target an area (domain already vetted)", async () => {
		const callService = vi.fn(async () => []);
		const server = buildHarness({ env: { HA_ALLOW_WRITE: "true" }, rest: { callService } });
		const result = await server.call("ha_call_service", {
			domain: "light",
			service: "turn_on",
			target: { area_id: "bedroom" }
		});
		expect(result.isError).toBeUndefined();
		expect(callService).toHaveBeenCalledOnce();
	});

	it("allows generic services to target an area when no deny/allow-list is active", async () => {
		const callService = vi.fn(async () => []);
		const server = buildHarness({
			env: { HA_ALLOW_WRITE: "true", HA_DENY_DOMAINS: "" },
			rest: { callService }
		});
		const result = await server.call("ha_call_service", {
			domain: "homeassistant",
			service: "turn_off",
			target: { area_id: "bedroom" }
		});
		expect(result.isError).toBeUndefined();
		expect(callService).toHaveBeenCalledOnce();
	});

	it("calls the service for an allowed domain when writes are enabled", async () => {
		const callService = vi.fn(async () => [{ entity_id: "light.k", state: "on", attributes: {} }]);
		const server = buildHarness({ env: { HA_ALLOW_WRITE: "true" }, rest: { callService } });
		const result = await server.call("ha_call_service", {
			domain: "light",
			service: "turn_on",
			target: { entity_id: "light.k" }
		});
		expect(result.isError).toBeUndefined();
		expect(callService).toHaveBeenCalledOnce();
		expect(jsonOf(result).changed_entities).toEqual([{ entity_id: "light.k", state: "on" }]);
	});
});

describe("ha_list_entities", () => {
	const states = [
		{ entity_id: "light.kitchen", state: "on", attributes: { friendly_name: "Kitchen" } },
		{ entity_id: "light.hall", state: "off", attributes: {} },
		{ entity_id: "sensor.temp", state: "21", attributes: { friendly_name: "Temp" } }
	];

	it("filters by domain", async () => {
		const server = buildHarness({ rest: { getStates: async () => states as any } });
		const result = await server.call("ha_list_entities", { domain: "light" });
		const payload = jsonOf(result);
		expect(payload.returned).toBe(2);
		expect(payload.entities.map((entity: any) => entity.entity_id)).toEqual([
			"light.kitchen",
			"light.hall"
		]);
	});

	it("filters by free-text search across id and friendly name", async () => {
		const server = buildHarness({ rest: { getStates: async () => states as any } });
		const result = await server.call("ha_list_entities", { search: "kitchen" });
		expect(jsonOf(result).returned).toBe(1);
	});
});

describe("ha_render_template", () => {
	it("returns the rendered text", async () => {
		const renderTemplate = vi.fn(async () => "true");
		const server = buildHarness({ rest: { renderTemplate } });
		const result = await server.call("ha_render_template", { template: "{{ true }}" });
		expect(result.isError).toBeUndefined();
		expect(textOf(result)).toBe("true");
		expect(renderTemplate).toHaveBeenCalledWith("{{ true }}", undefined);
	});
});

describe("esphome tools with no route to a home", () => {
	it("names the relay and the add-on rather than failing obscurely", async () => {
		// Every ESPHome tool fails the same way and says what to do about it,
		// instead of surfacing whatever connection error the first call hit.
		const server = buildHarness();
		const result = await server.call("esphome_list_devices");
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/VOMEHOME_TOKEN/);
		expect(textOf(result)).toMatch(/Vome add-on/);
	});
});

describe("ha_get_system_log", () => {
	const entries = [
		{
			name: "homeassistant.components.hue",
			message: ["Bridge unreachable"],
			level: "ERROR",
			source: ["components/hue/bridge.py", 210],
			timestamp: 1_700_000_200,
			first_occurred: 1_700_000_000,
			count: 42,
			exception: 'Traceback (most recent call last):\n  File "bridge.py", line 210\nValueError: no route to host\n'
		},
		{
			name: "homeassistant.components.mqtt",
			message: "Retrying connection",
			level: "WARNING",
			source: ["components/mqtt/client.py", 88],
			timestamp: 1_700_000_100,
			first_occurred: 1_700_000_100,
			count: 1
		},
		{
			name: "homeassistant.setup",
			message: "Setup of domain sun took 0.1 seconds",
			level: "INFO",
			source: ["setup.py", 400],
			timestamp: 1_700_000_050,
			count: 3
		}
	];
	const ws = { sendCommand: async () => entries as any };

	it("defaults to warning and above, newest first, with no full tracebacks", async () => {
		const server = buildHarness({ ws });
		const body = jsonOf(await server.call("ha_get_system_log"));
		expect(body.total_in_log).toBe(3);
		expect(body.matched).toBe(2);
		expect(body.entries.map((row: any) => row.logger)).toEqual([
			"homeassistant.components.hue",
			"homeassistant.components.mqtt"
		]);
		const hue = body.entries[0];
		expect(hue.count).toBe(42);
		expect(hue.source).toBe("components/hue/bridge.py:210");
		expect(hue.first_occurred).toBe("2023-11-14T22:13:20.000Z");
		// The useful last line survives; the stack itself does not.
		expect(hue.exception_summary).toBe("ValueError: no route to host");
		expect(hue.exception_lines).toBe(3);
		expect(hue.exception).toBeUndefined();
	});

	it("returns the full traceback when asked", async () => {
		const server = buildHarness({ ws });
		const body = jsonOf(await server.call("ha_get_system_log", { include_exception: true }));
		expect(body.entries[0].exception).toMatch(/Traceback/);
	});

	it("filters by min_level, logger and free text", async () => {
		const server = buildHarness({ ws });
		expect(jsonOf(await server.call("ha_get_system_log", { min_level: "info" })).matched).toBe(3);
		expect(jsonOf(await server.call("ha_get_system_log", { logger: "MQTT" })).matched).toBe(1);
		// 'contains' also searches the traceback text.
		const body = jsonOf(await server.call("ha_get_system_log", { contains: "no route to host" }));
		expect(body.matched).toBe(1);
		expect(body.entries[0].logger).toBe("homeassistant.components.hue");
	});

	it("truncates to the limit and says so", async () => {
		const server = buildHarness({ ws });
		const body = jsonOf(await server.call("ha_get_system_log", { limit: 1 }));
		expect(body.returned).toBe(1);
		expect(body.truncated).toBe(true);
	});
});

describe("ha_clear_system_log", () => {
	it("refuses when writes are disabled", async () => {
		const sendCommand = vi.fn();
		const server = buildHarness({ ws: { sendCommand } });
		const result = await server.call("ha_clear_system_log");
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/HA_ALLOW_WRITE/);
		expect(sendCommand).not.toHaveBeenCalled();
	});

	it("clears when writes are enabled", async () => {
		const sendCommand = vi.fn(async () => ({}));
		const server = buildHarness({ env: { HA_ALLOW_WRITE: "true" }, ws: { sendCommand } });
		const result = await server.call("ha_clear_system_log");
		expect(jsonOf(result).cleared).toBe(true);
		expect(sendCommand).toHaveBeenCalledWith({ type: "system_log/clear" });
	});
});

describe("ha_set_log_level", () => {
	it("refuses when writes are disabled", async () => {
		const callService = vi.fn();
		const server = buildHarness({ rest: { callService } });
		const result = await server.call("ha_set_log_level", { integration: "hue", level: "debug" });
		expect(result.isError).toBe(true);
		expect(callService).not.toHaveBeenCalled();
	});

	it("expands a bare integration name and leaves a logger path alone", async () => {
		const callService = vi.fn(async () => []);
		const server = buildHarness({ env: { HA_ALLOW_WRITE: "true" }, rest: { callService } });
		await server.call("ha_set_log_level", {
			integration: "hue",
			level: "debug",
			levels: { "custom_components.vomesync": "info" }
		});
		expect(callService).toHaveBeenCalledWith("logger", "set_level", {
			"homeassistant.components.hue": "debug",
			"custom_components.vomesync": "info"
		});
	});

	it("rejects a half-specified pair", async () => {
		const callService = vi.fn();
		const server = buildHarness({ env: { HA_ALLOW_WRITE: "true" }, rest: { callService } });
		const result = await server.call("ha_set_log_level", { integration: "hue" });
		expect(result.isError).toBe(true);
		expect(callService).not.toHaveBeenCalled();
	});
});

describe("ha_get_supervisor_log", () => {
	it("reads the add-on log over the allow-listed hassio path and tails it", async () => {
		const request = vi.fn(async () => ["a", "b", "c", "d"].join("\n"));
		const server = buildHarness({ rest: { request } });
		const result = await server.call("ha_get_supervisor_log", {
			target: "addon",
			addon_slug: "core_mosquitto",
			tail_lines: 2
		});
		expect(request).toHaveBeenCalledWith("/api/hassio/addons/core_mosquitto/logs", {
			expect: "text"
		});
		expect(textOf(result)).toBe("c\nd");
	});

	it("defaults to the core log", async () => {
		const request = vi.fn(async () => "core line");
		const server = buildHarness({ rest: { request } });
		await server.call("ha_get_supervisor_log");
		expect(request).toHaveBeenCalledWith("/api/hassio/core/logs", { expect: "text" });
	});

	it("requires addon_slug for target=addon", async () => {
		const request = vi.fn();
		const server = buildHarness({ rest: { request } });
		const result = await server.call("ha_get_supervisor_log", { target: "addon" });
		expect(result.isError).toBe(true);
		expect(request).not.toHaveBeenCalled();
	});
});

describe("automation traces", () => {
	const automationStates = [
		{ entity_id: "automation.morning", state: "on", attributes: { id: "1699999999999" } }
	];
	const traceList = [
		{
			run_id: "older",
			domain: "automation",
			item_id: "1699999999999",
			timestamp: { start: "2026-08-01T06:00:00.000Z", finish: "2026-08-01T06:00:00.100Z" },
			state: "stopped",
			script_execution: "finished",
			last_step: "action/1"
		},
		{
			run_id: "latest",
			domain: "automation",
			item_id: "1699999999999",
			timestamp: { start: "2026-08-02T06:00:00.000Z", finish: "2026-08-02T06:00:00.050Z" },
			state: "stopped",
			script_execution: "failed_condition",
			last_step: "condition/0"
		}
	];
	const traceDetail = {
		run_id: "latest",
		domain: "automation",
		item_id: "1699999999999",
		timestamp: { start: "2026-08-02T06:00:00.000Z", finish: "2026-08-02T06:00:00.050Z" },
		state: "stopped",
		script_execution: "failed_condition",
		last_step: "condition/0",
		config: { alias: "Morning", trigger: [], condition: [], action: [] },
		trace: {
			"trigger/0": [
				{
					path: "trigger/0",
					timestamp: "2026-08-02T06:00:00.000Z",
					changed_variables: {
						trigger: {
							platform: "state",
							entity_id: "binary_sensor.motion",
							description: "state of binary_sensor.motion"
						}
					}
				}
			],
			"condition/0": [
				{
					path: "condition/0",
					timestamp: "2026-08-02T06:00:00.040Z",
					result: { result: false }
				}
			]
		}
	};

	function traceHarness(calls: Array<Record<string, unknown>> = []) {
		return buildHarness({
			rest: { getStates: async () => automationStates as any },
			ws: {
				sendCommand: async (command: any) => {
					calls.push(command);
					if (command.type === "trace/list") return traceList as any;
					if (command.type === "trace/get") return traceDetail as any;
					throw new Error(`unexpected command ${command.type}`);
				}
			}
		});
	}

	it("lists runs newest first, resolving an entity_id to the unique id", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const server = traceHarness(calls);
		const body = jsonOf(await server.call("ha_list_traces", { item: "automation.morning" }));
		expect(calls[0]).toEqual({
			type: "trace/list",
			domain: "automation",
			item_id: "1699999999999"
		});
		expect(body.traces.map((row: any) => row.run_id)).toEqual(["latest", "older"]);
	});

	it("errors clearly when the reference has no unique id", async () => {
		const server = traceHarness();
		const result = await server.call("ha_list_traces", { item: "automation.unknown" });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/ha_list_automations/);
	});

	it("defaults to the latest run and names the step that blocked it", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const server = traceHarness(calls);
		const body = jsonOf(await server.call("ha_get_trace", { item: "automation.morning" }));
		expect(calls[1]).toMatchObject({ type: "trace/get", run_id: "latest" });
		expect(body.script_execution).toBe("failed_condition");
		expect(body.failed_at).toMatchObject({
			path: "condition/0",
			reason: "condition evaluated false"
		});
		expect(body.trigger).toMatchObject({ entity_id: "binary_sensor.motion" });
		expect(body.steps.map((step: any) => step.path)).toEqual(["trigger/0", "condition/0"]);
		// Summarised: no config, and no per-step variables unless asked.
		expect(body.config).toBeUndefined();
		expect(body.steps[0].changed_variables).toBeUndefined();
	});

	it("skips the list lookup when a run_id is given", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const server = traceHarness(calls);
		await server.call("ha_get_trace", { item: "1699999999999", run_id: "older" });
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ type: "trace/get", run_id: "older" });
	});

	it("returns the raw trace with full=true", async () => {
		const server = traceHarness();
		const body = jsonOf(
			await server.call("ha_get_trace", { item: "automation.morning", full: true })
		);
		expect(body.config.alias).toBe("Morning");
	});

	it("includes changed variables on request", async () => {
		const server = traceHarness();
		const body = jsonOf(
			await server.call("ha_get_trace", { item: "automation.morning", include_variables: true })
		);
		expect(body.steps[0].changed_variables).toMatch(/binary_sensor\.motion/);
	});
});

describe("helper entities", () => {
	const WRITE = { HA_ALLOW_WRITE: "true", HA_ALLOW_CONFIG_WRITE: "true" };

	it("creates a helper over the websocket, with no id", async () => {
		// The point of these tools: adding a helper without configuration.yaml,
		// which nothing here can reach and which would need a restart anyway.
		const sendCommand = vi.fn(async () => ({ id: "1a2b", name: "Holiday mode" }));
		const server = buildHarness({ env: WRITE, ws: { sendCommand } });

		const body = jsonOf(
			await server.call("ha_set_helper", {
				kind: "input_boolean",
				config: { name: "Holiday mode", icon: "mdi:palm-tree" }
			})
		);

		expect(body.created).toBe(true);
		expect(sendCommand).toHaveBeenCalledWith({
			type: "input_boolean/create",
			name: "Holiday mode",
			icon: "mdi:palm-tree"
		});
	});

	it("updates when given an id, keying it as <kind>_id", async () => {
		const sendCommand = vi.fn(async () => ({ id: "1a2b" }));
		const server = buildHarness({ env: WRITE, ws: { sendCommand } });

		const body = jsonOf(
			await server.call("ha_set_helper", {
				kind: "input_number",
				helper_id: "1a2b",
				config: { name: "Target temp", min: 5, max: 30 }
			})
		);

		expect(body.created).toBe(false);
		expect(sendCommand).toHaveBeenCalledWith({
			type: "input_number/update",
			input_number_id: "1a2b",
			name: "Target temp",
			min: 5,
			max: 30
		});
	});

	it("refuses to create or delete without config-write", async () => {
		const sendCommand = vi.fn(async () => []);
		const server = buildHarness({ ws: { sendCommand } });

		for (const [tool, args] of [
			["ha_set_helper", { kind: "counter", config: { name: "Feeds" } }],
			["ha_delete_helper", { kind: "counter", helper_id: "x" }]
		] as const) {
			const result = await server.call(tool, args);
			expect(result.isError).toBe(true);
		}
		expect(sendCommand).not.toHaveBeenCalled();
	});

	/**
	 * Deleting a stored helper whose id matches a configuration.yaml helper's
	 * key removes the YAML entity's registry slot as well, because Home
	 * Assistant deletes by (domain, platform, item_id) and both collections
	 * register under the same domain and platform. A reload does not recover
	 * it — only a full restart does. Reported from the field after exactly
	 * that happened, against a tool whose description promised it could not.
	 */
	function helperWs(options: {
		stored?: StoredRow[];
		registry?: Record<string, unknown>[];
		onDelete?: () => void;
	}) {
		const sendCommand = vi.fn(async (command: any) => {
			if (command.type.endsWith("/list")) {
				return options.stored ?? [];
			}
			if (command.type.endsWith("/delete")) {
				options.onDelete?.();
				return {};
			}
			return {};
		});
		const listEntities = vi.fn(async () => options.registry ?? []);
		return { sendCommand, listEntities };
	}

	type StoredRow = { id: string; name: string };

	it("deletes by id", async () => {
		const ws = helperWs({
			stored: [{ id: "t1", name: "Kettle" }],
			registry: [
				{ entity_id: "timer.kettle", platform: "timer", unique_id: "t1", original_name: "Kettle" }
			]
		});
		const server = buildHarness({ env: WRITE, ws });

		const body = jsonOf(
			await server.call("ha_delete_helper", { kind: "timer", helper_id: "t1" })
		);

		expect(body.deleted).toBe(true);
		expect(body.removed_entity).toBe("timer.kettle");
		expect(body.shared_id_check).toBe("passed");
		expect(ws.sendCommand).toHaveBeenCalledWith({ type: "timer/delete", timer_id: "t1" });
	});

	it("refuses an id that is not a stored helper, rather than guessing", async () => {
		// The old description said configuration.yaml helpers "cannot be deleted
		// this way". Nothing enforced it; now something does.
		const ws = helperWs({ stored: [{ id: "other", name: "Other" }] });
		const server = buildHarness({ env: WRITE, ws });

		const result = await server.call("ha_delete_helper", {
			kind: "input_boolean",
			helper_id: "holiday_mode"
		});

		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/configuration\.yaml/);
		expect(ws.sendCommand).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "input_boolean/delete" })
		);
	});

	it("refuses when the id's entity belongs to a differently-named helper", async () => {
		// The collision: the stored row is a phantom, and the registry slot for
		// its id is held by the YAML helper that won it at startup.
		let deleted = false;
		const ws = helperWs({
			stored: [{ id: "holiday_mode", name: "Holiday mode" }],
			registry: [
				{
					entity_id: "input_boolean.holiday_mode",
					platform: "input_boolean",
					unique_id: "holiday_mode",
					original_name: "Away for the week"
				}
			],
			onDelete: () => {
				deleted = true;
			}
		});
		const server = buildHarness({ env: WRITE, ws });

		const result = await server.call("ha_delete_helper", {
			kind: "input_boolean",
			helper_id: "holiday_mode"
		});

		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/restart/);
		expect(deleted).toBe(false);
	});

	it("goes ahead on the shared id when told to explicitly", async () => {
		const ws = helperWs({
			stored: [{ id: "holiday_mode", name: "Holiday mode" }],
			registry: [
				{
					entity_id: "input_boolean.holiday_mode",
					platform: "input_boolean",
					unique_id: "holiday_mode",
					original_name: "Away for the week"
				}
			]
		});
		const server = buildHarness({ env: WRITE, ws });

		const body = jsonOf(
			await server.call("ha_delete_helper", {
				kind: "input_boolean",
				helper_id: "holiday_mode",
				confirm_shared_id: true
			})
		);

		expect(body.deleted).toBe(true);
		expect(body.shared_id_check).toBe("overridden");
	});

	it("says the check did not run rather than implying it passed", async () => {
		// A registry that returns no unique ids cannot answer the question. The
		// failure mode to avoid is a silent all-clear.
		const ws = helperWs({
			stored: [{ id: "t1", name: "Kettle" }],
			registry: [{ entity_id: "timer.kettle", platform: "timer" }]
		});
		const server = buildHarness({ env: WRITE, ws });

		const body = jsonOf(
			await server.call("ha_delete_helper", { kind: "timer", helper_id: "t1" })
		);

		expect(body.deleted).toBe(true);
		expect(body.shared_id_check).toBe("not run");
		expect(body.note).toMatch(/restart/);
	});

	it("lists one kind, or every kind at once", async () => {
		const sendCommand = vi.fn(async (c: any) => [{ id: "x", type: c.type }]);
		const server = buildHarness({ ws: { sendCommand } });

		const one = jsonOf(await server.call("ha_list_helpers", { kind: "input_select" }));
		expect(one[0].type).toBe("input_select/list");

		sendCommand.mockClear();
		const all = jsonOf(await server.call("ha_list_helpers"));
		expect(Object.keys(all)).toContain("schedule");
		expect(sendCommand.mock.calls.length).toBe(9);
	});

	it("reports one unavailable domain without losing the others", async () => {
		// A component that is not loaded answers unknown_command; that must not
		// hide the eight that did answer.
		const sendCommand = vi.fn(async (c: any) => {
			if (c.type.startsWith("schedule/")) throw new Error("unknown_command");
			return [];
		});
		const server = buildHarness({ ws: { sendCommand } });

		const all = jsonOf(await server.call("ha_list_helpers"));

		expect(all.schedule.error).toMatch(/unknown_command/);
		expect(all.input_boolean).toEqual([]);
	});
});

describe("config files", () => {
	it("says it needs a relay rather than failing obscurely in direct mode", async () => {
		// Files are served by the Vome component on the home; a direct HA
		// connection has no route to them at all.
		const server = buildHarness({
			env: { HA_ALLOW_WRITE: "true", HA_ALLOW_CONFIG_WRITE: "true" }
		});
		for (const [tool, args] of [
			["ha_list_config_files", {}],
			["ha_read_config_file", { path: "configuration.yaml" }],
			["ha_write_config_file", { instance_id: "direct", path: "configuration.yaml", content: "x" }]
		] as const) {
			const result = await server.call(tool, args);
			expect(result.isError).toBe(true);
			expect(textOf(result)).toMatch(/relay-connected|Vome component/);
		}
	});

	it("refuses to write without config-write, before reaching the network", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const server = buildHarness();
		const result = await server.call("ha_write_config_file", {
			instance_id: "direct",
			path: "configuration.yaml",
			content: "x"
		});
		expect(result.isError).toBe(true);
		expect(fetchMock).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});
});

describe("ha_write_config_file names its target", () => {
	const BROKERED = {
		HA_TOKEN: "",
		VOMEHOME_TOKEN: "vh_test",
		VOMEHOME_INSTANCE_ID: "rly-1",
		HA_ALLOW_WRITE: "true",
		HA_ALLOW_CONFIG_WRITE: "true"
	};

	it("refuses, without writing, when the named home is not the one selected", async () => {
		/**
		 * The 2026-09-18 incident, as a test.
		 *
		 * The active instance is ambient session state and it drifts: a
		 * transport reconnect can resume a different conversation's choice,
		 * because the memory is keyed only as far as the client's name. An
		 * agent had selected the demo VM, checked that it was selected, and its
		 * writes landed on a customer's real Home Assistant — 5 KB of their
		 * configuration.yaml replaced by 790 bytes of Vome boilerplate, two
		 * restarts, and nothing in the write path said a word.
		 *
		 * Naming the target turns that silent mis-delivery into a refusal. The
		 * network must not be touched at all.
		 */
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const server = buildHarness({ env: BROKERED });

		const result = await server.call("ha_write_config_file", {
			instance_id: "the-demo-vm",
			path: "configuration.yaml",
			content: "homeassistant:\n  name: VomeHome\n"
		});

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("rly-1");
		expect(textOf(result)).toContain("the-demo-vm");
		expect(fetchMock).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});

	it("writes when the named home is the one selected", async () => {
		const fetchMock = vi.fn(async (input: unknown) => {
			const url = String(input);
			if (url.includes("/files/read")) {
				return new Response("not found", { status: 404 });
			}
			return new Response(JSON.stringify({ path: "packages/x.yaml", written: true }), {
				status: 200
			});
		});
		vi.stubGlobal("fetch", fetchMock);
		const server = buildHarness({ env: BROKERED });

		const result = await server.call("ha_write_config_file", {
			instance_id: "rly-1",
			path: "packages/x.yaml",
			content: "x\n",
			verify: false
		});

		expect(result.isError).toBeFalsy();
		expect(fetchMock).toHaveBeenCalled();
		vi.unstubAllGlobals();
	});
});

describe("ha_write_config_file verification", () => {
	const BROKERED = {
		HA_TOKEN: "",
		VOMEHOME_TOKEN: "vh_test",
		VOMEHOME_INSTANCE_ID: "rly-1",
		HA_ALLOW_WRITE: "true",
		HA_ALLOW_CONFIG_WRITE: "true"
	};

	/** Routes the file endpoints; records every write body in order. */
	function stubFiles(options: { existing?: string | null } = {}) {
		const writes: string[] = [];
		const fetchMock = vi.fn(async (input: unknown, init: any) => {
			const url = String(input);
			if (url.includes("/files/read")) {
				if (options.existing === null || options.existing === undefined) {
					return new Response("not found", { status: 404 });
				}
				return new Response(JSON.stringify({ content: options.existing }), { status: 200 });
			}
			writes.push(JSON.parse(init.body).content);
			return new Response(JSON.stringify({ path: "configuration.yaml", written: true }), {
				status: 200
			});
		});
		vi.stubGlobal("fetch", fetchMock);
		return writes;
	}

	afterEach(() => vi.unstubAllGlobals());

	it("keeps the write when the configuration still checks out", async () => {
		const writes = stubFiles({ existing: "old:\n" });
		const checkConfig = vi.fn(async () => ({ result: "valid", errors: null }));
		const server = buildHarness({ env: BROKERED, rest: { checkConfig } });

		const body = jsonOf(
			await server.call("ha_write_config_file", {
				instance_id: "rly-1",
				path: "configuration.yaml",
				content: "new:\n"
			})
		);

		expect(body.verified).toBe(true);
		expect(body.rolled_back).toBeUndefined();
		expect(writes).toEqual(["new:\n"]);
	});

	it("puts the file back when the change breaks the configuration", async () => {
		// The point of the whole feature: a bad edit must not be able to leave
		// Home Assistant unable to start.
		const writes = stubFiles({ existing: "good:\n" });
		const checkConfig = vi
			.fn()
			.mockResolvedValueOnce({ result: "invalid", errors: "bad indentation at line 3" })
			.mockResolvedValueOnce({ result: "valid", errors: null });
		const server = buildHarness({ env: BROKERED, rest: { checkConfig } });

		const body = jsonOf(
			await server.call("ha_write_config_file", {
				instance_id: "rly-1",
				path: "configuration.yaml",
				content: "broken\n"
			})
		);

		expect(body.rolled_back).toBe(true);
		expect(body.errors).toMatch(/bad indentation/);
		expect(body.already_invalid_before_this_edit).toBe(false);
		// Wrote the new content, then wrote the original back.
		expect(writes).toEqual(["broken\n", "good:\n"]);
	});

	it("says so when the configuration was already failing before the edit", async () => {
		// Otherwise an agent fixing a pre-existing fault gets blamed for it and
		// goes hunting for a mistake it did not make.
		stubFiles({ existing: "already-broken\n" });
		const checkConfig = vi.fn(async () => ({ result: "invalid", errors: "missing key" }));
		const server = buildHarness({ env: BROKERED, rest: { checkConfig } });

		const body = jsonOf(
			await server.call("ha_write_config_file", {
				instance_id: "rly-1",
				path: "configuration.yaml",
				content: "half-a-fix\n"
			})
		);

		expect(body.rolled_back).toBe(true);
		expect(body.already_invalid_before_this_edit).toBe(true);
		expect(body.note).toMatch(/verify=false/);
	});

	it("leaves a brand-new file in place, since there is nothing to restore", async () => {
		const writes = stubFiles({ existing: null });
		const checkConfig = vi.fn(async () => ({ result: "invalid", errors: "boom" }));
		const server = buildHarness({ env: BROKERED, rest: { checkConfig } });

		const body = jsonOf(
			await server.call("ha_write_config_file", { instance_id: "rly-1", path: "packages/new.yaml", content: "x\n" })
		);

		expect(body.rolled_back).toBe(false);
		expect(body.note).toMatch(/nothing to restore/);
		expect(writes).toEqual(["x\n"]);
	});

	it("skips the check entirely with verify=false", async () => {
		// For a set of files that are only valid together.
		const writes = stubFiles({ existing: "old\n" });
		const checkConfig = vi.fn();
		const server = buildHarness({ env: BROKERED, rest: { checkConfig } });

		const body = jsonOf(
			await server.call("ha_write_config_file", {
				instance_id: "rly-1",
				path: "packages/a.yaml",
				content: "a\n",
				verify: false
			})
		);

		expect(body.verified).toBe(false);
		expect(checkConfig).not.toHaveBeenCalled();
		expect(writes).toEqual(["a\n"]);
	});
});

describe("binary config files", () => {
	const BROKERED = {
		HA_TOKEN: "",
		VOMEHOME_TOKEN: "vh_test",
		VOMEHOME_INSTANCE_ID: "rly-1",
		HA_ALLOW_WRITE: "true",
		HA_ALLOW_CONFIG_WRITE: "true"
	};

	afterEach(() => vi.unstubAllGlobals());

	it("reads a file as base64 and returns it as structured JSON, not raw text", async () => {
		const fetchMock = vi.fn(async (input: unknown) => {
			expect(String(input)).toMatch(/encoding=base64/);
			return new Response(
				JSON.stringify({ path: "assets/pack.bin", content: "AAECAw==", encoding: "base64" }),
				{ status: 200 }
			);
		});
		vi.stubGlobal("fetch", fetchMock);
		const server = buildHarness({ env: BROKERED });

		const body = jsonOf(
			await server.call("ha_read_config_file", { path: "assets/pack.bin", encoding: "base64" })
		);
		expect(body).toEqual({ path: "assets/pack.bin", encoding: "base64", content: "AAECAw==" });
	});

	it("defaults to utf8 and returns plain text, unaffected by the encoding param", async () => {
		const fetchMock = vi.fn(async () =>
			new Response(JSON.stringify({ content: "homeassistant:\n" }), { status: 200 })
		);
		vi.stubGlobal("fetch", fetchMock);
		const server = buildHarness({ env: BROKERED });

		const result = await server.call("ha_read_config_file", { path: "configuration.yaml" });
		expect(textOf(result)).toBe("homeassistant:\n");
	});

	it("writes base64 content, sends the encoding to the broker, and skips check_config by default", async () => {
		const checkConfig = vi.fn();
		const writeBodies: Array<{ content: string; encoding?: string }> = [];
		const fetchMock = vi.fn(async (input: unknown, init: any) => {
			const url = String(input);
			if (url.includes("/files/write")) {
				writeBodies.push(JSON.parse(init.body));
				return new Response(JSON.stringify({ path: "assets/pack.bin", written: true, bytes: 4 }), {
					status: 200
				});
			}
			throw new Error(`unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		const server = buildHarness({ env: BROKERED, rest: { checkConfig } });

		const body = jsonOf(
			await server.call("ha_write_config_file", {
				instance_id: "rly-1",
				path: "assets/pack.bin",
				content: "AAECAw==",
				encoding: "base64"
			})
		);

		expect(writeBodies).toEqual([{ content: "AAECAw==", encoding: "base64" }]);
		// check_config only validates YAML, so it has nothing to say about a
		// binary write — verify defaults off for base64 rather than running a
		// pointless (and possibly misleading) check.
		expect(checkConfig).not.toHaveBeenCalled();
		expect(body.verified).toBe(false);
	});

	it("still verifies a base64 write when verify is explicitly requested", async () => {
		const checkConfig = vi.fn(async () => ({ result: "valid", errors: null }));
		const fetchMock = vi.fn(async (input: unknown, init: any) => {
			const url = String(input);
			if (url.includes("/files/read")) {
				return new Response("not found", { status: 404 });
			}
			expect(JSON.parse(init.body)).toEqual({ content: "AAECAw==", encoding: "base64" });
			return new Response(JSON.stringify({ path: "assets/pack.bin", written: true }), { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);
		const server = buildHarness({ env: BROKERED, rest: { checkConfig } });

		const body = jsonOf(
			await server.call("ha_write_config_file", {
				instance_id: "rly-1",
				path: "assets/pack.bin",
				content: "AAECAw==",
				encoding: "base64",
				verify: true
			})
		);

		expect(checkConfig).toHaveBeenCalled();
		expect(body.verified).toBe(true);
	});
});

describe("hacs", () => {
	const WRITE = { HA_ALLOW_WRITE: "true", HA_ALLOW_CONFIG_WRITE: "true" };

	afterEach(() => vi.useRealTimers());

	it("gets HACS status over the websocket", async () => {
		const sendCommand = vi.fn(async () => ({ version: "2.1.0", stage: "running" }));
		const server = buildHarness({ ws: { sendCommand } });

		const body = jsonOf(await server.call("ha_hacs_info", {}));
		expect(body.version).toBe("2.1.0");
		expect(sendCommand).toHaveBeenCalledWith({ type: "hacs/info" });
	});

	it("lists repositories, optionally filtered by category", async () => {
		const sendCommand = vi.fn(async () => [{ id: "1", full_name: "me/repo", category: "integration" }]);
		const server = buildHarness({ ws: { sendCommand } });

		const body = jsonOf(await server.call("ha_hacs_list_repositories", { categories: ["integration"] }));
		expect(body.count).toBe(1);
		expect(sendCommand).toHaveBeenCalledWith({
			type: "hacs/repositories/list",
			categories: ["integration"]
		});
	});

	it("refuses to add, download or remove without config-write, before reaching the network", async () => {
		const sendCommand = vi.fn();
		const server = buildHarness({ ws: { sendCommand } });

		for (const [tool, args] of [
			["ha_hacs_add_repository", { repository: "me/repo", category: "integration" }],
			["ha_hacs_download_repository", { repository: "me/repo" }],
			["ha_hacs_remove_repository", { repository: "me/repo" }]
		] as const) {
			const result = await server.call(tool, args);
			expect(result.isError).toBe(true);
		}
		expect(sendCommand).not.toHaveBeenCalled();
	});

	it("confirms a repository add by re-listing, since HACS acks even a failed add", async () => {
		vi.useFakeTimers();
		const added: Array<Record<string, unknown>> = [];
		const sendCommand = vi.fn(async (command: Record<string, unknown>) => {
			if (command.type === "hacs/repositories/add") {
				added.push(command);
				return {};
			}
			// hacs/repositories/list: empty until the add has actually happened.
			return added.length > 0
				? [{ id: "123", full_name: "me/repo", category: "integration", installed: false }]
				: [];
		});
		const server = buildHarness({ env: WRITE, ws: { sendCommand } });

		const pending = server.call("ha_hacs_add_repository", {
			repository: "me/repo",
			category: "integration"
		});
		await vi.runAllTimersAsync();
		const body = jsonOf(await pending);

		expect(added).toEqual([{ type: "hacs/repositories/add", repository: "me/repo", category: "integration" }]);
		expect(body.added).toBe(true);
		expect(body.repository.id).toBe("123");
	});

	it("reports a repository already tracked without adding it again", async () => {
		const sendCommand = vi.fn(async (command: Record<string, unknown>) => {
			expect(command.type).toBe("hacs/repositories/list");
			return [{ id: "123", full_name: "me/repo", category: "integration", installed: true }];
		});
		const server = buildHarness({ env: WRITE, ws: { sendCommand } });

		const body = jsonOf(
			await server.call("ha_hacs_add_repository", { repository: "me/repo", category: "integration" })
		);
		expect(body.added).toBe(false);
		expect(body.already_tracked).toBe(true);
	});

	it("reports failure when HACS silently drops the add", async () => {
		vi.useFakeTimers();
		const sendCommand = vi.fn(async (command: Record<string, unknown>) =>
			command.type === "hacs/repositories/list" ? [] : {}
		);
		const server = buildHarness({ env: WRITE, ws: { sendCommand } });

		const pending = server.call("ha_hacs_add_repository", {
			repository: "me/repo",
			category: "integration"
		});
		await vi.runAllTimersAsync();
		const result = await pending;

		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/did not accept/);
	});

	it("downloads (installs) a repository resolved by full_name to its id", async () => {
		const sendCommand = vi.fn(async (command: Record<string, unknown>) => {
			if (command.type === "hacs/repositories/list") {
				return [{ id: "123", full_name: "me/repo", category: "integration", installed: true }];
			}
			expect(command).toEqual({ type: "hacs/repository/download", repository: "123" });
			return {};
		});
		const server = buildHarness({ env: WRITE, ws: { sendCommand } });

		const body = jsonOf(await server.call("ha_hacs_download_repository", { repository: "me/repo" }));
		expect(body.installed).toBe(true);
		expect(body.repository.id).toBe("123");
	});

	it("errors clearly when the repository to download isn't tracked", async () => {
		const sendCommand = vi.fn(async () => []);
		const server = buildHarness({ env: WRITE, ws: { sendCommand } });

		const result = await server.call("ha_hacs_download_repository", { repository: "me/missing" });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/No HACS repository matches/);
	});

	it("uninstalls before untracking a repository that is installed", async () => {
		const seen: string[] = [];
		const sendCommand = vi.fn(async (command: Record<string, unknown>) => {
			if (command.type === "hacs/repositories/list") {
				return [{ id: "123", full_name: "me/repo", category: "integration", installed: true }];
			}
			seen.push(command.type as string);
			return {};
		});
		const server = buildHarness({ env: WRITE, ws: { sendCommand } });

		const body = jsonOf(await server.call("ha_hacs_remove_repository", { repository: "123" }));
		expect(seen).toEqual(["hacs/repository/remove", "hacs/repositories/remove"]);
		expect(body.removed).toBe(true);
	});

	it("only untracks a repository that was never installed", async () => {
		const seen: string[] = [];
		const sendCommand = vi.fn(async (command: Record<string, unknown>) => {
			if (command.type === "hacs/repositories/list") {
				return [{ id: "123", full_name: "me/repo", category: "integration", installed: false }];
			}
			seen.push(command.type as string);
			return {};
		});
		const server = buildHarness({ env: WRITE, ws: { sendCommand } });

		await server.call("ha_hacs_remove_repository", { repository: "123" });
		expect(seen).toEqual(["hacs/repositories/remove"]);
	});
});

describe("users", () => {
	const WRITE = { HA_ALLOW_WRITE: "true", HA_ALLOW_CONFIG_WRITE: "true" };

	it("lists users over the websocket", async () => {
		const sendCommand = vi.fn(async () => [
			{ id: "u1", name: "Alice", is_owner: true, is_active: true, group_ids: ["system-admin"] }
		]);
		const server = buildHarness({ ws: { sendCommand } });

		const body = jsonOf(await server.call("ha_list_users", {}));
		expect(body.count).toBe(1);
		expect(sendCommand).toHaveBeenCalledWith({ type: "config/auth/list" });
	});

	it("refuses every mutating tool without config-write, before reaching the network", async () => {
		const sendCommand = vi.fn();
		const server = buildHarness({ ws: { sendCommand } });

		for (const [tool, args] of [
			["ha_create_user", { name: "Bob", role: "user" }],
			["ha_update_user", { user_id: "u1", name: "Bobby" }],
			["ha_delete_user", { user_id: "u1" }],
			["ha_set_user_credentials", { user_id: "u1", username: "bob", password: "x" }],
			["ha_change_user_password", { user_id: "u1", password: "x" }],
			["ha_remove_user_credentials", { username: "bob" }]
		] as const) {
			const result = await server.call(tool, args);
			expect(result.isError).toBe(true);
		}
		expect(sendCommand).not.toHaveBeenCalled();
	});

	it("creates a user with a role mapped to the real HA group id", async () => {
		const sendCommand = vi.fn(async () => ({
			user: { id: "u2", name: "Bob", is_owner: false, is_active: true, group_ids: ["system-users"] }
		}));
		const server = buildHarness({ env: WRITE, ws: { sendCommand } });

		const body = jsonOf(await server.call("ha_create_user", { name: "Bob", role: "user" }));
		expect(sendCommand).toHaveBeenCalledWith({
			type: "config/auth/create",
			name: "Bob",
			group_ids: ["system-users"]
		});
		expect(body.created).toBe(true);
		expect(body.user.id).toBe("u2");
		expect(body.next).toMatch(/ha_set_user_credentials/);
	});

	it("updates only the fields given, mapping role to group_ids", async () => {
		const sendCommand = vi.fn(async () => ({
			user: { id: "u1", name: "Alice", is_owner: false, is_active: false, group_ids: ["system-read-only"] }
		}));
		const server = buildHarness({ env: WRITE, ws: { sendCommand } });

		await server.call("ha_update_user", { user_id: "u1", role: "read_only", is_active: false });
		expect(sendCommand).toHaveBeenCalledWith({
			type: "config/auth/update",
			user_id: "u1",
			group_ids: ["system-read-only"],
			is_active: false
		});
	});

	it("deletes a user", async () => {
		const sendCommand = vi.fn(async () => ({}));
		const server = buildHarness({ env: WRITE, ws: { sendCommand } });

		const body = jsonOf(await server.call("ha_delete_user", { user_id: "u1" }));
		expect(sendCommand).toHaveBeenCalledWith({ type: "config/auth/delete", user_id: "u1" });
		expect(body.deleted).toBe(true);
	});

	it("sets credentials for a user with no login yet", async () => {
		const sendCommand = vi.fn(async () => ({}));
		const server = buildHarness({ env: WRITE, ws: { sendCommand } });

		const body = jsonOf(
			await server.call("ha_set_user_credentials", { user_id: "u1", username: "bob", password: "hunter2" })
		);
		expect(sendCommand).toHaveBeenCalledWith({
			type: "config/auth_provider/homeassistant/create",
			user_id: "u1",
			username: "bob",
			password: "hunter2"
		});
		expect(body.created).toBe(true);
	});

	it("changes an existing user's password via admin_change_password", async () => {
		const sendCommand = vi.fn(async () => ({}));
		const server = buildHarness({ env: WRITE, ws: { sendCommand } });

		await server.call("ha_change_user_password", { user_id: "u1", password: "newpass" });
		expect(sendCommand).toHaveBeenCalledWith({
			type: "config/auth_provider/homeassistant/admin_change_password",
			user_id: "u1",
			password: "newpass"
		});
	});

	it("removes a login without deleting the user", async () => {
		const sendCommand = vi.fn(async () => ({}));
		const server = buildHarness({ env: WRITE, ws: { sendCommand } });

		const body = jsonOf(await server.call("ha_remove_user_credentials", { username: "bob" }));
		expect(sendCommand).toHaveBeenCalledWith({
			type: "config/auth_provider/homeassistant/delete",
			username: "bob"
		});
		expect(body.removed).toBe(true);
	});
});
