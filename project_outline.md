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
	vomehome/client.ts  createVomeHomeClient(config, logger) -> portal /api/v1/instances (Bearer PAT)
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

31 tools across: system, states, services, registry, templates, automations,
logs/diagnostics, ESPHome, VomeHome. See `README.md` for the full table.

## Environment

See `.env.example` / the README table. Required: `HA_URL`, `HA_TOKEN`. Writes:
`HA_ALLOW_WRITE`, `HA_DENY_DOMAINS`, `HA_ALLOW_DOMAINS`, `HA_ALLOW_CONFIG_WRITE`.
ESPHome: `ESPHOME_DASHBOARD_URL` (+ optional auth).
VomeHome: `VOMEHOME_API_URL` (default `https://vome.io`), `VOMEHOME_TOKEN`,
`VOMEHOME_ALLOW_CREATE`.

## VomeHome integration & required portal API

The `vomehome_*` tools talk to a token-authenticated JSON API on the VomeHome
portal (Flask app at `konhas.com/portal`). The portal today has session-cookie
routes and an unused JWT helper, but **no PAT issuance and no JSON create/login
endpoints** — so these endpoints must be added portal-side for the tools to work
against a live account. Contract the client expects (all `Authorization: Bearer
<pat>`, CSRF-exempt, scoped to the token's user):

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/v1/instances` | `{ instances: [{ id, name, status, tier, ha_url, custom_domain, created_at, live: { reachable, ha_state, ha_health } }] }` |
| GET | `/api/v1/instances/{id}` | `{ instance: {…same…} }` |
| POST | `/api/v1/instances/{id}/restart` | `{ success, message }` (wraps `restart_server()`) |
| POST | `/api/v1/instances` | body `{ name, timezone? }` → `{ instance: { id, name, status } }` (wraps `create_user_instance()`) |
| GET | `/api/v1/instances/{id}/login-url` | `{ url, expires_at? }` (wraps `ha_backdoor.create_login_url()`, honour `backdoor_disabled`) |

Plus a PAT system: a `users`-linked `api_tokens` table, a GitHub-session-gated
UI to create/revoke tokens (show plaintext once, store a hash), and PAT-aware
`api_auth_required` (accept `vh_…` PATs alongside the existing JWT). The client
tolerates snake_case or camelCase keys and passes unknown fields through.

The client/tools are written against this contract and unit-tested with a mocked
`fetch`; they degrade to clear errors until the portal ships the endpoints.

## Testing

`vitest` unit tests in `tests/`:
- `safety.test.ts` — the write-guard matrix.
- `config.test.ts` — env parsing + validation.
- `restClient.test.ts` — REST behaviour with mocked `fetch`.
- `tools.test.ts` — tools via a fake MCP server + injected fake clients.
- `vomehome.test.ts` — VomeHome client (mocked `fetch`) + tool-layer guards.

Mocks are used only for tests. No live HA is required to develop or test.

## Roadmap

1. **VomeHome test installs** — `vomehome_*` tools ship now (list/get/reboot/
   create/login-url). Remaining: portal endpoints above, then auto-retarget
   `HA_URL`/`HA_TOKEN` at a freshly created sandbox so agents iterate there first.
2. ESPHome live-log streaming + device adoption.
3. MCP resources for entities/areas alongside tools.
4. Optional HTTP/SSE transport for remote use.

## Open questions

- PAT vs short-lived OAuth-device tokens for VomeHome (start with revocable PATs).
- Whether to expose a "dry-run" mode that previews service calls without sending.
