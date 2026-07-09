import type { SafetyConfig } from "./config.js";

/**
 * Central write-guard. Every state-changing tool routes through these helpers so
 * the safety policy lives in exactly one place and is trivially unit-testable.
 */

export interface WriteDecision {
	allowed: boolean;
	reason: string;
}

const OK = "ok";

export function extractDomain(entityIdOrDomain: string): string {
	const trimmed = entityIdOrDomain.trim().toLowerCase();
	const dotIndex = trimmed.indexOf(".");
	return dotIndex === -1 ? trimmed : trimmed.slice(0, dotIndex);
}

export function evaluateDomainWrite(domain: string, safety: SafetyConfig): WriteDecision {
	const normalised = extractDomain(domain);
	if (!safety.allowWrite) {
		return {
			allowed: false,
			reason:
				"Writes are disabled. Set HA_ALLOW_WRITE=true to allow state-changing operations."
		};
	}
	if (safety.denyDomains.includes(normalised)) {
		return {
			allowed: false,
			reason: `Domain '${normalised}' is in HA_DENY_DOMAINS and cannot be modified. Remove it from the deny-list to allow this.`
		};
	}
	if (safety.allowDomains.length > 0 && !safety.allowDomains.includes(normalised)) {
		return {
			allowed: false,
			reason: `Domain '${normalised}' is not in HA_ALLOW_DOMAINS (an allow-list is active). Add it to HA_ALLOW_DOMAINS to allow this.`
		};
	}
	return { allowed: true, reason: OK };
}

export function evaluateConfigWrite(safety: SafetyConfig): WriteDecision {
	if (!safety.allowWrite) {
		return {
			allowed: false,
			reason: "Writes are disabled. Set HA_ALLOW_WRITE=true to allow editing configuration."
		};
	}
	if (!safety.allowConfigWrite) {
		return {
			allowed: false,
			reason:
				"Config editing is disabled. Set HA_ALLOW_CONFIG_WRITE=true to allow editing automations, scripts, scenes and dashboards."
		};
	}
	return { allowed: true, reason: OK };
}
