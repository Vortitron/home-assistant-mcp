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
	ha/brokeredClient.ts createBrokeredHaRestClient -> routes HA via VomeHome (no HA token)
	ha/types.ts         structural HA payload types
	esphome/dashboardClient.ts  REST (edit/devices) + WS command runner (validate/compile/upload)
	nodered/client.ts   createNodeRedClient(config, logger) -> Node-RED admin API (flows/flow/nodes)
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
  entity domains (recursively through `data`) to prevent cross-domain bypass,
  and refuses generic services targeting area/device/label while a deny/allow-
  list is active (those selectors resolve server-side, so they can't be vetted
  client-side). ESPHome/Node-RED/reboot guards and the brokered ESPHome client
  follow the *active instance* (per-instance policy), not just global flags.
- **SDK:** `@modelcontextprotocol/sdk` `registerTool(name, { description,
  inputSchema: <zod raw shape>, annotations }, handler)`; zod v3.

## Tools

38 tools across: system, states, services, registry, templates, automations,
logs/diagnostics, ESPHome, Node-RED, VomeHome. See `README.md` for the full
table.

Node-RED (7 tools, `tools/nodered.ts` + `nodered/client.ts`): reads
(`get_flows`/`get_flow`/`list_nodes`) are open once `NODERED_URL` is set; writes
(`create_flow`/`update_flow`/`delete_flow`/`set_flows`) reuse the HA config-write
guard (`evaluateConfigWrite`: `HA_ALLOW_WRITE` + `HA_ALLOW_CONFIG_WRITE`) — flow
JSON is automation logic, so it gets the same gate as editing HA automations and
ESPHome YAML. Admin API auth mirrors ESPHome: optional bearer token, or a
username/password exchanged for one via `/auth/token` (cached per process), or
nothing for an unsecured admin API behind ingress/a trusted network. Direct-URL
only for now (no broker), matching ESPHome's streaming-build precedent.

## Environment

See `.env.example` / the README table. Direct mode: `HA_URL`, `HA_TOKEN`.
Brokered mode (no HA token): `VOMEHOME_TOKEN` + `VOMEHOME_INSTANCE_ID` (and
empty `HA_TOKEN`). Writes: `HA_ALLOW_WRITE`, `HA_DENY_DOMAINS`,
`HA_ALLOW_DOMAINS`, `HA_ALLOW_CONFIG_WRITE`. ESPHome: `ESPHOME_DASHBOARD_URL`
(+ optional auth). Node-RED: `NODERED_URL` (+ optional `NODERED_TOKEN` or
`NODERED_USERNAME`/`NODERED_PASSWORD`). VomeHome: `VOMEHOME_API_URL` (default
`https://vome.io`), `VOMEHOME_TOKEN`, `VOMEHOME_INSTANCE_ID`,
`VOMEHOME_INSTANCES`, `VOMEHOME_ALLOW_CREATE`.

**Permission authority depends on mode.** In direct mode the MCP is the sole
guard, so `HA_ALLOW_WRITE`/`HA_ALLOW_CONFIG_WRITE` default OFF. In brokered mode
the VomeHome API key carries per-instance `ha:read`/`ha:write`/`ha:config` scopes
(editable in the portal, enforced server-side with `403` on denial), so those
env flags — and the per-instance `write`/`config` keys in `VOMEHOME_INSTANCES` —
default **permissive** and act only as optional local-only restrictions. A
client `false` narrows; it never widens what the key allows.

`config.brokered` is derived: true when a VomeHome token + instance id are set
and `HA_TOKEN` is empty. In that mode `index.ts` injects the brokered REST
client and an "unavailable" WS stub (registry tools then return a clear error).

## VomeHome integration & portal API

The `vomehome_*` tools and brokered HA mode talk to a token-authenticated JSON
API on the VomeHome portal (Flask app at `konhas.com/portal`). These endpoints
are **implemented** there (PAT system + instances API + brokered HA proxy). All
require `Authorization: Bearer <pat>`, are CSRF-exempt, and are scoped to the
token's user and (where relevant) re-check instance ownership.

Instance management (`portal/instances_api.py`):

