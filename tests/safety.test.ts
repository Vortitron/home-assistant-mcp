import { describe, expect, it } from "vitest";
import type { SafetyConfig } from "../src/config.js";
import { evaluateConfigWrite, evaluateDomainWrite, extractDomain } from "../src/safety.js";

function safety(overrides: Partial<SafetyConfig> = {}): SafetyConfig {
	return {
		allowWrite: false,
		allowConfigWrite: false,
		denyDomains: ["lock", "alarm_control_panel"],
		allowDomains: [],
		...overrides
	};
}

describe("extractDomain", () => {
	it("returns the domain part of an entity_id", () => {
		expect(extractDomain("light.kitchen")).toBe("light");
	});

	it("lower-cases and trims, and handles a bare domain", () => {
		expect(extractDomain("  Light  ")).toBe("light");
		expect(extractDomain("LIGHT.Kitchen")).toBe("light");
	});
});

describe("evaluateDomainWrite", () => {
	it("refuses when writes are disabled", () => {
		const decision = evaluateDomainWrite("light", safety({ allowWrite: false }));
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toMatch(/HA_ALLOW_WRITE/);
	});

	it("refuses denied domains even when writes are enabled", () => {
		const decision = evaluateDomainWrite("lock", safety({ allowWrite: true }));
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toMatch(/deny/i);
	});

	it("allows an ordinary domain when writes are enabled", () => {
		const decision = evaluateDomainWrite("light.kitchen", safety({ allowWrite: true }));
		expect(decision.allowed).toBe(true);
	});

	it("enforces an active allow-list", () => {
		const policy = safety({ allowWrite: true, allowDomains: ["light"] });
		expect(evaluateDomainWrite("light", policy).allowed).toBe(true);
		expect(evaluateDomainWrite("switch", policy).allowed).toBe(false);
	});

	it("applies the deny-list on top of the allow-list", () => {
		const policy = safety({ allowWrite: true, allowDomains: ["lock"], denyDomains: ["lock"] });
		expect(evaluateDomainWrite("lock", policy).allowed).toBe(false);
	});
});

describe("evaluateConfigWrite", () => {
	it("requires allowWrite", () => {
		expect(evaluateConfigWrite(safety({ allowWrite: false, allowConfigWrite: true })).allowed).toBe(
			false
		);
	});

	it("requires allowConfigWrite", () => {
		expect(evaluateConfigWrite(safety({ allowWrite: true, allowConfigWrite: false })).allowed).toBe(
			false
		);
	});

	it("allows when both flags are set", () => {
		expect(evaluateConfigWrite(safety({ allowWrite: true, allowConfigWrite: true })).allowed).toBe(
			true
		);
	});
});
