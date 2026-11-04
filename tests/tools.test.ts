import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { HaApiError, HaRestartingError, type HaRestClient } from "../src/ha/restClient.js";
import { commandTimeoutMs, type HaWsClient } from "../src/ha/wsClient.js";
import { REDACTED, SLOW_SUPERVISOR_TIMEOUT_SECONDS, defaultSupervisorTimeout, supervisorLogTarget } from "../src/tools/addons.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logbookChunks } from "../src/tools/logs.js";
import { MAX_UPLOAD_BYTES, encodeForUpload, imageTypeFor, resolveLocalPath } from "../src/tools/configFiles.js";
import { createUnavailableEsphomeClient, type EsphomeClient, type EsphomeCommandRequest } from "../src/esphome/client.js";
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
		esphome?: Partial<EsphomeClient>;
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
		esphome: { ...createUnavailableEsphomeClient(), ...options.esphome } as EsphomeClient,
		nodered: createNodeRedClient(config, logger),
		vomehome: (options.vomehome ?? createVomeHomeClient(config, logger)) as VomeHomeClient,
		instances
	};
	const server = new FakeServer();
	registerAllTools(server as unknown as McpServer, ctx);
	return server;
}

describe("ha_call_service results", () => {
	it("reports a service's own response when HA returns one (changed_states + service_response)", async () => {
		const callService = vi.fn(async () => ({
			changed_states: [{ entity_id: "sensor.x", state: "on", attributes: {} }],
			service_response: { uid: "vs_1", name: "Tower Bridge open" }
		}));
		const server = buildHarness({ env: { HA_ALLOW_WRITE: "true" }, rest: { callService } });
		const result = await server.call("ha_call_service", { domain: "vomesync", service: "subscribe_switch", data: { uid: "vs_1" } });
		expect(result.isError).toBeFalsy();
		const body = JSON.parse(textOf(result));
		expect(body.changed_entities).toEqual([{ entity_id: "sensor.x", state: "on" }]);
		expect(body.service_response).toEqual({ uid: "vs_1", name: "Tower Bridge open" });
	});

	it("still takes the plain list of changed states", async () => {
		const callService = vi.fn(async () => [{ entity_id: "light.k", state: "off", attributes: {} }]);
		const server = buildHarness({ env: { HA_ALLOW_WRITE: "true" }, rest: { callService } });
		const result = await server.call("ha_call_service", { domain: "light", service: "turn_off", target: { entity_id: "light.k" } });
		const body = JSON.parse(textOf(result));
		expect(body.raw_changed_count).toBe(1);
		expect(body.service_response).toBeUndefined();
	});
});

describe("ha_call_service return_response", () => {
	const SERVICES = [
		{ domain: "shell_command", services: { uptime: { response: { optional: true } } } },
		{ domain: "light", services: { turn_on: {} } }
	];

	it("asks for the response of a service that can return one, and reads the list once", async () => {
		const getServices = vi.fn(async () => SERVICES);
		const callService = vi.fn(async (_d: string, service: string) =>
			service === "uptime"
				? { changed_states: [], service_response: { stdout: "up 3 days", stderr: "", returncode: 0 } }
				: []
		);
		const server = buildHarness({ env: { HA_ALLOW_WRITE: "true" }, rest: { getServices, callService } });

		const shell = jsonOf(await server.call("ha_call_service", { domain: "shell_command", service: "uptime" }));
		await server.call("ha_call_service", { domain: "light", service: "turn_on", target: { entity_id: "light.k" } });

		expect(shell.service_response).toEqual({ stdout: "up 3 days", stderr: "", returncode: 0 });
		expect((callService.mock.calls[0] as unknown[])[4]).toMatchObject({ returnResponse: true });
		expect((callService.mock.calls[1] as unknown[])[4]).toMatchObject({ returnResponse: false });
		expect(getServices).toHaveBeenCalledTimes(1);
	});

	it("lets the caller turn it off, and says when an asked-for response did not come back", async () => {
		const getServices = vi.fn(async () => SERVICES);
		const callService = vi.fn(async () => []);
		const server = buildHarness({ env: { HA_ALLOW_WRITE: "true" }, rest: { getServices, callService } });

		await server.call("ha_call_service", { domain: "shell_command", service: "uptime", return_response: false });
		expect((callService.mock.calls[0] as unknown[])[4]).toMatchObject({ returnResponse: false });
		expect(getServices).not.toHaveBeenCalled();

		const body = jsonOf(await server.call("ha_call_service", { domain: "shell_command", service: "uptime" }));
		expect(body.service_response).toBeUndefined();
		expect(body.service_response_note).toMatch(/portal/);
	});

	it("still calls the service when the service list cannot be read", async () => {
		const getServices = vi.fn(async () => {
			throw new HaApiError("boom", 500, "");
		});
		const callService = vi.fn(async () => []);
		const server = buildHarness({ env: { HA_ALLOW_WRITE: "true" }, rest: { getServices, callService } });

		const result = await server.call("ha_call_service", { domain: "shell_command", service: "uptime" });
		expect(result.isError).toBeFalsy();
		expect((callService.mock.calls[0] as unknown[])[4]).toMatchObject({ returnResponse: false });
	});
});

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

describe("esphome_upload", () => {
	const fakeEsphome = (exitCodes: Record<string, number>) => {
		const ran: string[] = [];
		const runCommand = async (request: EsphomeCommandRequest) => {
			ran.push(request.command);
			return {
				command: request.command,
				configuration: request.configuration,
				exitCode: exitCodes[request.command] ?? 0,
				output: `${request.command} output\n`,
				truncated: false,
				timedOut: false
			};
		};
		return { ran, client: { runCommand } as unknown as Partial<EsphomeClient> };
	};

	it("compiles before it flashes, since Device Builder's upload only sends a firmware already built", async () => {
		const fake = fakeEsphome({});
		const server = buildHarness({ env: { HA_ALLOW_WRITE: "true" }, esphome: fake.client });
		const body = jsonOf(await server.call("esphome_upload", { configuration: "loft.yaml" }));
		expect(fake.ran).toEqual(["compile", "upload"]);
		expect(body.success).toBe(true);
		expect(body.output).toBe("compile output\nupload output\n");
	});

	it("never reaches the device when the build fails", async () => {
		const fake = fakeEsphome({ compile: 1 });
		const server = buildHarness({ env: { HA_ALLOW_WRITE: "true" }, esphome: fake.client });
		const body = jsonOf(await server.call("esphome_upload", { configuration: "loft.yaml" }));
		expect(fake.ran).toEqual(["compile"]);
		expect(body.success).toBe(false);
		expect(body.failed_step).toBe("compile");
	});
});

describe("esphome_edit_config", () => {
	const fakeFiles = (yaml: string) => {
		const saved: string[] = [];
		const client = {
			getConfig: async () => yaml,
			saveConfig: async (_name: string, text: string) => {
				saved.push(text);
			}
		} as unknown as Partial<EsphomeClient>;
		return { saved, client };
	};
	const env = { HA_ALLOW_WRITE: "true", HA_ALLOW_CONFIG_WRITE: "true" };

	it("changes only what the edits name, so a long file is not resent whole", async () => {
		const files = fakeFiles("ota:\n  - platform: esphome\n    password: hunter2\nsensor:\n  - name: Gas/Smoke\n");
		const server = buildHarness({ env, esphome: files.client });
		const body = jsonOf(
			await server.call("esphome_edit_config", {
				configuration: "loft.yaml",
				edits: [
					{ old_text: "    password: hunter2", new_text: "    encryption: {}" },
					{ old_text: "Gas/Smoke", new_text: "Gas⁄Smoke" }
				]
			})
		);
		expect(body.edits_applied).toBe(2);
		expect(files.saved).toEqual(["ota:\n  - platform: esphome\n    encryption: {}\nsensor:\n  - name: Gas⁄Smoke\n"]);
	});

	it("saves nothing when an edit matches nothing, or more than once", async () => {
		const files = fakeFiles("a: 1\nb: 1\n");
		const server = buildHarness({ env, esphome: files.client });
		const missing = await server.call("esphome_edit_config", { configuration: "x.yaml", edits: [{ old_text: "c: 1", new_text: "c: 2" }] });
		const twice = await server.call("esphome_edit_config", { configuration: "x.yaml", edits: [{ old_text: ": 1", new_text: ": 2" }] });
		expect(missing.isError).toBe(true);
		expect(textOf(missing)).toMatch(/matches nothing/);
		expect(textOf(twice)).toMatch(/more than once/);
		expect(files.saved).toEqual([]);
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
	it("reads the add-on log and tails it", async () => {
		const getSupervisorLog = vi.fn(async () => ["a", "b", "c", "d"].join("\n"));
		const server = buildHarness({ rest: { getSupervisorLog } });
		const result = await server.call("ha_get_supervisor_log", {
			target: "addon",
			addon_slug: "core_matter_server",
			tail_lines: 2
		});
		expect(getSupervisorLog).toHaveBeenCalledWith("addon", "core_matter_server");
		expect(textOf(result)).toBe("c\nd");
	});

	it("defaults to the core log", async () => {
		const getSupervisorLog = vi.fn(async () => "core line");
		const server = buildHarness({ rest: { getSupervisorLog } });
		await server.call("ha_get_supervisor_log");
		expect(getSupervisorLog).toHaveBeenCalledWith("core", undefined);
	});

	it("requires addon_slug for target=addon", async () => {
		const getSupervisorLog = vi.fn();
		const server = buildHarness({ rest: { getSupervisorLog } });
		const result = await server.call("ha_get_supervisor_log", { target: "addon" });
		expect(result.isError).toBe(true);
		expect(getSupervisorLog).not.toHaveBeenCalled();
	});

	it("explains a 404 rather than passing it on bare", async () => {
		const getSupervisorLog = vi.fn(async () => {
			throw new HaApiError("responded 404", 404, "");
		});
		const server = buildHarness({ rest: { getSupervisorLog } });
		const result = await server.call("ha_get_supervisor_log", { target: "addon", addon_slug: "nope" });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/No add-on 'nope'/);
	});
});

describe("ha_get_error_log", () => {
	/* HA serves /api/error_log only when it writes a log file. Current HAOS
	   logs to the journal instead, so the endpoint 404s and the tool was dead
	   on every hosted home (seen on GamlaBio, 14 Oct). The same lines are the
	   Supervisor's core log. */
	it("reads the log file where HA still serves it", async () => {
		const getErrorLog = vi.fn(async () => "a\nb\nc");
		const getSupervisorLog = vi.fn();
		const server = buildHarness({ rest: { getErrorLog, getSupervisorLog } });
		expect(textOf(await server.call("ha_get_error_log", { tail_lines: 2 }))).toBe("b\nc");
		expect(getSupervisorLog).not.toHaveBeenCalled();
	});

	it("falls back to the Supervisor's core log on a 404, without the colour codes", async () => {
		const esc = String.fromCharCode(27);
		const getErrorLog = vi.fn(async () => {
			throw new HaApiError("responded 404", 404, "404: Not Found");
		});
		const getSupervisorLog = vi.fn(async () => `${esc}[33mWARNING one${esc}[0m\n${esc}[31mERROR two${esc}[0m`);
		const server = buildHarness({ rest: { getErrorLog, getSupervisorLog } });
		const result = await server.call("ha_get_error_log");
		expect(result.isError).toBeFalsy();
		expect(getSupervisorLog).toHaveBeenCalledWith("core");
		expect(textOf(result)).toBe("WARNING one\nERROR two");
	});

	it("points at the system log when there is no Supervisor either", async () => {
		const notFound = async () => {
			throw new HaApiError("responded 404", 404, "");
		};
		const server = buildHarness({ rest: { getErrorLog: vi.fn(notFound), getSupervisorLog: vi.fn(notFound) } });
		const result = await server.call("ha_get_error_log");
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/ha_get_system_log/);
	});

	it("does not mask other failures as a missing file", async () => {
		const getSupervisorLog = vi.fn();
		const getErrorLog = vi.fn(async () => {
			throw new HaApiError("responded 401", 401, "");
		});
		const server = buildHarness({ rest: { getErrorLog, getSupervisorLog } });
		const result = await server.call("ha_get_error_log");
		expect(result.isError).toBe(true);
		expect(getSupervisorLog).not.toHaveBeenCalled();
	});
});

