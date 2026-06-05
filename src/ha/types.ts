/**
 * Minimal structural types for the Home Assistant REST + WebSocket payloads we
 * touch. These are intentionally permissive (Record<string, unknown> for the
 * open-ended bits) because Home Assistant attributes vary widely by integration.
 */

export interface HaState {
	entity_id: string;
	state: string;
	attributes: Record<string, unknown>;
	last_changed?: string;
	last_updated?: string;
	context?: Record<string, unknown>;
}

export interface HaConfig {
	version?: string;
	location_name?: string;
	time_zone?: string;
	components?: string[];
	unit_system?: Record<string, unknown>;
	config_dir?: string;
	state?: string;
	[key: string]: unknown;
}

export interface HaServiceField {
	name?: string;
	description?: string;
	required?: boolean;
	example?: unknown;
	selector?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface HaService {
	name?: string;
	description?: string;
	fields?: Record<string, HaServiceField>;
	target?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface HaServiceDomain {
	domain: string;
	services: Record<string, HaService>;
}

export interface HaCheckConfigResult {
	result: string;
	errors: string | null;
	warnings?: string | null;
}

export interface HaApiStatus {
	message: string;
}

export interface HaLogbookEntry {
	when?: string;
	name?: string;
	message?: string;
	entity_id?: string;
	state?: string;
	domain?: string;
	context_user_id?: string | null;
	[key: string]: unknown;
}

export interface HaArea {
	area_id: string;
	name: string;
	floor_id?: string | null;
	icon?: string | null;
	aliases?: string[];
	[key: string]: unknown;
}

export interface HaDevice {
	id: string;
	name?: string | null;
	name_by_user?: string | null;
	area_id?: string | null;
	manufacturer?: string | null;
	model?: string | null;
	sw_version?: string | null;
	disabled_by?: string | null;
	[key: string]: unknown;
}

export interface HaEntityRegistryEntry {
	entity_id: string;
	area_id?: string | null;
	device_id?: string | null;
	platform?: string;
	name?: string | null;
	original_name?: string | null;
	disabled_by?: string | null;
	hidden_by?: string | null;
	entity_category?: string | null;
	[key: string]: unknown;
}

/** A Home Assistant service target (entity/area/device/label selectors). */
export interface HaTarget {
	entity_id?: string | string[];
	area_id?: string | string[];
	device_id?: string | string[];
	label_id?: string | string[];
}
