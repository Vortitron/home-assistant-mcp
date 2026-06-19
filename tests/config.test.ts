import { describe, expect, it } from "vitest";
import { loadConfig, validateConfig } from "../src/config.js";

describe("loadConfig", () => {
	it("applies sensible defaults from an empty environment", () => {
		const config = loadConfig({});
		expect(config.haUrl).toBe("");
		expect(config.timeoutMs).toBe(15000);
		expect(config.maxResults).toBe(500);
		expect(config.logLevel).toBe("info");
		expect(config.safety.allowWrite).toBe(false);
		expect(config.safety.denyDomains).toContain("lock");
		expect(config.esphome.enabled).toBe(false);
	});

	it("parses and normalises values", () => {
		const config = loadConfig({
			HA_URL: "http://homeassistant.local:8123/",
			HA_TOKEN: "  abc  ",
			HA_ALLOW_WRITE: "true",
			HA_ALLOW_CONFIG_WRITE: "yes",
			HA_DENY_DOMAINS: "Lock, Climate ",
			HA_ALLOW_DOMAINS: "light,switch",
			HA_TIMEOUT_MS: "5000",
			MAX_RESULTS: "25",
			LOG_LEVEL: "debug",
			ESPHOME_DASHBOARD_URL: "http://esphome.local:6052/"
		});
		expect(config.haUrl).toBe("http://homeassistant.local:8123");
		expect(config.haToken).toBe("abc");
		expect(config.safety.allowWrite).toBe(true);
		expect(config.safety.allowConfigWrite).toBe(true);
		expect(config.safety.denyDomains).toEqual(["lock", "climate"]);
		expect(config.safety.allowDomains).toEqual(["light", "switch"]);
		expect(config.timeoutMs).toBe(5000);
		expect(config.maxResults).toBe(25);
		expect(config.logLevel).toBe("debug");
		expect(config.esphome.enabled).toBe(true);
		expect(config.esphome.dashboardUrl).toBe("http://esphome.local:6052");
	});

	it("allows clearing the deny-list with an empty value", () => {
		const config = loadConfig({ HA_DENY_DOMAINS: "" });
		expect(config.safety.denyDomains).toEqual([]);
	});

	it("falls back to defaults for invalid numbers and log levels", () => {
		const config = loadConfig({ HA_TIMEOUT_MS: "nope", MAX_RESULTS: "-5", LOG_LEVEL: "loud" });
		expect(config.timeoutMs).toBe(15000);
		expect(config.maxResults).toBe(500);
		expect(config.logLevel).toBe("info");
	});
});

describe("validateConfig", () => {
	it("reports missing url and token", () => {
		const problems = validateConfig(loadConfig({}));
		const fields = problems.map((problem) => problem.field);
		expect(fields).toContain("HA_URL");
		expect(fields).toContain("HA_TOKEN");
	});

	it("rejects a url without a scheme", () => {
		const problems = validateConfig(loadConfig({ HA_URL: "homeassistant.local", HA_TOKEN: "t" }));
		expect(problems.some((problem) => problem.field === "HA_URL")).toBe(true);
	});

	it("passes for a complete config", () => {
		const problems = validateConfig(
			loadConfig({ HA_URL: "http://ha.local:8123", HA_TOKEN: "token" })
		);
		expect(problems).toEqual([]);
	});

	it("passes for a complete brokered config (no direct HA creds needed)", () => {
		const problems = validateConfig(
			loadConfig({
				VOMEHOME_API_URL: "https://vome.io",
				VOMEHOME_TOKEN: "vh_token",
				VOMEHOME_INSTANCE_ID: "srv-1"
			})
		);
		expect(problems).toEqual([]);
	});

	it("reports a missing instance in brokered mode (no id and no registry)", () => {
		// Force brokered detection by supplying token + url + instance, then blank
		// BOTH the active id and the registry to ensure the brokered branch reports it.
		const config = loadConfig({
			VOMEHOME_API_URL: "https://vome.io",
			VOMEHOME_TOKEN: "vh_token",
			VOMEHOME_INSTANCE_ID: "srv-1"
		});
		const broken = {
			...config,
			vomehome: { ...config.vomehome, instanceId: "", instances: [] }
		};
		expect(validateConfig(broken).some((p) => p.field === "VOMEHOME_INSTANCE_ID")).toBe(true);
	});
});