describe("automations defined in YAML packages", () => {
	const STATES = [
		{
			entity_id: "automation.front_path_adaptive_seasonal_ble",
			state: "on",
			attributes: { id: "1712345678901", friendly_name: "Front path adaptive seasonal BLE" }
		},
		{ entity_id: "automation.no_id", state: "on", attributes: { friendly_name: "Old YAML one" } },
		{ entity_id: "automation.ui_made", state: "on", attributes: { id: "ui1", friendly_name: "UI made" } }
	];
	const notFound = () => new HaApiError("Home Assistant GET … responded 404 Not Found", 404, '{"message":"Resource not found"}');

	it("says a 404 from the editor's API means the automation lives in YAML, and what to search for", async () => {
		const getAutomationConfig = vi.fn(async () => {
			throw notFound();
		});
		const server = buildHarness({ rest: { getStates: async () => STATES, getAutomationConfig } });

		const result = await server.call("ha_get_automation", { automation: "automation.front_path_adaptive_seasonal_ble" });

		expect(result.isError).toBe(true);
		const text = textOf(result);
		expect(getAutomationConfig).toHaveBeenCalledWith("1712345678901");
		expect(text).toContain("automation.front_path_adaptive_seasonal_ble");
		expect(text).toMatch(/not defined in the automation editor \(automations\.yaml\)/);
		expect(text).toMatch(/package/);
		expect(text).toContain('"Front path adaptive seasonal BLE" or "1712345678901"');
		expect(text).toMatch(/ha_list_config_files/);
	});

	it("names the entity when asked by unique id", async () => {
		const server = buildHarness({
			rest: {
				getStates: async () => STATES,
				getAutomationConfig: async () => {
					throw notFound();
				}
			}
		});
		const text = textOf(await server.call("ha_get_automation", { automation: "1712345678901" }));
		expect(text).toContain("automation.front_path_adaptive_seasonal_ble");
		expect(text).toMatch(/comes from YAML/);
	});

	it("explains an automation with no id at all", async () => {
		const getAutomationConfig = vi.fn();
		const server = buildHarness({ rest: { getStates: async () => STATES, getAutomationConfig } });
		const text = textOf(await server.call("ha_get_automation", { automation: "automation.no_id" }));
		expect(text).toMatch(/no unique id/);
		expect(text).toContain('"Old YAML one"');
		expect(getAutomationConfig).not.toHaveBeenCalled();
	});

	it("still returns an editor automation's config", async () => {
		const server = buildHarness({
			rest: { getStates: async () => STATES, getAutomationConfig: async () => ({ alias: "UI made" }) }
		});
		expect(jsonOf(await server.call("ha_get_automation", { automation: "automation.ui_made" }))).toEqual({
			id: "ui1",
			config: { alias: "UI made" }
		});
	});

	it("does not mistake other failures for a package automation", async () => {
		const server = buildHarness({
			rest: {
				getStates: async () => STATES,
				getAutomationConfig: async () => {
					throw new HaApiError("Home Assistant GET … responded 401 Unauthorized", 401, "");
				}
			}
		});
		const text = textOf(await server.call("ha_get_automation", { automation: "automation.ui_made" }));
		expect(text).toMatch(/401/);
		expect(text).not.toMatch(/package/);
	});

	it("ha_delete_automation says the same instead of a bare 404", async () => {
		const server = buildHarness({
			env: { HA_ALLOW_WRITE: "true", HA_ALLOW_CONFIG_WRITE: "true" },
			rest: {
				getStates: async () => STATES,
				deleteAutomationConfig: async () => {
					throw notFound();
				}
			}
		});
		const text = textOf(await server.call("ha_delete_automation", { automation_id: "1712345678901" }));
		expect(text).toMatch(/^Nothing deleted: automation\.front_path_adaptive_seasonal_ble/);
		expect(text).toMatch(/comes from YAML/);
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

	it("reports whichever trigger fired, not only the first", async () => {
		// An automation's second trigger is recorded as trigger/1; reading only
		// trigger/0 reported every such run as having no trigger at all.
		const fromSecond = {
			...traceDetail,
			trigger: "state of person.alex",
			trace: {
				"trigger/1": [{ path: "trigger/1", timestamp: "2026-08-02T06:00:00.000Z" }],
				"action/0": [{ path: "action/0", timestamp: "2026-08-02T06:00:00.010Z", result: {} }]
			}
		};
		const server = buildHarness({
			rest: { getStates: async () => automationStates as any },
			ws: { sendCommand: async () => fromSecond as any }
		});
		const body = jsonOf(await server.call("ha_get_trace", { item: "1699999999999", run_id: "latest" }));
		expect(body.trigger).toMatchObject({ description: "state of person.alex" });
	});

	describe("a run_id that trace/get cannot find", () => {
		const otherRun = { ...traceList[0], run_id: "elsewhere", item_id: "1700000000000" };
		const notFound = () => new Error('WebSocket command failed: {"code":"not_found","message":"The trace could not be found"}');

		function lookupHarness(calls: Array<Record<string, unknown>>, stored: unknown[], found: string) {
			return buildHarness({
				rest: { getStates: async () => automationStates as any },
				ws: {
					sendCommand: async (command: any) => {
						calls.push(command);
						if (command.type === "trace/list") return stored as any;
						if (command.item_id === found) return { ...traceDetail, run_id: command.run_id, item_id: found } as any;
						throw notFound();
					}
				}
			});
		}

		it("finds the run's own item when only a run_id is given", async () => {
			const calls: Array<Record<string, unknown>> = [];
			const server = lookupHarness(calls, [...traceList, otherRun], "1700000000000");
			const body = jsonOf(await server.call("ha_get_trace", { run_id: "elsewhere" }));
			expect(calls[0]).toEqual({ type: "trace/list", domain: "automation" });
			expect(calls[1]).toMatchObject({ type: "trace/get", item_id: "1700000000000", run_id: "elsewhere" });
			expect(body.item_id).toBe("1700000000000");
		});

		it("fetches from the right item when the run belongs to another one", async () => {
			const calls: Array<Record<string, unknown>> = [];
			const server = lookupHarness(calls, [...traceList, otherRun], "1700000000000");
			const body = jsonOf(await server.call("ha_get_trace", { item: "automation.morning", run_id: "elsewhere" }));
			expect(body.note).toMatch(/belongs to automation '1700000000000'/);
			expect(body.item_id).toBe("1700000000000");
		});

		it("says the run has aged out, and what is stored now, instead of a bare 404", async () => {
			const calls: Array<Record<string, unknown>> = [];
			const server = lookupHarness(calls, traceList, "nobody");
			const result = await server.call("ha_get_trace", { item: "automation.morning", run_id: "gone" });
			expect(result.isError).toBe(true);
			const text = textOf(result);
			expect(text).toMatch(/no longer stored/);
			expect(text).toMatch(/stored_traces/);
			expect(text).toMatch(/latest .*older/);
		});

		it("treats the broker's 404 the same as the raw not_found", async () => {
			const server = buildHarness({
				rest: { getStates: async () => automationStates as any },
				ws: {
					sendCommand: async (command: any) => {
						if (command.type === "trace/list") return traceList as any;
						throw new HaApiError("VomeHome broker POST /ws/command responded 404", 404, "{}");
					}
				}
			});
			const result = await server.call("ha_get_trace", { item: "automation.morning", run_id: "gone" });
			expect(textOf(result)).toMatch(/no longer stored/);
		});

		it("needs an item or a run_id", async () => {
			const server = lookupHarness([], traceList, "nobody");
			const result = await server.call("ha_get_trace", {});
			expect(result.isError).toBe(true);
		});
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

describe("ha_delete_config_entry", () => {
	it("refuses without config-write, before reaching the network", async () => {
		const request = vi.fn();
		const server = buildHarness({ rest: { request } });
		const result = await server.call("ha_delete_config_entry", { entry_id: "01JQ2ZK8" });
		expect(result.isError).toBe(true);
		expect(request).not.toHaveBeenCalled();
	});

	it("deletes the entry by id and reports whether a restart is needed", async () => {
		const request = vi.fn(async () => ({ require_restart: true }));
		const server = buildHarness({
			env: { HA_ALLOW_WRITE: "true", HA_ALLOW_CONFIG_WRITE: "true" },
			rest: { request }
		});
		const result = await server.call("ha_delete_config_entry", { entry_id: "01JQ2ZK8" });
		expect(result.isError).toBeUndefined();
		expect(request).toHaveBeenCalledWith("/api/config/config_entries/entry/01JQ2ZK8", {
			method: "DELETE"
		});
		const body = jsonOf(result);
		expect(body.deleted).toBe(true);
		expect(body.require_restart).toBe(true);
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
			["ha_write_config_file", { instance_id: "direct", path: "configuration.yaml", content: "x" }],
			["ha_upload_file", { instance_id: "direct", local_path: "/nonexistent/x.yaml", path: "x.yaml" }]
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

describe("ha_list_config_files paging and totals", () => {
	const BROKERED = { HA_TOKEN: "", VOMEHOME_TOKEN: "vh_test", VOMEHOME_INSTANCE_ID: "rly-1" };

	it("asks the home for one folder and filters, pages and totals what came back", async () => {
		const entries = [
			{ name: "packages", path: "packages", is_dir: true, size: null },
			...Array.from({ length: 499 }, (_, i) => ({ name: `f${i}.yaml`, path: `f${i}.yaml`, is_dir: false, size: 2 }))
		];
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ path: "", entries, truncated: true }), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const server = buildHarness({ env: BROKERED });

		const body = jsonOf(await server.call("ha_list_config_files", { glob: "f1*.yaml", offset: 10, limit: 5 }));
		expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toMatch(/\/ha\/files\/list\?path=$/);
		expect(body.total_entries).toBe(500);
		expect(body.total_bytes).toBe(998);
		expect(body.truncated).toBe(true);
		expect(body.note).toMatch(/first 500 entries/);
		expect(body.matched).toBe(111); // f1, f10-f19, f100-f199
		expect(body.entries).toHaveLength(5);
		expect(body.next_offset).toBe(15);
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

describe("ha_upload_file", () => {
	const BROKERED = {
		HA_TOKEN: "",
		VOMEHOME_TOKEN: "vh_test",
		VOMEHOME_INSTANCE_ID: "rly-1",
		HA_ALLOW_WRITE: "true",
		HA_ALLOW_CONFIG_WRITE: "true"
	};
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ha-upload-"));
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		rmSync(dir, { recursive: true, force: true });
	});

	/** Routes the file endpoints; records every write body. */
	function stubFiles(existing: string | null = null) {
		const writes: Array<{ url: string; body: { content: string; encoding: string } }> = [];
		const fetchMock = vi.fn(async (input: unknown, init: any) => {
			const url = String(input);
			if (url.includes("/files/read")) {
				return existing === null
					? new Response("not found", { status: 404 })
					: new Response(JSON.stringify({ content: existing }), { status: 200 });
			}
			writes.push({ url, body: JSON.parse(init.body) });
			return new Response(JSON.stringify({ path: "x", written: true }), { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);
		return { writes, fetchMock };
	}

	it("sends a text file as UTF-8, byte for byte, without a config check for a non-YAML file", async () => {
		const page = "\uFEFF<!doctype html>\r\n<p>Hall \u00e5\u00e4\u00f6</p>\n";
		const local = join(dir, "index.html");
		writeFileSync(local, page, "utf8");
		const { writes } = stubFiles();
		const checkConfig = vi.fn();
		const server = buildHarness({ env: BROKERED, rest: { checkConfig } });

		const result = await server.call("ha_upload_file", {
			instance_id: "rly-1",
			local_path: local,
			path: "www/floor/index.html"
		});

		expect(result.isError).toBeFalsy();
		expect(writes).toHaveLength(1);
		expect(writes[0]!.url).toContain("/files/write?path=www%2Ffloor%2Findex.html");
		expect(writes[0]!.body).toEqual({ content: page, encoding: "utf8" });
		expect(checkConfig).not.toHaveBeenCalled();
		const body = jsonOf(result);
		expect(body).toMatchObject({ uploaded_from: local, encoding: "utf8", verified: false });
		expect(body.bytes).toBe(Buffer.byteLength(page, "utf8"));
	});

	it("sends a binary file as base64", async () => {
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0xff]);
		const local = join(dir, "icon.png");
		writeFileSync(local, png);
		const { writes } = stubFiles();
		const server = buildHarness({ env: BROKERED });

		const body = jsonOf(
			await server.call("ha_upload_file", { instance_id: "rly-1", local_path: local, path: "www/icon.png" })
		);

		expect(writes[0]!.body).toEqual({ content: png.toString("base64"), encoding: "base64" });
		expect(body.encoding).toBe("base64");
	});

	it("checks a YAML file and puts the old one back when it breaks the configuration", async () => {
		const local = join(dir, "heating.yaml");
		writeFileSync(local, "broken: [\n");
		const { writes } = stubFiles("good: true\n");
		const checkConfig = vi
			.fn()
			.mockResolvedValueOnce({ result: "invalid", errors: "bad yaml" })
			.mockResolvedValueOnce({ result: "valid", errors: null });
		const server = buildHarness({ env: BROKERED, rest: { checkConfig } });

		const body = jsonOf(
			await server.call("ha_upload_file", {
				instance_id: "rly-1",
				local_path: local,
				path: "packages/heating.yaml"
			})
		);

		expect(body.rolled_back).toBe(true);
		expect(writes.map((w) => w.body.content)).toEqual(["broken: [\n", "good: true\n"]);
	});

	it("resolves a relative local_path against the server's working directory", () => {
		expect(resolveLocalPath("site/index.html", "/work/proj")).toBe("/work/proj/site/index.html");
		expect(resolveLocalPath("/abs/file.txt", "/work/proj")).toBe("/abs/file.txt");
	});

	it("refuses a file over 2 MiB before sending anything", async () => {
		const local = join(dir, "big.bin");
		writeFileSync(local, Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0x41));
		const { fetchMock } = stubFiles();
		const server = buildHarness({ env: BROKERED });

		const result = await server.call("ha_upload_file", { instance_id: "rly-1", local_path: local, path: "www/big.bin" });

		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/2 MiB/);
		expect(textOf(result)).toContain(String(MAX_UPLOAD_BYTES));
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("says so when the local file is missing or a directory", async () => {
		const { fetchMock } = stubFiles();
		const server = buildHarness({ env: BROKERED });

		const missing = await server.call("ha_upload_file", { instance_id: "rly-1", local_path: join(dir, "nope.txt"), path: "x.txt" });
		expect(textOf(missing)).toMatch(/does not exist/);
		const folder = await server.call("ha_upload_file", { instance_id: "rly-1", local_path: dir, path: "x.txt" });
		expect(textOf(folder)).toMatch(/not a regular file/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("refuses, without reading or writing, when the named home is not the one selected", async () => {
		const local = join(dir, "a.txt");
		writeFileSync(local, "a");
		const { fetchMock } = stubFiles();
		const server = buildHarness({ env: BROKERED });

		const result = await server.call("ha_upload_file", { instance_id: "other", local_path: local, path: "a.txt" });

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("rly-1");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("on the hosted server, reads nothing and gives the REST upload instead", async () => {
		const local = join(dir, "page.html");
		writeFileSync(local, "<p>secret on the server</p>");
		const { fetchMock } = stubFiles();
		const server = buildHarness({ env: { ...BROKERED, MCP_HOSTED: "1" } });

		const result = await server.call("ha_upload_file", { instance_id: "rly-1", local_path: local, path: "www/page.html" });

		expect(result.isError).toBe(true);
		const text = textOf(result);
		expect(text).toContain("https://vome.io/api/v1/instances/rly-1/ha/files/write?path=www%2Fpage.html");
		expect(text).toContain(`file=@${local}`);
		expect(text).not.toContain("secret on the server");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("tools while Home Assistant restarts", () => {
	it("say it is restarting instead of showing the raw failure", async () => {
		const getStates = vi.fn(async () => {
			throw new HaRestartingError("Home Assistant is restarting (core state: NOT_RUNNING). Retry in about 60 seconds.", "NOT_RUNNING", "502");
		});
		const server = buildHarness({ rest: { getStates } });
		const text = textOf(await server.call("ha_list_entities", {}));
		expect(text).toMatch(/^Tool 'ha_list_entities' failed: Home Assistant is restarting \(core state: NOT_RUNNING\)/);
		expect(text).not.toMatch(/status 503/);
	});

	it("config files say so too, after one check of the core state", async () => {
		vi.stubGlobal("fetch", vi.fn(async () =>
			new Response(JSON.stringify({ error: "Home Assistant is offline (no relay connection)." }), { status: 502 })
		));
		const getConfig = vi.fn(async () => ({ state: "STARTING" }));
		const server = buildHarness({
			env: { HA_TOKEN: "", VOMEHOME_TOKEN: "vh_test", VOMEHOME_INSTANCE_ID: "rly-1" },
			rest: { getConfig }
		});
		const text = textOf(await server.call("ha_list_config_files", {}));
		expect(text).toMatch(/Home Assistant is restarting \(core state: STARTING\)/);
		expect(getConfig).toHaveBeenCalled();
		vi.unstubAllGlobals();
	});
});

describe("encodeForUpload", () => {
	it("keeps UTF-8 text (with ANSI colour and tabs) as text", () => {
		const text = "\u001b[31mred\u001b[0m\tok\n";
		expect(encodeForUpload(Buffer.from(text, "utf8"))).toEqual({ encoding: "utf8", content: text });
	});

	it("base64s invalid UTF-8, NUL bytes and control-character soup", () => {
		expect(encodeForUpload(Buffer.from([0xc3, 0x28])).encoding).toBe("base64");
		expect(encodeForUpload(Buffer.from("ab\u0000cd", "utf8")).encoding).toBe("base64");
		expect(encodeForUpload(Buffer.from([1, 2, 3, 4, 5, 0x41])).encoding).toBe("base64");
	});

	it("treats an empty file as text", () => {
		expect(encodeForUpload(Buffer.alloc(0))).toEqual({ encoding: "utf8", content: "" });
	});
});

describe("hacs", () => {
	const WRITE = { HA_ALLOW_WRITE: "true", HA_ALLOW_CONFIG_WRITE: "true" };

	afterEach(() => vi.useRealTimers());

	// Home Assistant before 2026.11: no Marketplace, so its commands are unknown.
	const preMarketplace = (handler: (command: Record<string, unknown>) => unknown) =>
		vi.fn(async (command: Record<string, unknown>) => {
			if (String(command.type).startsWith("marketplace/")) {
				throw new Error('WebSocket command failed: {"code":"unknown_command","message":"Unknown command."}');
			}
			return handler(command);
		});

	it("gets HACS status over the websocket", async () => {
		const sendCommand = preMarketplace(async () => ({ version: "2.1.0", stage: "running" }));
		const server = buildHarness({ ws: { sendCommand } });

		const body = jsonOf(await server.call("ha_hacs_info", {}));
		expect(body.version).toBe("2.1.0");
		expect(sendCommand).toHaveBeenCalledWith({ type: "hacs/info" });
	});

	it("lists repositories, optionally filtered by category", async () => {
		const sendCommand = preMarketplace(async () => [
			{ id: "1", full_name: "me/repo", category: "integration", installed: true }
		]);
		const server = buildHarness({ ws: { sendCommand } });

		const body = jsonOf(await server.call("ha_hacs_list_repositories", { categories: ["integration"] }));
		expect(body.count).toBe(1);
		expect(sendCommand).toHaveBeenCalledWith({
			type: "hacs/repositories/list",
			categories: ["integration"]
		});
	});

	describe("listing a big catalogue (the 4 MB reply)", () => {
		// A raw HACS row: everything the store knows, most of it noise for an agent.
		const raw = (id: number, installed: boolean, extra: Record<string, unknown> = {}) => ({
			id: String(id),
			name: `Repo ${id}`,
			full_name: `owner/repo-${id}`,
			category: id % 2 ? "integration" : "plugin",
			installed,
			custom: false,
			description: "x".repeat(400),
			topics: ["home-assistant", "hacs"],
			authors: ["@someone"],
			stars: 1234,
			downloads: 99,
			installed_version: installed ? "1.0.0" : null,
			available_version: "1.1.0",
			pending_upgrade: installed,
			...extra
		});
		const catalogue = [
			...Array.from({ length: 3000 }, (_, i) => raw(i + 10, false)),
			raw(1, true),
			raw(2, true, { pending_upgrade: false, available_version: "1.0.0" })
		];

		it("returns only installed repositories by default, trimmed to the useful fields", async () => {
			const sendCommand = preMarketplace(async () => catalogue);
			const server = buildHarness({ ws: { sendCommand } });

			const result = await server.call("ha_hacs_list_repositories", {});
			const body = jsonOf(result);
			expect(body.total_known).toBe(3002);
			expect(body.installed).toBe(2);
			expect(body.count).toBe(2);
			expect(body.filters.installed_only).toBe(true);
			expect(body.note).toMatch(/3000 repositories .* not installed/);
			expect(body.repositories[0]).toEqual({
				id: "1",
				name: "Repo 1",
				full_name: "owner/repo-1",
				category: "integration",
				installed: true,
				installed_version: "1.0.0",
				available_version: "1.1.0",
				pending_update: true,
				custom: false
			});
			expect(body.repositories[1].pending_update).toBe(false);
			expect(textOf(result).length).toBeLessThan(2000);
		});

		it("searches the whole catalogue when given a search, bounded by limit", async () => {
			const sendCommand = preMarketplace(async () => catalogue);
			const server = buildHarness({ ws: { sendCommand } });

			const body = jsonOf(await server.call("ha_hacs_list_repositories", { search: "REPO-30", limit: 5 }));
			expect(body.filters.installed_only).toBe(false);
			expect(body.matched).toBe(21); // repo-30, repo-300..309, repo-3000..3009
			expect(body.count).toBe(5);
			expect(body.truncated).toBe(true);
			expect(body.note).toMatch(/first 5 of 21/);
			expect(body.repositories[0].description).toBeUndefined();
		});

		it("still lists everything with installed_only=false, and raw rows with full=true", async () => {
			const sendCommand = preMarketplace(async () => catalogue);
			const server = buildHarness({ ws: { sendCommand } });

			const all = jsonOf(await server.call("ha_hacs_list_repositories", { installed_only: false }));
			expect(all.matched).toBe(3002);
			expect(all.count).toBe(100);

			const fullRows = jsonOf(await server.call("ha_hacs_list_repositories", { full: true }));
			expect(fullRows.repositories[0].description).toHaveLength(400);
		});

		it("works the same on the Marketplace, whose rows may name versions differently", async () => {
			const sendCommand = vi.fn(async (command: Record<string, unknown>) => {
				if (command.type === "marketplace/repositories/list") {
					return [
						{ id: "7", full_name: "me/card", category: "plugin", installed: true, version_installed: "2.0", latest_version: "2.1" },
						{ id: "8", full_name: "me/other", category: "plugin", installed: false }
					];
				}
				return { version: "2026.11.0" };
			});
			const server = buildHarness({ ws: { sendCommand } });

			const body = jsonOf(await server.call("ha_hacs_list_repositories", {}));
			expect(body.store).toBe("marketplace");
			expect(body.repositories).toEqual([
				{
					id: "7",
					name: "me/card",
					full_name: "me/card",
					category: "plugin",
					installed: true,
					installed_version: "2.0",
					available_version: "2.1",
					pending_update: true
				}
			]);
			expect(sendCommand).not.toHaveBeenCalledWith(expect.objectContaining({ type: "hacs/repositories/list" }));
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
		const sendCommand = preMarketplace(async (command: Record<string, unknown>) => {
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
		const sendCommand = preMarketplace(async (command: Record<string, unknown>) => {
			expect(["hacs/info", "hacs/repositories/list"]).toContain(command.type);
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
		const sendCommand = preMarketplace(async (command: Record<string, unknown>) =>
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
		const sendCommand = preMarketplace(async (command: Record<string, unknown>) => {
			if (command.type === "hacs/repositories/list") {
				return [{ id: "123", full_name: "me/repo", category: "integration", installed: true }];
			}
			if (command.type === "hacs/info") {
				return {};
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
		const sendCommand = preMarketplace(async () => []);
		const server = buildHarness({ env: WRITE, ws: { sendCommand } });

		const result = await server.call("ha_hacs_download_repository", { repository: "me/missing" });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/No HACS repository matches/);
	});

	it("uninstalls before untracking a repository that is installed", async () => {
		const seen: string[] = [];
		const sendCommand = preMarketplace(async (command: Record<string, unknown>) => {
			if (command.type === "hacs/repositories/list") {
				return [{ id: "123", full_name: "me/repo", category: "integration", installed: true }];
			}
			if (command.type !== "hacs/info") {
				seen.push(command.type as string);
			}
			return {};
		});
		const server = buildHarness({ env: WRITE, ws: { sendCommand } });

		const body = jsonOf(await server.call("ha_hacs_remove_repository", { repository: "123" }));
		expect(seen).toEqual(["hacs/repository/remove", "hacs/repositories/remove"]);
		expect(body.removed).toBe(true);
	});

	it("only untracks a repository that was never installed", async () => {
		const seen: string[] = [];
		const sendCommand = preMarketplace(async (command: Record<string, unknown>) => {
			if (command.type === "hacs/repositories/list") {
				return [{ id: "123", full_name: "me/repo", category: "integration", installed: false }];
			}
			if (command.type !== "hacs/info") {
				seen.push(command.type as string);
			}
			return {};
		});
		const server = buildHarness({ env: WRITE, ws: { sendCommand } });

		await server.call("ha_hacs_remove_repository", { repository: "123" });
		expect(seen).toEqual(["hacs/repositories/remove"]);
	});
	describe("on the Marketplace (Home Assistant 2026.11+)", () => {
		const ROW = { id: "123", full_name: "me/repo", category: "integration", installed: false };

		it("reports which store it found", async () => {
			const sendCommand = vi.fn(async () => ({ version: "2026.11.0", warning_accepted: true }));
			const server = buildHarness({ ws: { sendCommand } });

			const body = jsonOf(await server.call("ha_hacs_info", {}));
			expect(body.store).toBe("marketplace");
			expect(body.warning_accepted).toBe(true);
			expect(sendCommand).toHaveBeenCalledWith({ type: "marketplace/info" });
			expect(sendCommand).not.toHaveBeenCalledWith({ type: "hacs/info" });
		});

		it("installs with marketplace/repository/install, never a hacs/ command", async () => {
			const seen: Array<Record<string, unknown>> = [];
			const sendCommand = vi.fn(async (command: Record<string, unknown>) => {
				seen.push(command);
				if (command.type === "marketplace/repositories/list") {
					return [ROW];
				}
				return {};
			});
			const server = buildHarness({ env: WRITE, ws: { sendCommand } });

			const body = jsonOf(
				await server.call("ha_hacs_download_repository", { repository: "me/repo", version: "v1.2.0" })
			);
			expect(body.store).toBe("marketplace");
			expect(seen).toContainEqual({ type: "marketplace/repository/install", repository: "123", version: "v1.2.0" });
			expect(seen.some((command) => String(command.type).startsWith("hacs/"))).toBe(false);
		});

		it("uninstalls and untracks with the Marketplace's verbs", async () => {
			const seen: string[] = [];
			const sendCommand = vi.fn(async (command: Record<string, unknown>) => {
				if (command.type === "marketplace/repositories/list") {
					return [{ ...ROW, installed: true }];
				}
				if (command.type !== "marketplace/info") {
					seen.push(command.type as string);
				}
				return {};
			});
			const server = buildHarness({ env: WRITE, ws: { sendCommand } });

			await server.call("ha_hacs_remove_repository", { repository: "me/repo" });
			expect(seen).toEqual(["marketplace/repository/uninstall", "marketplace/repositories/remove"]);
		});

		it("explains the warning the owner has to accept, and doesn't accept it", async () => {
			const seen: string[] = [];
			const sendCommand = vi.fn(async (command: Record<string, unknown>) => {
				seen.push(command.type as string);
				if (command.type === "marketplace/repositories/list") {
					return [ROW];
				}
				if (command.type === "marketplace/repository/install") {
					throw new Error(
						'WebSocket command failed: {"code":"warning_not_accepted","message":"Accept the warning first"}'
					);
				}
				return {};
			});
			const server = buildHarness({ env: WRITE, ws: { sendCommand } });

			const result = await server.call("ha_hacs_download_repository", { repository: "me/repo" });
			expect(result.isError).toBe(true);
			expect(textOf(result)).toMatch(/Settings → Marketplace/);
			expect(textOf(result)).toMatch(/owner's decision/);
			expect(seen).not.toContain("marketplace/warning/accept");
		});

		it("explains that a custom repository needs GitHub connected", async () => {
			const sendCommand = vi.fn(async (command: Record<string, unknown>) => {
				if (command.type === "marketplace/repositories/list") {
					return [];
				}
				if (command.type === "marketplace/repositories/add") {
					throw new Error('VomeHome broker POST /ws/command responded 400: {"error":{"code":"github_not_connected"}}');
				}
				return {};
			});
			const server = buildHarness({ env: WRITE, ws: { sendCommand } });

			const result = await server.call("ha_hacs_add_repository", { repository: "me/repo", category: "integration" });
			expect(result.isError).toBe(true);
			expect(textOf(result)).toMatch(/GitHub account connected/);
		});
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

	it("lower-cases and trims a username, as Home Assistant 2026.10 requires", async () => {
		const sendCommand = vi.fn(async () => ({}));
		const server = buildHarness({ env: WRITE, ws: { sendCommand } });

		const body = jsonOf(
			await server.call("ha_set_user_credentials", { user_id: "u1", username: " Mum ", password: "hunter2" })
		);
		expect(sendCommand).toHaveBeenCalledWith({
			type: "config/auth_provider/homeassistant/create",
			user_id: "u1",
			username: "mum",
			password: "hunter2"
		});
		expect(body).toMatchObject({ created: true, username: "mum", normalized_from: " Mum " });
	});

	it("refuses a username that is only spaces", async () => {
		const sendCommand = vi.fn(async () => ({}));
		const server = buildHarness({ env: WRITE, ws: { sendCommand } });

		const result = await server.call("ha_set_user_credentials", { user_id: "u1", username: "   ", password: "x" });
		expect(result.isError).toBe(true);
		expect(sendCommand).not.toHaveBeenCalled();
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

describe("ha_addon_install_vome", () => {
	const WRITE = { HA_ALLOW_WRITE: "true", HA_ALLOW_CONFIG_WRITE: "true" };
	const STORE = { addons: [{ slug: "b1bff62e_vome", name: "Vome", repository: "b1bff62e" }] };

	/** Route one supervisor/api command to a caller-supplied answer. */
	function supervisor(
		routes: Record<string, (data?: unknown) => unknown>
	): { sendCommand: ReturnType<typeof vi.fn> } {
		const sendCommand = vi.fn(async (command: any) => {
			const key = `${command.method} ${command.endpoint}`;
			const route = routes[key];
			if (!route) throw new Error(`unrouted supervisor call: ${key}`);
			return route(command.data);
		});
		return { sendCommand };
	}

	/** The tool sleeps between steps; drive those timers rather than waiting. */
	async function run(server: FakeServer, args: Record<string, unknown> = {}) {
		const pending = server.call("ha_addon_install_vome", args);
		await vi.runAllTimersAsync();
		return pending;
	}

	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("treats a repository already in the store as added, not as a failure", async () => {
		// Supervisor's wording here is "already in the store". The guard only
		// matched "already exists", so a second run aborted before installing.
		const { sendCommand } = supervisor({
			"post /store/repositories": () => {
				throw new Error("Can't add repository: already in the store");
			},
			"get /store/addons": () => STORE,
			"post /store/addons/b1bff62e_vome/install": () => ({}),
			"post /addons/b1bff62e_vome/start": () => ({}),
			"post /addons/b1bff62e_vome/options": () => ({})
		});
		const server = buildHarness({ env: WRITE, ws: { sendCommand } });

		const body = jsonOf(await run(server));
		expect(body.ok).toBe(true);
		expect(body.slug).toBe("b1bff62e_vome");
		const repoStep = body.steps.find((s: any) => s.step === "add_repository");
		expect(repoStep.ok).toBe(true);
		expect(repoStep.note).toBe("already added");
	});

	it("confirms a 502 during the container build instead of reporting failure", async () => {
		// The build outlives the broker's request timeout. The install itself
		// succeeds, so the only truthful answer comes from polling info.
		const { sendCommand } = supervisor({
			"post /store/repositories": () => ({}),
			"get /store/addons": () => STORE,
			"post /store/addons/b1bff62e_vome/install": () => {
				throw new Error("VomeHome broker responded 502: Bad Gateway");
			},
			"get /addons/b1bff62e_vome/info": () => ({ version: "0.3.41", state: "stopped" }),
			"post /addons/b1bff62e_vome/start": () => ({}),
			"post /addons/b1bff62e_vome/options": () => ({})
		});
		const server = buildHarness({ env: WRITE, ws: { sendCommand } });

		const body = jsonOf(await run(server));
		expect(body.ok).toBe(true);
		const install = body.steps.find((s: any) => s.step === "install");
		expect(install.ok).toBe(true);
		expect(install.note).toMatch(/did not fail/);
	});

	it("still fails when a 502 is followed by the add-on genuinely not being there", async () => {
		const { sendCommand } = supervisor({
			"post /store/repositories": () => ({}),
			"get /store/addons": () => STORE,
			"post /store/addons/b1bff62e_vome/install": () => {
				throw new Error("VomeHome broker responded 502: Bad Gateway");
			},
			"get /addons/b1bff62e_vome/info": () => {
				throw new Error("Addon is not installed");
			}
		});
		const server = buildHarness({ env: WRITE, ws: { sendCommand } });

		const body = jsonOf(await run(server));
		expect(body.ok).toBe(false);
		expect(body.hint).toMatch(/still not installed/);
	});

	it("puts the internet_host protection back after borrowing it", async () => {
		// Leaving the condition ignored is what makes Home Assistant report
		// "Unsupported system — Protections disabled" from then on.
		let installs = 0;
		const { sendCommand } = supervisor({
			"post /store/repositories": () => ({}),
			"get /store/addons": () => STORE,
			"post /store/addons/b1bff62e_vome/install": () => {
				installs += 1;
				if (installs === 1) throw new Error("Supervisor blocked: no host internet");
				return {};
			},
			"post /jobs/options": () => ({}),
			"post /addons/b1bff62e_vome/start": () => ({}),
			"post /addons/b1bff62e_vome/options": () => ({})
		});
		const server = buildHarness({ env: WRITE, ws: { sendCommand } });

		const body = jsonOf(await run(server));
		expect(body.ok).toBe(true);
		expect(body.steps.find((s: any) => s.step === "restore_internet_host").ok).toBe(true);

		const jobCalls = sendCommand.mock.calls
			.map(([command]: any[]) => command)
			.filter((command: any) => command.endpoint === "/jobs/options");
		expect(jobCalls).toHaveLength(2);
		expect(jobCalls[0].data).toEqual({ ignore_conditions: ["internet_host"] });
		expect(jobCalls[1].data).toEqual({ ignore_conditions: [] });
	});

	it("turns on Show in sidebar, or the panel installs invisible", async () => {
		// ingress + panel_title is not enough: "Show in sidebar" is a
		// per-install Supervisor setting that defaults off, and nothing else
		// in the UI links to the panel.
		const { sendCommand } = supervisor({
			"post /store/repositories": () => ({}),
			"get /store/addons": () => STORE,
			"post /store/addons/b1bff62e_vome/install": () => ({}),
			"post /addons/b1bff62e_vome/start": () => ({}),
			"post /addons/b1bff62e_vome/options": () => ({})
		});
		const server = buildHarness({ env: WRITE, ws: { sendCommand } });

		const body = jsonOf(await run(server));
		expect(body.steps.find((s: any) => s.step === "show_in_sidebar").ok).toBe(true);

		const optionCall = sendCommand.mock.calls
			.map(([c]: any[]) => c)
			.find((c: any) => c.endpoint === "/addons/b1bff62e_vome/options");
		expect(optionCall.data).toEqual({ ingress_panel: true });
	});

	it("still reports the install when only the sidebar toggle fails", async () => {
		const { sendCommand } = supervisor({
			"post /store/repositories": () => ({}),
			"get /store/addons": () => STORE,
			"post /store/addons/b1bff62e_vome/install": () => ({}),
			"post /addons/b1bff62e_vome/start": () => ({}),
			"post /addons/b1bff62e_vome/options": () => {
				throw new Error("Supervisor said no");
			}
		});
		const server = buildHarness({ env: WRITE, ws: { sendCommand } });

		const body = jsonOf(await run(server));
		expect(body.ok).toBe(true);
		const step = body.steps.find((s: any) => s.step === "show_in_sidebar");
		expect(step.ok).toBe(false);
		expect(step.note).toMatch(/Show in sidebar/);
	});

	it("restores the protection even when the retried install fails", async () => {
		const { sendCommand } = supervisor({
			"post /store/repositories": () => ({}),
			"get /store/addons": () => STORE,
			"post /store/addons/b1bff62e_vome/install": () => {
				throw new Error("Supervisor blocked: no host internet");
			},
			"post /jobs/options": () => ({})
		});
		const server = buildHarness({ env: WRITE, ws: { sendCommand } });

		const body = jsonOf(await run(server));
		expect(body.ok).toBe(false);
		expect(body.steps.find((s: any) => s.step === "restore_internet_host").ok).toBe(true);
	});
});

describe("ha_camera_image", () => {
	const still = { data: Buffer.from("fake jpeg").toString("base64"), mimeType: "image/jpeg" };

	it("returns the still as image content the model can see, with what it is", async () => {
		const getCameraImage = vi.fn(async () => still);
		const getState = vi.fn(async () => ({
			entity_id: "camera.front_door",
			state: "idle",
			last_updated: "2026-09-30T14:00:00+00:00",
			attributes: { friendly_name: "Front door" }
		}));
		const server = buildHarness({ rest: { getCameraImage, getState } as any });
		const result = await server.call("ha_camera_image", { entity_id: "camera.front_door" });
		expect(getCameraImage).toHaveBeenCalledWith("camera.front_door", 1024);
		expect(result.content[0]).toEqual({ type: "image", data: still.data, mimeType: "image/jpeg" });
		expect((result.content[1] as any).text).toMatch(/Front door .*14:00/);
	});

	it("refuses anything that is not a camera", async () => {
		const getCameraImage = vi.fn();
		const server = buildHarness({ rest: { getCameraImage } as any });
		const result = await server.call("ha_camera_image", { entity_id: "light.hall" });
		expect(result.isError).toBe(true);
		expect(getCameraImage).not.toHaveBeenCalled();
	});

	it("still shows the picture when the caption cannot be read", async () => {
		const server = buildHarness({
			rest: {
				getCameraImage: async () => still,
				getState: async () => {
					throw new Error("state unavailable");
				}
			} as any
		});
		const result = await server.call("ha_camera_image", { entity_id: "camera.door", width: 320 });
		expect(result.content[0]).toMatchObject({ type: "image" });
	});
});

describe("vome health", () => {
	// GamlaBio's sensor on 3 Oct 2026, trimmed: the score is the state, the report is in the attributes.
	const sensor = {
		entity_id: "sensor.vome_vome_health_score",
		state: "75",
		attributes: {
			unit_of_measurement: "/100",
			summary: "GamlaBio is broadly in good order.",
			generated_at: 1789385157,
			categories: [{ id: "flapping", label: "Chatty devices", severity: "warn" }],
			findings: [
				{
					id: "d9e72640",
					category: "flapping",
					severity: "warn",
					title: "7 entities are flooding the recorder",
					recommendation: "Exclude them from the recorder.",
					entities: ["sensor.allrum_motion_motion_gate_2_energy"]
				}
			],
			saved_to_account: true
		}
	};
	const other = { entity_id: "sensor.kitchen_temperature", state: "21", attributes: { unit_of_measurement: "°C" } };

	it("finds the score by what it carries, whatever the entity is called", async () => {
		const server = buildHarness({ rest: { getStates: async () => [other, sensor] } as never });
		const body = jsonOf(await server.call("vome_health_report"));
		expect(body.found).toBe(true);
		expect(body.entity_id).toBe("sensor.vome_vome_health_score");
		expect(body.score).toBe(75);
		expect(body.generated_at).toMatch(/^2026-/);
		expect(body.findings[0].title).toBe("7 entities are flooding the recorder");
	});

	it("says how to get one when the home has none", async () => {
		const server = buildHarness({ rest: { getStates: async () => [other] } as never });
		const body = jsonOf(await server.call("vome_health_report"));
		expect(body.found).toBe(false);
		expect(body.note).toMatch(/vome_health_check/);
	});

	it("fetches a forgotten report back when the sensor is there but empty", async () => {
		// GamlaBio, 17–20 Oct 2026: HA restarted, the sensor sat on "unavailable",
		// and the tool said the home had no score while Vome held one.
		const emptySensor = { entity_id: "sensor.vome_vome_health_score", state: "unavailable", attributes: { unit_of_measurement: "/100" } };
		const calls: string[] = [];
		const rest = {
			getStates: async () => [other, emptySensor],
			callService: async (domain: string, service: string) => {
				calls.push(`${domain}.${service}`);
				return { service_response: { report: sensor.attributes, saved_to_account: true, health_url: "https://vome.io/h" } };
			}
		} as never;
		const body = jsonOf(await buildHarness({ rest }).call("vome_health_report"));
		expect(calls).toEqual(["vomesync.health_score_get"]);
		expect(body.found).toBe(true);
		expect(body.findings[0].title).toBe("7 entities are flooding the recorder");
		expect(body.health_url).toBe("https://vome.io/h");
		expect(body.note).toMatch(/restart/);
	});

	it("says the sensor is empty, not that there is no score, when Vome cannot be asked", async () => {
		const emptySensor = { entity_id: "sensor.vome_vome_health_score", state: "unavailable", attributes: {} };
		const rest = {
			getStates: async () => [emptySensor],
			callService: async () => {
				throw new Error("502");
			}
		} as never;
		const body = jsonOf(await buildHarness({ rest }).call("vome_health_report"));
		expect(body.found).toBe(false);
		expect(body.entity_id).toBe("sensor.vome_vome_health_score");
		expect(body.note).toMatch(/restarted/);
	});

	it("runs a check through the integration's own action, and only with write access", async () => {
		const calls: string[] = [];
		const rest = {
			getStates: async () => [sensor],
			callService: async (domain: string, service: string) => {
				calls.push(`${domain}.${service}`);
				return [];
			}
		} as never;
		const refused = await buildHarness({ rest }).call("vome_health_check");
		expect(refused.isError).toBe(true);
		const body = jsonOf(await buildHarness({ env: { HA_ALLOW_WRITE: "true" }, rest }).call("vome_health_check"));
		expect(calls).toEqual(["vomesync.health_score_run"]);
		expect(body.previous_score).toBe(75);
	});
});

describe("ha_get_state", () => {
	it("reads several entities with one request, not one each", async () => {
		let single = 0;
		let all = 0;
		const states = ["light.a", "light.b", "light.c"].map((id) => ({ entity_id: id, state: "on", attributes: {} }));
		const rest = {
			getState: async () => {
				single += 1;
				return states[0];
			},
			getStates: async () => {
				all += 1;
				return states;
			}
		} as never;
		const body = jsonOf(await buildHarness({ rest }).call("ha_get_state", { entity_ids: ["light.a", "light.b", "light.c", "light.gone"] }));
		expect([single, all]).toEqual([0, 1]);
		expect(body.entities.map((e: { found: boolean }) => e.found)).toEqual([true, true, true, false]);
		jsonOf(await buildHarness({ rest }).call("ha_get_state", { entity_ids: ["light.a"] }));
		expect(single).toBe(1);
	});
});

describe("ha_camera_frame", () => {
	it("returns a camera still as a small grid of RGB pixels", async () => {
		const data = Buffer.alloc(640 * 360 * 4, 128);
		const jpg = (await import("jpeg-js")).default.encode({ data, width: 640, height: 360 }, 90).data.toString("base64");
		const rest = { getCameraImage: async () => ({ data: jpg, mimeType: "image/jpeg" }) } as never;
		const body = jsonOf(await buildHarness({ rest }).call("ha_camera_frame", { entity_id: "camera.anasmotet_sydvast", width: 72, height: 48 }));
		expect([body.width, body.height]).toEqual([72, 41]);
		expect(Buffer.from(body.rgb, "base64").length).toBe(72 * 41 * 3);
	});
});

describe("ha_get_history max_points", () => {
	it("answers a chart with a few points per entity, not thousands of states", async () => {
		const states = Array.from({ length: 4000 }, (_, i) => ({ entity_id: i === 0 ? "sensor.kitchen_temperature" : undefined, state: String(20 + (i % 10) / 10), last_changed: `2026-10-03T${String(i).padStart(6, "0")}`, attributes: i === 0 ? { unit_of_measurement: "°C" } : undefined }));
		const rest = { getHistory: async () => [states] } as never;
		const body = jsonOf(await buildHarness({ rest }).call("ha_get_history", { entity_ids: ["sensor.kitchen_temperature"], max_points: 120 }));
		expect(body.series[0].entity_id).toBe("sensor.kitchen_temperature");
		expect(body.series[0].unit).toBe("°C");
		expect(body.series[0].points.length).toBe(120);
	});
});

describe("ha_view_snapshot", () => {
	it("answers a whole view in one call, and a failing part in its place", async () => {
		let reads = 0;
		const states = [
			{ entity_id: "light.kitchen_2", state: "on", attributes: { brightness: 178 } },
			{ entity_id: "sensor.kitchen_temperature", state: "21.03", attributes: { unit_of_measurement: "°C" } }
		];
		const rest = {
			getStates: async () => {
				reads += 1;
				return states;
			},
			renderTemplate: async (t: string) => (t.includes("boom") ? Promise.reject(new Error("TemplateError")) : "Right now: forage"),
			getHistory: async () => [[{ entity_id: "sensor.kitchen_temperature", state: "20", attributes: { unit_of_measurement: "°C" } }, { state: "22" }]],
			getCameraImage: async () => Promise.reject(new Error("403: Cameras not ticked"))
		} as never;
		const body = jsonOf(
			await buildHarness({ rest }).call("ha_view_snapshot", {
				entity_ids: ["light.kitchen_2", "sensor.kitchen_temperature", "light.gone"],
				templates: { md1: "{{ states('sensor.housefly_mode') }}", md2: "{{ boom }}" },
				history: [{ key: "g1", entity_ids: ["sensor.kitchen_temperature"], hours: 12, max_points: 50 }],
				frames: [{ key: "cam", entity_id: "camera.anasmotet_sydvast", width: 72, height: 72 }]
			})
		);
		expect(reads).toBe(1);
		expect(body.states["light.kitchen_2"].state).toBe("on");
		expect(body.states["light.gone"]).toBe(null);
		expect(body.templates.md1).toBe("Right now: forage");
		expect(body.templates.md2.error).toMatch(/TemplateError/);
		expect(body.history.g1[0].points.map((p: [string, number]) => p[1])).toEqual([20, 22]);
		expect(body.frames.cam.error).toMatch(/Cameras/);
	});
});

describe("ha_watch_states", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("starts a watch through the portal, then waits on it: the whole picture first, then changes", async () => {
		const grants: Array<{ ids: string[]; jobId?: string }> = [];
		const rest = {
			startStateWatch: async (ids: string[], jobId?: string) => {
				grants.push({ ids, jobId });
				return { job_id: "job-1", token: "tok", read_url: "https://sync.vome.io/api/watch/job-1", expires_at: Math.floor(Date.now() / 1000) + 600, entity_ids: ids };
			}
		} as never;
		const reads: string[] = [];
		vi.stubGlobal("fetch", async (url: string, init: { headers: Record<string, string> }) => {
			reads.push(`${url} ${init.headers.Authorization}`);
			const cursor = Number(new URL(url).searchParams.get("cursor"));
			const body = cursor === 0
				? { cursor: 2, full: true, states: [{ entity_id: "light.kitchen_2", state: "on" }], done: false, error: null }
				: { cursor: 3, full: false, states: [{ entity_id: "light.kitchen_2", state: "off" }], done: false, error: null };
			return new Response(JSON.stringify(body), { status: 200 });
		});
		const server = buildHarness({ rest });
		const first = jsonOf(await server.call("ha_watch_states", { entity_ids: ["light.kitchen_2"], wait_seconds: 0 }));
		const second = jsonOf(await server.call("ha_watch_states", { entity_ids: ["light.kitchen_2"], wait_seconds: 5 }));
		expect(first.full).toBe(true);
		expect(second.states[0].state).toBe("off");
		expect(grants.length).toBe(1);
		expect(reads[1]).toBe("https://sync.vome.io/api/watch/job-1?cursor=2&wait=5 Bearer tok");
	});

	it("starts afresh when the watch has ended", async () => {
		let n = 0;
		const rest = {
			startStateWatch: async (ids: string[]) => ({ job_id: `job-${++n}`, token: "tok", read_url: `https://sync.vome.io/api/watch/job-${n}`, expires_at: Math.floor(Date.now() / 1000) + 600, entity_ids: ids })
		} as never;
		vi.stubGlobal("fetch", async (url: string) =>
			url.includes("job-1") ? new Response("{}", { status: 404 }) : new Response(JSON.stringify({ cursor: 1, full: true, states: [], done: false, error: null }), { status: 200 })
		);
		const body = jsonOf(await buildHarness({ rest }).call("ha_watch_states", { entity_ids: ["light.a"], wait_seconds: 0 }));
		expect(n).toBe(2);
		expect(body.full).toBe(true);
	});
});

describe("ha_watch_states falls back to polling", () => {
	afterEach(() => vi.useRealTimers());

	const noRelay = () => {
		throw new HaApiError("VomeHome broker POST /watch failed: HTTP 404", 404, '{"error":"No relay connection for this server."}');
	};

	function polledHome(initial: Record<string, string>) {
		const states = { ...initial };
		const getState = vi.fn(async (entityId: string) => {
			if (!(entityId in states)) throw new HaApiError("not found", 404, "");
			return { entity_id: entityId, state: states[entityId], attributes: {} };
		});
		const startStateWatch = vi.fn(async () => noRelay());
		return { states, rest: { startStateWatch, getState } as never, getState, startStateWatch };
	}

	it("polls when the home has no Vome component to send changes, in the live watch's shape", async () => {
		const home = polledHome({ "light.a": "on" });
		const body = jsonOf(await buildHarness({ rest: home.rest }).call("ha_watch_states", { entity_ids: ["light.a", "light.gone"], wait_seconds: 0 }));
		expect(body.mode).toBe("polling");
		expect(body.full).toBe(true);
		expect(body.states).toEqual([{ entity_id: "light.a", state: "on", attributes: {} }]);
		expect(body.missing).toEqual(["light.gone"]);
		expect(body.note).toMatch(/No relay connection/);
		expect(typeof body.cursor).toBe("number");
		expect(body.done).toBe(false);
		expect(body.error).toBe(null);
	});

	it("does not poll around a refusal: 403 surfaces", async () => {
		const getState = vi.fn();
		const rest = {
			startStateWatch: async () => {
				throw new HaApiError("VomeHome broker POST /watch failed: HTTP 403", 403, '{"error":"No relay connection; key lacks ha:read"}');
			},
			getState
		} as never;
		const result = await buildHarness({ rest }).call("ha_watch_states", { entity_ids: ["light.a"], wait_seconds: 0 });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/403/);
		expect(getState).not.toHaveBeenCalled();
	});

	it("does not poll around a restart either", async () => {
		const rest = {
			startStateWatch: async () => {
				throw new HaRestartingError("Home Assistant is not answering (no relay connection)", null, "x");
			},
			getState: vi.fn()
		} as never;
		const result = await buildHarness({ rest }).call("ha_watch_states", { entity_ids: ["light.a"], wait_seconds: 0 });
		expect(result.isError).toBe(true);
	});

	it("waits for a change, reading every few seconds, and returns only what changed", async () => {
		vi.useFakeTimers();
		const home = polledHome({ "light.a": "on", "light.b": "off" });
		const server = buildHarness({ rest: home.rest });
		const first = jsonOf(await server.call("ha_watch_states", { entity_ids: ["light.a", "light.b"], wait_seconds: 0 }));
		expect(first.full).toBe(true);

		const pending = server.call("ha_watch_states", { entity_ids: ["light.a", "light.b"], wait_seconds: 20, cursor: first.cursor });
		await vi.advanceTimersByTimeAsync(3_000);
		await vi.advanceTimersByTimeAsync(3_000);
		home.states["light.b"] = "on";
		await vi.advanceTimersByTimeAsync(3_000);
		const second = jsonOf(await pending);
		expect(second.full).toBe(false);
		expect(second.states).toEqual([{ entity_id: "light.b", state: "on", attributes: {} }]);
		expect(second.cursor).toBeGreaterThan(first.cursor);
		// One read for the baseline, then one per ~3 s until the change.
		expect(home.getState.mock.calls.length).toBeLessThanOrEqual(2 + 2 * 4);
		// Only one attempt at the live watch: polling sticks for a while.
		expect(home.startStateWatch).toHaveBeenCalledTimes(1);
	});

	it("gives up waiting at wait_seconds with no changes and the same cursor", async () => {
		vi.useFakeTimers();
		const home = polledHome({ "light.a": "on" });
		const server = buildHarness({ rest: home.rest });
		const first = jsonOf(await server.call("ha_watch_states", { entity_ids: ["light.a"], wait_seconds: 0 }));
		const pending = server.call("ha_watch_states", { entity_ids: ["light.a"], wait_seconds: 5, cursor: first.cursor });
		await vi.advanceTimersByTimeAsync(6_000);
		const second = jsonOf(await pending);
		expect(second).toMatchObject({ full: false, states: [], cursor: first.cursor, mode: "polling" });
	});

	it("round-trips the cursor: an older one gets every change since, a foreign one the whole picture", async () => {
		vi.useFakeTimers();
		const home = polledHome({ "light.a": "on", "light.b": "off" });
		const server = buildHarness({ rest: home.rest });
		const ids = ["light.a", "light.b"];
		const first = jsonOf(await server.call("ha_watch_states", { entity_ids: ids, wait_seconds: 0 }));
		await vi.advanceTimersByTimeAsync(1_000);
		home.states["light.a"] = "off";
		const second = jsonOf(await server.call("ha_watch_states", { entity_ids: ids, wait_seconds: 0, cursor: first.cursor }));
		expect(second.states.map((s: { entity_id: string }) => s.entity_id)).toEqual(["light.a"]);
		await vi.advanceTimersByTimeAsync(1_000);
		home.states["light.b"] = "on";
		const third = jsonOf(await server.call("ha_watch_states", { entity_ids: ids, wait_seconds: 0, cursor: second.cursor }));
		expect(third.states.map((s: { entity_id: string }) => s.entity_id)).toEqual(["light.b"]);
		// The first cursor again: both changes since it.
		const again = jsonOf(await server.call("ha_watch_states", { entity_ids: ids, wait_seconds: 0, cursor: first.cursor }));
		expect(again.full).toBe(false);
		expect(again.states.map((s: { entity_id: string }) => s.entity_id)).toEqual(["light.a", "light.b"]);
		// A live watch's small cursor is not one polling handed out: the whole picture.
		const foreign = jsonOf(await server.call("ha_watch_states", { entity_ids: ids, wait_seconds: 0, cursor: 3 }));
		expect(foreign.full).toBe(true);
		expect(foreign.states).toHaveLength(2);
	});
});

describe("ha_delete_config_file", () => {
	const BROKERED = {
		HA_TOKEN: "",
		VOMEHOME_TOKEN: "vh_test",
		VOMEHOME_INSTANCE_ID: "rly-1",
		HA_ALLOW_WRITE: "true",
		HA_ALLOW_CONFIG_WRITE: "true"
	};

	it("refuses, without deleting, when the named home is not the one selected", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const server = buildHarness({ env: BROKERED });
		const result = await server.call("ha_delete_config_file", { instance_id: "the-demo-vm", path: "x.yaml" });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("Nothing was deleted");
		expect(fetchMock).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});

	it("refuses without config-write, before reaching the network", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const server = buildHarness({ env: { ...BROKERED, HA_ALLOW_CONFIG_WRITE: "false" } });
		const result = await server.call("ha_delete_config_file", { instance_id: "rly-1", path: "x.yaml" });
		expect(result.isError).toBe(true);
		expect(fetchMock).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});

	it("posts the delete for the named file", async () => {
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ path: "packages/old.yaml", deleted: true }), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const server = buildHarness({ env: BROKERED });
		const result = await server.call("ha_delete_config_file", { instance_id: "rly-1", path: "packages/old.yaml" });
		expect(result.isError).toBeFalsy();
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toContain("/instances/rly-1/ha/files/delete?path=packages%2Fold.yaml");
		expect(init.method).toBe("POST");
		expect(jsonOf(result)).toMatchObject({ deleted: true });
		vi.unstubAllGlobals();
	});

	it("says to update the add-on when the home's component predates deletion", async () => {
		vi.stubGlobal("fetch", vi.fn(async () =>
			new Response(JSON.stringify({ error: "Refusing a non-allowlisted file operation." }), { status: 502 })
		));
		const server = buildHarness({ env: BROKERED });
		const result = await server.call("ha_delete_config_file", { instance_id: "rly-1", path: "x.yaml" });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("0.3.55");
		vi.unstubAllGlobals();
	});
});

describe("open-ended history and logbook windows", () => {
	/* "Since Monday" came back as Monday only: given a start and no end, Home
	   Assistant stops 24 hours after the start, and nothing said so. */
	it("ends a window that has a start at now, and leaves an explicit end alone", async () => {
		const getHistory = vi.fn(async () => []);
		const getLogbook = vi.fn(async () => []);
		const server = buildHarness({ rest: { getHistory, getLogbook } as any });
		const before = Date.now();

		await server.call("ha_get_history", { entity_ids: ["sensor.x"], start_time: "2026-09-28T00:00:00Z" });
		const end = Date.parse((getHistory.mock.calls[0] as any)[0].endTime);
		expect(end).toBeGreaterThanOrEqual(before - 1000);

		await server.call("ha_get_logbook", { start_time: "2026-09-28T00:00:00Z" });
		expect(Date.parse((getLogbook.mock.calls[0] as any)[0].endTime)).toBeGreaterThanOrEqual(before - 1000);

		await server.call("ha_get_history", { entity_ids: ["sensor.x"], start_time: "2026-09-28T00:00:00Z", end_time: "2026-09-29T00:00:00Z" });
		expect((getHistory.mock.calls[1] as any)[0].endTime).toBe("2026-09-29T00:00:00Z");

		await server.call("ha_get_history", { entity_ids: ["sensor.x"] });
		expect((getHistory.mock.calls[2] as any)[0].endTime).toBeUndefined();
	});
});

describe("ha_get_logbook filters and limit", () => {
	/* A night on GamlaBio came back as about 100k rows, with no way to ask for
	   only the Vome entries or only what mentioned a word. */
	const night = [
		...Array.from({ length: 2000 }, (_, i) => ({
			when: new Date(Date.UTC(2026, 9, 31, 22, 0, i)).toISOString(),
			name: "Hall sensor",
			message: "detected motion",
			entity_id: "binary_sensor.hall",
			domain: "binary_sensor"
		})),
		{ when: "2026-10-31T23:30:00.000Z", name: "Vome", message: "changed configuration.yaml", domain: "vomesync" },
		{ when: "2026-10-31T23:40:00.000Z", name: "Night heat", message: "triggered by time", entity_id: "automation.night_heat" }
	];

	it("bounds the reply to the newest entries and says where to continue", async () => {
		const getLogbook = vi.fn(async () => night);
		const server = buildHarness({ rest: { getLogbook } as any });

		const body = jsonOf(await server.call("ha_get_logbook", { start_time: "2026-10-31T22:00:00Z", end_time: "2026-11-01T00:00:00Z", limit: 10 }));
		expect(body.count).toBe(10);
		expect(body.count_before_limit).toBe(2002);
		expect(body.fetched).toBe(2002);
		expect(body.truncated).toBe(true);
		expect(body.entries[9].name).toBe("Night heat");
		expect(body.entries[0].when < body.entries[9].when).toBe(true);
		expect(body.older_entries_end_time).toBe(body.entries[0].when);
		expect(body.note).toMatch(/1992 older matching entries/);
	});

	it("defaults to 500 entries", async () => {
		const getLogbook = vi.fn(async () => night);
		const server = buildHarness({ rest: { getLogbook } as any });
		const body = jsonOf(await server.call("ha_get_logbook", {}));
		expect(body.count).toBe(500);
		expect(body.truncated).toBe(true);
	});

	it("filters by name, domain and text", async () => {
		const getLogbook = vi.fn(async () => night);
		const server = buildHarness({ rest: { getLogbook } as any });

		const vome = jsonOf(await server.call("ha_get_logbook", { name: "vome" }));
		expect(vome.entries.map((e: any) => e.message)).toEqual(["changed configuration.yaml"]);
		expect(vome.truncated).toBe(false);
		expect(vome.older_entries_end_time).toBeUndefined();

		// No domain field: taken from the entity_id.
		const automations = jsonOf(await server.call("ha_get_logbook", { domain: "automation" }));
		expect(automations.entries.map((e: any) => e.name)).toEqual(["Night heat"]);

		const text = jsonOf(await server.call("ha_get_logbook", { contains: "CONFIGURATION" }));
		expect(text.count).toBe(1);
		const byEntity = jsonOf(await server.call("ha_get_logbook", { contains: "night_heat" }));
		expect(byEntity.count).toBe(1);
	});
});

describe("ha_get_logbook reads a day at a time", () => {
	const HOUR = 3600_000;
	const at = (ms: number) => new Date(ms).toISOString();
	const START = Date.parse("2026-11-01T00:00:00.000Z");
	// Nov 1 to the last minute of Nov 3: three days. (Exactly 72 h takes four
	// reads: Home Assistant's window is open at both ends, so reads overlap.)
	const END = START + 72 * HOUR - 60_000;
	// One entry every hour on the hour, plus one exactly on each 24 h mark, with
	// Home Assistant answering inclusively at both edges (the worst case for
	// duplicates) from this log.
	const log = Array.from({ length: 72 }, (_, i) => ({
		when: at(START + i * HOUR),
		name: i % 2 === 0 ? "Vome" : "Hall",
		message: `entry ${i}`,
		entity_id: i % 2 === 0 ? "sensor.vome" : "binary_sensor.hall"
	}));
	function home(entries = log) {
		const asked: Array<{ startTime?: string; endTime?: string }> = [];
		const getLogbook = vi.fn(async (params: { startTime?: string; endTime?: string }) => {
			asked.push(params);
			const from = Date.parse(params.startTime as string);
			const to = Date.parse(params.endTime as string);
			return entries.filter((e) => Date.parse(e.when) >= from && Date.parse(e.when) <= to);
		});
		return { getLogbook, asked, server: buildHarness({ rest: { getLogbook } as any }) };
	}

	it("makes 3 requests for 3 days, newest first, none longer than 24 hours", async () => {
		const { asked, server } = home();
		const body = jsonOf(await server.call("ha_get_logbook", { start_time: at(START), end_time: at(END) }));
		expect(asked).toHaveLength(3);
		expect(asked[0]!.endTime).toBe(at(END));
		expect(asked[2]!.startTime).toBe(at(START));
		for (const [i, a] of asked.entries()) {
			expect(Date.parse(a.endTime!) - Date.parse(a.startTime!)).toBeLessThanOrEqual(24 * HOUR);
			if (i > 0) expect(Date.parse(a.endTime!)).toBeLessThan(Date.parse(asked[i - 1]!.endTime!));
		}
		// Every entry once, in time order: the overlapping edges neither drop nor repeat.
		expect(body.count).toBe(72);
		expect(body.entries.map((e: any) => e.message)).toEqual(log.map((e) => e.message));
		expect(body.requests).toBe(3);
		expect(body.truncated).toBe(false);

		// Exactly 72 hours: four reads, each under a day, because they must overlap.
		const exact = logbookChunks(at(START), at(START + 72 * HOUR))!.chunks;
		expect(exact).toHaveLength(4);
		for (const c of exact) expect(Date.parse(c.endTime!) - Date.parse(c.startTime!)).toBeLessThan(24 * HOUR);
	});

	it("does not lose or repeat an entry sitting on a chunk edge, whichever way HA treats edges", async () => {
		const edges: Array<{ when: string; message: string }> = [];
		const probe = home();
		await probe.server.call("ha_get_logbook", { start_time: at(START), end_time: at(END) });
		// Entries exactly at, just before and just after every edge any request had.
		for (const a of probe.asked) {
			for (const t of [Date.parse(a.startTime!), Date.parse(a.endTime!)]) {
				for (const d of [-1, 0, 1]) edges.push({ when: at(t + d), message: `edge ${t + d}` });
			}
		}
		const unique = [...new Map(edges.map((e) => [e.when, e])).values()].sort((a, b) => a.when.localeCompare(b.when));
		const exclusive = vi.fn(async (params: { startTime?: string; endTime?: string }) => {
			const from = Date.parse(params.startTime as string);
			const to = Date.parse(params.endTime as string);
			return unique.filter((e) => Date.parse(e.when) > from && Date.parse(e.when) < to);
		});
		const body = jsonOf(await buildHarness({ rest: { getLogbook: exclusive } as any }).call("ha_get_logbook", { start_time: at(START), end_time: at(END) }));
		const inside = unique.filter((e) => Date.parse(e.when) > START && Date.parse(e.when) < END);
		expect(body.entries.map((e: any) => e.when)).toEqual(inside.map((e) => e.when));
	});

	it("stops as soon as the limit is reached, keeping the newest", async () => {
		const { asked, server } = home();
		const body = jsonOf(await server.call("ha_get_logbook", { start_time: at(START), end_time: at(END), limit: 5 }));
		expect(asked).toHaveLength(1);
		expect(body.count).toBe(5);
		expect(body.entries.map((e: any) => e.message)).toEqual(["entry 67", "entry 68", "entry 69", "entry 70", "entry 71"]);
		expect(body.truncated).toBe(true);
		expect(body.older_entries_end_time).toBe(at(START + 67 * HOUR));
		expect(body.note).toMatch(/Stopped after 1 of 3/);
	});

	it("applies the filters in every chunk and keeps reading until enough match", async () => {
		const { asked, server } = home();
		const body = jsonOf(await server.call("ha_get_logbook", { start_time: at(START), end_time: at(END), name: "vome", limit: 20 }));
		// 12-13 Vome entries a day: a second day is needed for 20.
		expect(asked).toHaveLength(2);
		expect(body.count).toBe(20);
		expect(body.entries.every((e: any) => e.name === "Vome")).toBe(true);
		expect(body.entries.at(-1).message).toBe("entry 70");
		expect(body.entries.map((e: any) => e.when)).toEqual([...body.entries.map((e: any) => e.when)].sort());

		const few = jsonOf(await server.call("ha_get_logbook", { start_time: at(START), end_time: at(END), contains: "entry 3" }));
		// entry 3, entry 30..39: in two different days.
		expect(few.entries.map((e: any) => e.message)).toEqual(["entry 3", ...Array.from({ length: 10 }, (_, i) => `entry ${30 + i}`)]);
		expect(few.truncated).toBe(false);
	});

	it("reads at most 31 days and says where it stopped", async () => {
		const { asked, server } = home([]);
		const body = jsonOf(await server.call("ha_get_logbook", { start_time: at(START - 60 * 24 * HOUR), end_time: at(END) }));
		expect(asked).toHaveLength(31);
		expect(body.truncated).toBe(true);
		expect(body.note).toMatch(/longer than 31 days/);
		expect(Date.parse(body.older_entries_end_time)).toBe(Date.parse(asked[30]!.startTime!) + 1);
	});

	it("leaves a window of a day or less, and one with no start, as one request", async () => {
		const { asked, server } = home();
		await server.call("ha_get_logbook", { start_time: at(START), end_time: at(START + 24 * HOUR) });
		await server.call("ha_get_logbook", {});
		expect(asked).toHaveLength(2);
		expect(asked[0]).toMatchObject({ startTime: at(START), endTime: at(START + 24 * HOUR) });
		expect(asked[1]!.startTime).toBeUndefined();
	});
});

describe("scripts", () => {
	const WRITE = { HA_ALLOW_WRITE: "true", HA_ALLOW_CONFIG_WRITE: "true" };

	it("reads, saves and deletes by id, accepting script.<id>", async () => {
		const rest = {
			getScriptConfig: vi.fn(async () => ({ alias: "Raise heat", sequence: [] })),
			upsertScriptConfig: vi.fn(async () => ({ result: "ok" })),
			deleteScriptConfig: vi.fn(async () => ({ result: "ok" }))
		};
		const server = buildHarness({ env: WRITE, rest: rest as any });
		expect(jsonOf(await server.call("ha_get_script", { script: "script.raise_heat" }))).toMatchObject({ id: "raise_heat" });
		await server.call("ha_set_script", { script_id: "raise_heat", config: { alias: "Raise heat", sequence: [] } });
		expect(rest.upsertScriptConfig).toHaveBeenCalledWith("raise_heat", { alias: "Raise heat", sequence: [] });
		await server.call("ha_delete_script", { script_id: "script.raise_heat" });
		expect(rest.deleteScriptConfig).toHaveBeenCalledWith("raise_heat");
	});

	it("refuses writes without config-write, and ids that are not slugs", async () => {
		const upsertScriptConfig = vi.fn();
		const readOnly = buildHarness({ rest: { upsertScriptConfig } as any });
		expect((await readOnly.call("ha_set_script", { script_id: "x", config: {} })).isError).toBe(true);
		const writer = buildHarness({ env: WRITE, rest: { upsertScriptConfig } as any });
		expect((await writer.call("ha_set_script", { script_id: "Raise-Heat", config: {} })).isError).toBe(true);
		expect(upsertScriptConfig).not.toHaveBeenCalled();
	});
});

describe("entity registry edits and Matter re-interview", () => {
	const WRITE = { HA_ALLOW_WRITE: "true", HA_ALLOW_CONFIG_WRITE: "true" };

	it("sends only the fields given, mapping disabled/hidden to 'user'", async () => {
		const sendCommand = vi.fn(async () => ({ entity_entry: { entity_id: "sensor.kitchen" } }));
		const server = buildHarness({ env: WRITE, ws: { sendCommand } });
		await server.call("ha_update_entity", { entity_id: "sensor.kitchen_temp", name: null, disabled: true, area_id: "kitchen" });
		expect(sendCommand).toHaveBeenCalledWith({
			type: "config/entity_registry/update",
			entity_id: "sensor.kitchen_temp",
			name: null,
			area_id: "kitchen",
			disabled_by: "user"
		});
		await server.call("ha_update_entity", { entity_id: "sensor.kitchen_temp", hidden: false });
		expect(sendCommand).toHaveBeenLastCalledWith({ type: "config/entity_registry/update", entity_id: "sensor.kitchen_temp", hidden_by: null });
	});

	it("refuses a rename across domains, an empty change, and anything without config-write", async () => {
		const sendCommand = vi.fn();
		const server = buildHarness({ env: WRITE, ws: { sendCommand } });
		expect((await server.call("ha_update_entity", { entity_id: "sensor.a", new_entity_id: "switch.a" })).isError).toBe(true);
		expect((await server.call("ha_update_entity", { entity_id: "sensor.a" })).isError).toBe(true);
		const readOnly = buildHarness({ ws: { sendCommand } });
		expect((await readOnly.call("ha_remove_entity", { entity_id: "sensor.a" })).isError).toBe(true);
		expect((await readOnly.call("ha_matter_reinterview", { device_id: "d1" })).isError).toBe(true);
		expect(sendCommand).not.toHaveBeenCalled();
	});

	it("removes an entry and re-interviews a Matter device by HA device id", async () => {
		const sendCommand = vi.fn(async () => ({}));
		const server = buildHarness({ env: WRITE, ws: { sendCommand } });
		await server.call("ha_remove_entity", { entity_id: "automation.old_one" });
		expect(sendCommand).toHaveBeenCalledWith({ type: "config/entity_registry/remove", entity_id: "automation.old_one" });
		await server.call("ha_matter_reinterview", { device_id: "abc123" });
		expect(sendCommand).toHaveBeenLastCalledWith({ type: "matter/interview_node", device_id: "abc123" });
	});
});

describe("ha_edit_config_file", () => {
	const BROKERED = {
		HA_TOKEN: "",
		VOMEHOME_TOKEN: "vh_test",
		VOMEHOME_INSTANCE_ID: "rly-1",
		HA_ALLOW_WRITE: "true",
		HA_ALLOW_CONFIG_WRITE: "true"
	};
	const FILE = "- id: a\n  alias: Morning\n- id: b\n  alias: Evening\n";

	function relay(onWrite: (content: string) => void) {
		return vi.fn(async (input: unknown, init?: any) => {
			const url = String(input);
			if (url.includes("/files/read")) return new Response(JSON.stringify({ content: FILE }), { status: 200 });
			onWrite(JSON.parse(init.body).content);
			return new Response(JSON.stringify({ written: true }), { status: 200 });
		});
	}

	it("applies exact edits and writes the result once", async () => {
		const writes: string[] = [];
		vi.stubGlobal("fetch", relay((c) => writes.push(c)));
		const server = buildHarness({ env: BROKERED, rest: { checkConfig: async () => ({ result: "valid" }) } as any });
		const result = await server.call("ha_edit_config_file", {
			instance_id: "rly-1",
			path: "automations.yaml",
			edits: [{ old_text: "alias: Evening", new_text: "alias: Night" }]
		});
		expect(result.isError).toBeFalsy();
		expect(writes).toEqual([FILE.replace("alias: Evening", "alias: Night")]);
		vi.unstubAllGlobals();
	});

	it("writes nothing when an edit matches nothing or more than once", async () => {
		const writes: string[] = [];
		vi.stubGlobal("fetch", relay((c) => writes.push(c)));
		const server = buildHarness({ env: BROKERED });
		for (const old_text of ["alias: Noon", "  alias: "]) {
			const result = await server.call("ha_edit_config_file", {
				instance_id: "rly-1", path: "automations.yaml",
				edits: [{ old_text: "alias: Morning", new_text: "alias: Dawn" }, { old_text, new_text: "x" }]
			});
			expect(result.isError).toBe(true);
		}
		expect(writes).toEqual([]);
		vi.unstubAllGlobals();
	});

	it("puts the file back when the edit breaks the configuration", async () => {
		const writes: string[] = [];
		vi.stubGlobal("fetch", relay((c) => writes.push(c)));
		let checks = 0;
		const server = buildHarness({
			env: BROKERED,
			rest: { checkConfig: async () => (checks++ === 0 ? { result: "invalid", errors: "bad" } : { result: "valid" }) } as any
		});
		const result = await server.call("ha_edit_config_file", {
			instance_id: "rly-1", path: "automations.yaml",
			edits: [{ old_text: "alias: Evening", new_text: "alias: [broken" }]
		});
		expect(jsonOf(result)).toMatchObject({ rolled_back: true });
		expect(writes.at(-1)).toBe(FILE);
		vi.unstubAllGlobals();
	});
});

describe("ha_supervisor_api: logs and slow calls (16 Oct gap notes)", () => {
	const WRITE = { HA_ALLOW_WRITE: "true", HA_ALLOW_CONFIG_WRITE: "true" };

	it("reads a log endpoint through the log route, not supervisor/api", async () => {
		const sendCommand = vi.fn();
		const getSupervisorLog = vi.fn(async () => "line one\nline two\n");
		const server = buildHarness({ ws: { sendCommand }, rest: { getSupervisorLog } });
		const result = await server.call("ha_supervisor_api", { endpoint: "/addons/core_mosquitto/logs" });
		expect(result.isError).toBeFalsy();
		expect(getSupervisorLog).toHaveBeenCalledWith("addon", "core_mosquitto");
		expect(sendCommand).not.toHaveBeenCalled();
		await server.call("ha_supervisor_api", { endpoint: "/core/logs" });
		expect(getSupervisorLog).toHaveBeenLastCalledWith("core", undefined);
		const follow = await server.call("ha_supervisor_api", { endpoint: "/addons/core_mosquitto/logs/follow" });
		expect(follow.isError).toBe(true);
		expect(sendCommand).not.toHaveBeenCalled();
	});

	it("asks Home Assistant to wait longer for an add-on stop, and only then", async () => {
		const sendCommand = vi.fn(async () => ({ result: "ok" }));
		const server = buildHarness({ env: WRITE, ws: { sendCommand } });
		await server.call("ha_supervisor_api", { endpoint: "/addons/core_mosquitto/stop", method: "post" });
		expect(sendCommand).toHaveBeenLastCalledWith({
			type: "supervisor/api",
			endpoint: "/addons/core_mosquitto/stop",
			method: "post",
			timeout: SLOW_SUPERVISOR_TIMEOUT_SECONDS
		});
		await server.call("ha_supervisor_api", { endpoint: "/addons" });
		expect(sendCommand).toHaveBeenLastCalledWith({ type: "supervisor/api", endpoint: "/addons", method: "get" });
		await server.call("ha_supervisor_api", { endpoint: "/addons/x/options", method: "post", data: {}, timeout_seconds: 30 });
		expect(sendCommand).toHaveBeenLastCalledWith({
			type: "supervisor/api", endpoint: "/addons/x/options", method: "post", data: {}, timeout: 30
		});
	});

	it("says where the add-on stands when a stop still times out", async () => {
		const sendCommand = vi.fn(async (command: Record<string, unknown>) => {
			if (String(command.endpoint).endsWith("/stop")) {
				throw new Error('VomeHome broker POST /ws/command responded 502: {"error": {"code": "unknown_error"}}');
			}
			return { state: "stopped" };
		});
		const server = buildHarness({ env: WRITE, ws: { sendCommand } });
		const result = await server.call("ha_supervisor_api", { endpoint: "/addons/a0d7b954_nodered/stop", method: "post" });
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain('\\"stopped\\"');
	});

	it("hides passwords and tokens in replies, keeping the keys and empty values (3 Nov: /discovery)", async () => {
		const sendCommand = vi.fn(async () => ({
			discovery: [
				{ addon: "core_mosquitto", service: "mqtt", config: { host: "core-mosquitto", port: 1883, username: "homeassistant", password: "hunter2" } },
				{ addon: "d5369777_music_assistant", service: "music_assistant", config: { host: "ma", auth_token: "eyJ.abc" } },
				{ addon: "5c53de3b_esphome", service: "mcp", config: { url: "http://127.0.0.1:62999/api/mcp" } }
			],
			options: { logins: [{ username: "z2m", password: "s3cret" }], certfile: "fullchain.pem", wifi_psk: "", api_key: 1234 },
			auth_api: true,
			token_url: "https://example/token"
		}));
		const server = buildHarness({ ws: { sendCommand } });
		const result = await server.call("ha_supervisor_api", { endpoint: "/discovery" });
		const text = JSON.stringify(result.content);
		for (const secret of ["hunter2", "eyJ.abc", "s3cret", "1234"]) expect(text).not.toContain(secret);
		const body = jsonOf(result);
		expect(body.result.discovery[0].config).toMatchObject({ username: "homeassistant", password: REDACTED, port: 1883 });
		expect(body.result.discovery[2].config.url).toBe("http://127.0.0.1:62999/api/mcp");
		expect(body.result.options).toMatchObject({ certfile: "fullchain.pem", wifi_psk: "" });
		expect(body.result).toMatchObject({ auth_api: true, token_url: "https://example/token" });
		expect(body.redacted).toEqual([
			"discovery[0].config.password",
			"discovery[1].config.auth_token",
			"options.logins[0].password",
			"options.api_key"
		]);

		const plain = buildHarness({ ws: { sendCommand: vi.fn(async () => ({ addons: [] })) } });
		expect(jsonOf(await plain.call("ha_supervisor_api", { endpoint: "/addons" }))).not.toHaveProperty("redacted");
	});

	it("refuses to write the redaction marker back over a real password", async () => {
		const sendCommand = vi.fn(async () => ({ result: "ok" }));
		const server = buildHarness({ env: WRITE, ws: { sendCommand } });
		const result = await server.call("ha_supervisor_api", {
			endpoint: "/addons/core_mosquitto/options",
			method: "post",
			data: { options: { logins: [{ username: "z2m", password: REDACTED }] } }
		});
		expect(result.isError).toBe(true);
		expect(sendCommand).not.toHaveBeenCalled();
	});

	it("parses log endpoints and waits for a command's own timeout", () => {
		expect(supervisorLogTarget("/supervisor/logs")).toEqual({ target: "supervisor" });
		expect(supervisorLogTarget("/addons/x/logs/boots/-1")).toBe("unsupported");
		expect(supervisorLogTarget("/addons/x/info")).toBeNull();
		expect(supervisorLogTarget("/store/logs")).toBeNull();
		expect(defaultSupervisorTimeout("/store/addons/x/install", "post")).toBe(SLOW_SUPERVISOR_TIMEOUT_SECONDS);
		expect(defaultSupervisorTimeout("/addons/x/stop", "get")).toBeUndefined();
		expect(commandTimeoutMs({ type: "x" }, 15000)).toBe(15000);
		expect(commandTimeoutMs({ type: "x", timeout: 50 }, 15000)).toBe(65000);
		expect(commandTimeoutMs({ type: "x", timeout: 1 }, 30000)).toBe(30000);
	});
});

describe("ha_update_device and ha_expose_entities", () => {
	const WRITE = { HA_ALLOW_WRITE: "true", HA_ALLOW_CONFIG_WRITE: "true" };

	it("renames and moves a device with only the fields given", async () => {
		const sendCommand = vi.fn(async () => ({ id: "d1" }));
		const server = buildHarness({ env: WRITE, ws: { sendCommand } });
		await server.call("ha_update_device", { device_id: "d1", name: "Bedroom proxy BT", area_id: "bedroom" });
		expect(sendCommand).toHaveBeenCalledWith({
			type: "config/device_registry/update", device_id: "d1", name_by_user: "Bedroom proxy BT", area_id: "bedroom"
		});
		expect((await server.call("ha_update_device", { device_id: "d1" })).isError).toBe(true);
		const readOnly = buildHarness({ ws: { sendCommand } });
		expect((await readOnly.call("ha_update_device", { device_id: "d1", name: "x" })).isError).toBe(true);
		expect(sendCommand).toHaveBeenCalledTimes(1);
	});

	it("lists exposure without write access, and changing it needs config-write", async () => {
		const sendCommand = vi.fn(async (command: Record<string, unknown>) =>
			command.type === "homeassistant/expose_entity/list"
				? { exposed_entities: { "light.a": { conversation: true }, "lock.door": { conversation: false } } }
				: null
		);
		const readOnly = buildHarness({ ws: { sendCommand } });
		const listed = await readOnly.call("ha_expose_entities", {});
		expect(JSON.stringify(listed.content)).toContain("light.a");
		expect(JSON.stringify(listed.content)).not.toContain("lock.door");
		expect((await readOnly.call("ha_expose_entities", { entity_ids: ["light.a"], should_expose: false })).isError).toBe(true);
		const server = buildHarness({ env: WRITE, ws: { sendCommand } });
		await server.call("ha_expose_entities", { entity_ids: ["light.a"], should_expose: false });
		expect(sendCommand).toHaveBeenLastCalledWith({
			type: "homeassistant/expose_entity", assistants: ["conversation"], entity_ids: ["light.a"], should_expose: false
		});
	});
});

describe("ha_config_flow reconfigure", () => {
	it("starts a reconfigure flow for an entry, finding its domain", async () => {
		const BROKERED = {
			HA_TOKEN: "", VOMEHOME_TOKEN: "vh_test", VOMEHOME_INSTANCE_ID: "rly-1",
			HA_ALLOW_WRITE: "true", HA_ALLOW_CONFIG_WRITE: "true"
		};
		const bodies: unknown[] = [];
		vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: any) => {
			const url = String(input);
			if (url.endsWith("/config/config_entries/entry")) {
				return new Response(JSON.stringify([{ entry_id: "e1", domain: "mqtt" }]), { status: 200 });
			}
			bodies.push(JSON.parse(init.body));
			return new Response(JSON.stringify({ type: "form", flow_id: "f1", step_id: "reconfigure" }), { status: 200 });
		}));
		const server = buildHarness({ env: BROKERED });
		const result = await server.call("ha_config_flow", { entry_id: "e1" });
		expect(result.isError).toBeFalsy();
		expect(bodies).toEqual([{ handler: "mqtt", show_advanced_options: false, entry_id: "e1" }]);
		vi.unstubAllGlobals();
	});
});

describe("ha_move_config_file and the media tools", () => {
	const BROKERED = {
		HA_TOKEN: "", VOMEHOME_TOKEN: "vh_test", VOMEHOME_INSTANCE_ID: "rly-1",
		HA_ALLOW_WRITE: "true", HA_ALLOW_CONFIG_WRITE: "true"
	};

	it("moves on the named home only, and says when the component is too old", async () => {
		const urls: string[] = [];
		let reply = new Response(JSON.stringify({ moved: true }), { status: 200 });
		vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
			urls.push(String(input));
			return reply;
		}));
		const server = buildHarness({ env: BROKERED });
		const wrong = await server.call("ha_move_config_file", { instance_id: "other", path: "a.yaml", to: "b.yaml" });
		expect(wrong.isError).toBe(true);
		expect(urls).toEqual([]);
		await server.call("ha_move_config_file", { instance_id: "rly-1", path: "esphome/frontpath/x.yaml", to: "esphome/x.yaml" });
		expect(urls[0]).toContain("/ha/files/move?path=esphome%2Ffrontpath%2Fx.yaml&to=esphome%2Fx.yaml&overwrite=0");
		reply = new Response(JSON.stringify({ error: "too old", update_required: "component" }), { status: 501 });
		const old = await server.call("ha_move_config_file", { instance_id: "rly-1", path: "a.yaml", to: "b.yaml" });
		expect(JSON.stringify(old.content)).toContain("0.9.51");
		vi.unstubAllGlobals();
	});

	it("returns a media image as an image", async () => {
		const urls: string[] = [];
		vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
			urls.push(String(input));
			return new Response(JSON.stringify({ content: "aGVsbG8=", encoding: "base64" }), { status: 200 });
		}));
		const server = buildHarness({ env: BROKERED });
		const result = await server.call("ha_read_media_file", { path: "snapshots/door.jpg" });
		expect(urls[0]).toContain("/ha/media/read?path=snapshots%2Fdoor.jpg&encoding=base64");
		expect(result.content[0]).toEqual({ type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" });
		expect(imageTypeFor("a/b.PNG")).toBe("image/png");
		expect(imageTypeFor("a/b.mp4")).toBeNull();
		vi.unstubAllGlobals();
	});
});

describe("Energy dashboard tools", () => {
	const WRITE = { HA_ALLOW_WRITE: "true", HA_ALLOW_CONFIG_WRITE: "true" };

	it("reads the setup with its validation, and says when there is none", async () => {
		const sendCommand = vi.fn(async (command: Record<string, unknown>) =>
			command.type === "energy/get_prefs"
				? { energy_sources: [{ type: "solar", stat_energy_from: "sensor.pv" }], device_consumption: [] }
				: { energy_sources: [], device_consumption: [] }
		);
		const server = buildHarness({ ws: { sendCommand } });
		const result = await server.call("ha_get_energy_prefs", {});
		expect(JSON.stringify(result.content)).toContain("sensor.pv");
		expect(sendCommand).toHaveBeenCalledWith({ type: "energy/validate" });

		const empty = buildHarness({
			ws: {
				sendCommand: vi.fn(async (command: Record<string, unknown>) => {
					if (command.type === "energy/get_prefs") throw new Error("not_found: No prefs");
					return {};
				})
			}
		});
		expect(JSON.stringify((await empty.call("ha_get_energy_prefs", {})).content)).toContain('\\"configured\\": false');
	});

	it("saves only the lists given, and only with config-write", async () => {
		const sendCommand = vi.fn(async () => ({}));
		const readOnly = buildHarness({ ws: { sendCommand } });
		expect((await readOnly.call("ha_set_energy_prefs", { device_consumption: [] })).isError).toBe(true);
		expect(sendCommand).not.toHaveBeenCalled();
		const server = buildHarness({ env: WRITE, ws: { sendCommand } });
		expect((await server.call("ha_set_energy_prefs", {})).isError).toBe(true);
		const devices = [{ stat_consumption: "sensor.washer_energy", name: "Washer" }];
		await server.call("ha_set_energy_prefs", { device_consumption: devices });
		expect(sendCommand).toHaveBeenCalledWith({ type: "energy/save_prefs", device_consumption: devices });
		expect(sendCommand).toHaveBeenLastCalledWith({ type: "energy/validate" });
	});
});

describe("Long-term statistics tools", () => {
	const WRITE = { HA_ALLOW_WRITE: "true", HA_ALLOW_CONFIG_WRITE: "true" };
	// GamlaBio, 22 Oct 2026: Sam's cloud power read 183 kW for fifteen minutes.
	const glitch = Date.parse("2026-10-22T13:30:00Z");
	const rows = [
		{ start: glitch - 600000, end: glitch - 300000, change: 0.06 },
		{ start: glitch, end: glitch + 300000, change: 15.46 },
		{ start: glitch - 300000, end: glitch, change: 15.25 }
	];

	it("lists the biggest buckets first, like the Outliers button", async () => {
		const sendCommand = vi.fn(async () => ({ "sensor.sam_energy": rows }));
		const server = buildHarness({ ws: { sendCommand } });
		const body = jsonOf(
			await server.call("ha_get_statistics", {
				statistic_ids: ["sensor.sam_energy"],
				start_time: "2026-10-22T00:00:00Z",
				period: "5minute",
				largest_changes: 2
			})
		);
		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({ type: "recorder/statistics_during_period", period: "5minute", types: ["change"] })
		);
		expect(body.statistics["sensor.sam_energy"]).toEqual([
			{ start: "2026-10-22T13:30:00.000Z", end: "2026-10-22T13:35:00.000Z", change: 15.46 },
			{ start: "2026-10-22T13:25:00.000Z", end: "2026-10-22T13:30:00.000Z", change: 15.25 }
		]);
	});

	it("sets a bucket to a new value by adjusting the sum by the difference, only with config-write", async () => {
		const commands: Array<Record<string, unknown>> = [];
		let adjusted = false;
		const sendCommand = vi.fn(async (command: Record<string, unknown>) => {
			commands.push(command);
			if (command.type === "recorder/get_statistics_metadata") {
				return [{ statistic_id: "sensor.sam_energy", statistics_unit_of_measurement: "kWh" }];
			}
			if (command.type === "recorder/adjust_sum_statistics") {
				adjusted = true;
				return null;
			}
			return { "sensor.sam_energy": [{ start: glitch, change: adjusted ? 0.06 : 15.46 }] };
		});
		const readOnly = buildHarness({ ws: { sendCommand } });
		expect(
			(await readOnly.call("ha_adjust_statistic", { statistic_id: "sensor.sam_energy", start_time: "2026-10-22T13:30:00Z", new_value: 0.06 })).isError
		).toBe(true);
		expect(sendCommand).not.toHaveBeenCalled();

		const server = buildHarness({ env: WRITE, ws: { sendCommand } });
		const body = jsonOf(
			await server.call("ha_adjust_statistic", { statistic_id: "sensor.sam_energy", start_time: "2026-10-22T15:30:00+02:00", new_value: 0.06 })
		);
		const adjust = commands.find((command) => command.type === "recorder/adjust_sum_statistics")!;
		expect(adjust.start_time).toBe("2026-10-22T13:30:00.000Z");
		expect(adjust.adjustment_unit_of_measurement).toBe("kWh");
		expect(Number(adjust.adjustment)).toBeCloseTo(-15.4, 6);
		expect(body).toMatchObject({ adjusted: true, before: 15.46, after: 0.06 });
	});

	it("refuses a time that is not a bucket start, and needs exactly one of new_value or adjustment", async () => {
		const sendCommand = vi.fn(async () => [{ statistic_id: "sensor.sam_energy", statistics_unit_of_measurement: "kWh" }]);
		const server = buildHarness({ env: WRITE, ws: { sendCommand } });
		const off = await server.call("ha_adjust_statistic", { statistic_id: "sensor.sam_energy", start_time: "2026-10-22T13:31:00Z", adjustment: -1 });
		expect(off.isError).toBe(true);
		const both = await server.call("ha_adjust_statistic", { statistic_id: "sensor.sam_energy", start_time: "2026-10-22T13:30:00Z" });
		expect(both.isError).toBe(true);
		expect(sendCommand).not.toHaveBeenCalled();
	});
});

describe("people", () => {
	const WRITE = { HA_ALLOW_WRITE: "true", HA_ALLOW_CONFIG_WRITE: "true" };
	const SOFIE = {
		id: "sofie",
		name: "Sofie",
		user_id: "u-sofie",
		device_trackers: ["device_tracker.s21", "device_tracker.sofie_watch"],
		picture: null
	};
	const YAML_PERSON = { id: "gran", name: "Gran", device_trackers: [] };

	function peopleWs(onWrite: (cmd: Record<string, unknown>) => unknown = (cmd) => ({ ...SOFIE, ...cmd, id: (cmd.person_id as string) ?? "new-id" })) {
		return vi.fn(async (cmd: Record<string, unknown>) => {
			if (cmd.type === "person/list") {
				return {
					storage: [SOFIE, { id: "andy", name: "Andy", device_trackers: ["device_tracker.sofie_watch"] }],
					config: [YAML_PERSON]
				};
			}
			return onWrite(cmd);
		});
	}

	it("lists stored and YAML people, marking which can be edited", async () => {
		const server = buildHarness({ ws: { sendCommand: peopleWs() } });
		const body = jsonOf(await server.call("ha_list_people"));
		expect(body.people.map((p: any) => [p.name, p.editable])).toEqual([
			["Sofie", true],
			["Andy", true],
			["Gran", false]
		]);
		expect(body.people[0].device_trackers).toEqual(SOFIE.device_trackers);
	});

	it("takes one tracker off a person and leaves the rest", async () => {
		// The case that found the gap: an old phone off Sofie, her watch kept.
		const sendCommand = peopleWs();
		const server = buildHarness({ env: WRITE, ws: { sendCommand } });
		const body = jsonOf(
			await server.call("ha_set_person", {
				person_id: "sofie",
				remove_device_trackers: ["device_tracker.s21"],
				add_device_trackers: ["device_tracker.s25"]
			})
		);
		expect(sendCommand).toHaveBeenCalledWith({
			type: "person/update",
			person_id: "sofie",
			device_trackers: ["device_tracker.sofie_watch", "device_tracker.s25"]
		});
		expect(body.created).toBe(false);
		// The watch is on Andy too: allowed, but said.
		expect(body.also_tracking_someone_else).toEqual({ "device_tracker.sofie_watch": ["Andy"] });
	});

	it("changes only the fields given", async () => {
		const sendCommand = peopleWs();
		const server = buildHarness({ env: WRITE, ws: { sendCommand } });
		await server.call("ha_set_person", { person_id: "sofie", user_id: null });
		expect(sendCommand).toHaveBeenLastCalledWith({ type: "person/update", person_id: "sofie", user_id: null });
	});

	it("creates a person with a name and trackers", async () => {
		const sendCommand = peopleWs();
		const server = buildHarness({ env: WRITE, ws: { sendCommand } });
		const body = jsonOf(
			await server.call("ha_set_person", { name: "Guest", device_trackers: ["device_tracker.guest_phone"] })
		);
		expect(sendCommand).toHaveBeenLastCalledWith({
			type: "person/create",
			name: "Guest",
			device_trackers: ["device_tracker.guest_phone"]
		});
		expect(body.created).toBe(true);
	});

	it("refuses a new person without a name, and trackers that are not device_tracker entities", async () => {
		const sendCommand = peopleWs();
		const server = buildHarness({ env: WRITE, ws: { sendCommand } });
		expect((await server.call("ha_set_person", { device_trackers: [] })).isError).toBe(true);
		const wrong = await server.call("ha_set_person", {
			person_id: "sofie",
			add_device_trackers: ["sensor.s21_battery"]
		});
		expect(wrong.isError).toBe(true);
		expect(textOf(wrong)).toMatch(/sensor\.s21_battery/);
		expect(sendCommand).not.toHaveBeenCalledWith(expect.objectContaining({ type: "person/update" }));
	});

	it("refuses to edit or delete a configuration.yaml person, and says why", async () => {
		const sendCommand = peopleWs();
		const server = buildHarness({ env: WRITE, ws: { sendCommand } });
		for (const [tool, args] of [
			["ha_set_person", { person_id: "gran", name: "Granny" }],
			["ha_delete_person", { person_id: "gran" }]
		] as const) {
			const result = await server.call(tool, args);
			expect(result.isError).toBe(true);
			expect(textOf(result)).toMatch(/configuration\.yaml/);
		}
		expect(sendCommand.mock.calls.every(([cmd]) => cmd.type === "person/list")).toBe(true);
	});

	it("deletes a stored person by id, and refuses an unknown one", async () => {
		const sendCommand = peopleWs(() => null);
		const server = buildHarness({ env: WRITE, ws: { sendCommand } });
		expect(jsonOf(await server.call("ha_delete_person", { person_id: "sofie" }))).toEqual({
			deleted: true,
			person_id: "sofie",
			name: "Sofie"
		});
		expect(sendCommand).toHaveBeenLastCalledWith({ type: "person/delete", person_id: "sofie" });
		expect((await server.call("ha_delete_person", { person_id: "nobody" })).isError).toBe(true);
	});

	it("refuses every change without config-write", async () => {
		const sendCommand = peopleWs();
		const server = buildHarness({ ws: { sendCommand } });
		for (const [tool, args] of [
			["ha_set_person", { person_id: "sofie", remove_device_trackers: ["device_tracker.s21"] }],
			["ha_delete_person", { person_id: "sofie" }]
		] as const) {
			expect((await server.call(tool, args)).isError).toBe(true);
		}
		expect(sendCommand).not.toHaveBeenCalled();
	});
});