| Method | Path | Scope | Response |
| --- | --- | --- | --- |
| GET | `/api/v1/instances` | `instances:read` | `{ instances: [{ id, name, status, tier, ha_url, custom_domain, created_at, live? }] }` |
| GET | `/api/v1/instances/{id}` | `instances:read` | `{ instance: {…} }` |
| POST | `/api/v1/instances/{id}/restart` | `instances:write` | `{ success, message }` |
| POST | `/api/v1/instances` | `instances:write` | `{ instance: { id, name, status } }` |
| GET | `/api/v1/instances/{id}/login-url` | `instances:read` | `{ url }` |

Brokered Home Assistant (`portal/ha_proxy_api.py` → `portal/ha_core_api.py`):

| Method | Path | Scope | Notes |
| --- | --- | --- | --- |
| GET | `/api/v1/instances/{id}/ha/` | `ha:read` | HA `/api/` ping |
| GET | `/api/v1/instances/{id}/ha/config` | `ha:read` | HA `/api/config` |
| GET | `/api/v1/instances/{id}/ha/states[/{eid}]` | `ha:read` | states |
| GET | `/api/v1/instances/{id}/ha/services` | `ha:read` | services |
| POST | `/api/v1/instances/{id}/ha/template` | `ha:read` | render (eval only) |
| POST | `/api/v1/instances/{id}/ha/services/{domain}/{service}` | `ha:write` | deny-domain + cross-domain checked |

How the portal reaches HA: it can't hit tenant VMs directly, so it reuses
`supervisor_api._get_vm_access` (refresh→access token) and runs `curl` on the
container server over SSH (`ha_core_api.ha_request`). The HA token never leaves
the server.

Supporting pieces (all portal-side):
- **PATs** (`portal/api_tokens.py`): `api_tokens` table; tokens carry **scopes**
  (`instances:read/write`, `ha:read/ha:write`); read-only is the default; only a
  SHA-256 hash is stored; `token_meta()` is the single validator and `verify_pat`
  wraps it. GitHub-session UI to create/revoke (`account_tokens.py` +
  `templates/account_api_tokens.html`, with scope checkboxes).
- **Scope gate** (`portal/api_scopes.py`): `require_scopes(*needed)` — PATs use
  their stored scopes; other bearer tokens (Auth0/session) get full scopes.
- **Audit** (`portal/ha_audit.py`): `ha_audit_log` table; every brokered call
  (allowed or denied, read or write) is recorded against token + user.

Server-side deny-list mirrors the MCP default and is overridable via
`HA_BROKER_DENY_DOMAINS`. Portal changes are covered by
`tests/test_ha_broker.py` and `tests/test_api_tokens.py`.

## Testing

`vitest` unit tests in `tests/`:
- `safety.test.ts` — the write-guard matrix.
- `config.test.ts` — env parsing + validation.
- `restClient.test.ts` — REST behaviour with mocked `fetch`.
- `brokeredClient.test.ts` — brokered routing, policy-denial surfacing, mode detection.
- `tools.test.ts` — tools via a fake MCP server + injected fake clients.
- `vomehome.test.ts` — VomeHome client (mocked `fetch`) + tool-layer guards.
- `nodered.test.ts` — Node-RED client (v2 header, token/password-grant auth,
  deploy headers, error surfacing) + tool-layer config-write guards.

Mocks are used only for tests. No live HA is required to develop or test.

## Roadmap

1. **Brokered HA (the real boundary)** — shipped (MVP): scoped, audited HA
   reads/writes proxied through VomeHome so the agent never holds the HA token.
   Remaining: registry (areas/devices) over the broker, brokered config-file
   editing, and a per-token audit view in the portal.
2. **VomeHome test installs** — `vomehome_*` tools + portal endpoints ship now.
   Remaining: auto-retarget a freshly created sandbox so agents iterate there
   first, then promote what works.
3. ESPHome live-log streaming + device adoption.
4. **Node-RED** — flow read/write/deploy shipped (direct URL). Remaining:
   broker the admin API through VomeHome (like HA + the ESPHome REST subset) so
   relay-connected homes need no reachable Node-RED URL; a flow diff/validate
   preview before deploy; alternative front-ends over the flow JSON (see the
   VomeHome repo `docs/alt_interfaces_plan.md`).
5. MCP resources for entities/areas alongside tools.
6. Optional HTTP/SSE transport for remote use.

## Open questions

- PAT vs short-lived OAuth-device tokens for VomeHome (start with revocable PATs).
- Whether to expose a "dry-run" mode that previews service calls without sending.
