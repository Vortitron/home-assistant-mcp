# home-assistant-mcp — project outline

Short living document. Keep tidy. User-facing docs live in `README.md`; this file
is the map for contributors.

## Purpose

An MCP server that gives coding agents (Cursor, VS Code, Claude, …) direct,
guarded access to Home Assistant and ESPHome, so they can discover entities, read
state, render templates, call services and edit automations without the human
copy-pasting context. Open-source companion / lead-in to **VomeHome**.

## Architecture

Single stdio MCP server (TypeScript, ES modules, Node ≥ 18.18).

```
src/
	index.ts            entry point: starts the MCP stdio server, or runs `doctor`
	config.ts           loadConfig(env) -> Config (pure); validateConfig
	safety.ts           evaluateDomainWrite / evaluateConfigWrite (the write-guard)
	logger.ts           createLogger(level) -> stderr-only logger
	ha/restClient.ts    createHaRestClient(config, logger) -> REST surface
	ha/wsClient.ts      createHaWsClient(config, logger) -> WS registries (area/device/entity)
	ha/types.ts         structural HA payload types
	esphome/dashboardClient.ts  REST (edit/devices) + WS command runner (validate/compile/upload)
	tools/helpers.ts    ToolContext, result helpers, runTool() error wrapper
	tools/*.ts          one registerXxxTools(server, ctx) per group
	tools/index.ts      registerAllTools(server, ctx)
	cli/doctor.ts       connectivity check (human-facing, stdout)
```

### Key conventions / decisions

- **No exported singletons.** `loadConfig` returns a fresh `Config`; clients are
  factory functions; everything is threaded through `ToolContext` parameters.
- **stdout is sacred.** It is the JSON-RPC channel — all logs go to stderr.
- **Registries need WebSocket.** Areas/devices/entity-registry are WS-only in HA,
  hence both a REST and a WS client.
- **Safety is centralised** in `safety.ts` and unit-tested. Writes are off by
  default; sensitive domains are denied; `ha_call_service` also checks target
  entity domains to prevent cross-domain bypass.
- **SDK:** `@modelcontextprotocol/sdk` `registerTool(name, { description,
  inputSchema: <zod raw shape>, annotations }, handler)`; zod v3.

## Tools

26 tools across: system, states, services, registry, templates, automations,
logs/diagnostics, ESPHome. See `README.md` for the full table.

## Environment

See `.env.example` / the README table. Required: `HA_URL`, `HA_TOKEN`. Writes:
`HA_ALLOW_WRITE`, `HA_DENY_DOMAINS`, `HA_ALLOW_DOMAINS`, `HA_ALLOW_CONFIG_WRITE`.
ESPHome: `ESPHOME_DASHBOARD_URL` (+ optional auth).

## Testing

`vitest` unit tests in `tests/`:
- `safety.test.ts` — the write-guard matrix.
- `config.test.ts` — env parsing + validation.
- `restClient.test.ts` — REST behaviour with mocked `fetch`.
- `tools.test.ts` — tools via a fake MCP server + injected fake clients.

Mocks are used only for tests. No live HA is required to develop or test.

## Roadmap

1. **VomeHome test installs** — provision a throwaway HA sandbox via VomeHome for
   agents to try changes before touching a real home (the modular client layer
   exists to make this drop-in). This is the headline next step.
2. ESPHome live-log streaming + device adoption.
3. MCP resources for entities/areas alongside tools.
4. Optional HTTP/SSE transport for remote use.

## Open questions

- Token handling for the VomeHome sandbox flow (per-session ephemeral tokens?).
- Whether to expose a "dry-run" mode that previews service calls without sending.
