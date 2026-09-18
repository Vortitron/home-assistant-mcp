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
	tools/logs.ts       structured system log, log levels, error/supervisor logs
	tools/traces.ts     automation/script traces, summarised
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
- **Safety is centralised** in `safety.ts` (`evaluateDomainWrite` /
  `evaluateConfigWrite` / `evaluateDiagnosticWrite`) and unit-tested. Writes are off by
  default; sensitive domains are denied; `ha_call_service` also checks target
  entity domains (recursively through `data`) to prevent cross-domain bypass,
  and refuses generic services targeting area/device/label while a deny/allow-
  list is active (those selectors resolve server-side, so they can't be vetted
  client-side). ESPHome/Node-RED/reboot guards and the brokered ESPHome client
  follow the *active instance* (per-instance policy), not just global flags.
- **SDK:** `@modelcontextprotocol/sdk` `registerTool(name, { description,
  inputSchema: <zod raw shape>, annotations }, handler)`; zod v3.

## Tools

71 tools across: system, states, services, registry, templates, automations,
logs/diagnostics, traces, ESPHome, Node-RED, VomeHome, HACS, users. See
`README.md` for the full table.

Logs/diagnostics (`tools/logs.ts`) prefers Home Assistant's *structured* error
store (`system_log/list` over WS) to the raw log tail: deduplicated records with
level/logger/source/count, tracebacks reduced to their final line unless
`include_exception`. `ha_clear_system_log` + `ha_set_log_level` exist to make the
clear → reproduce → read loop possible; both go through
`evaluateDiagnosticWrite` (needs `HA_ALLOW_WRITE` only — no config-write flag,
and the domain lists don't apply, since neither touches an entity).
`ha_get_supervisor_log` uses HA's `/api/hassio/*/logs` REST proxy, which is the
one Supervisor path family an admin token may reach (everything else there 401s —
that is why `ha_supervisor_api` uses the `supervisor/api` WS command instead).
Direct mode only: the broker doesn't proxy raw hassio paths.

HACS (`tools/hacs.ts`, September 2026): 5 tools over HACS's own `hacs/*` WS
commands — there is no REST API or service call for repository management.
`hacs/repositories/add` acks success even when the add silently failed (HACS
dispatches an error *event* instead), so `ha_hacs_add_repository` confirms by
re-listing and matching `full_name` rather than trusting the empty result.
Mutating tools resolve a caller-supplied id-or-`full_name` to the repository
row first (`resolveRepository`), and are gated the same way as
`ha_addon_install_vome`: local write+config guard, then the portal's
`ha:config` scope has the final say. This surface existed at the transport
level before the tools did — `ctx.ws.sendCommand` already passed any WS
command through the broker — the gap was that nothing exposed it, and the
portal's generic write-verb heuristic (`_WRITE_MARKERS`) didn't recognise
HACS's vocabulary ("add", "download", "state", "beta") as mutations; see the
`portal/ha_ws_command.py` fix in the VomeHome outline.

Users (`tools/users.ts`, September 2026): 7 tools over HA's `config/auth/*`
(users, roles) and `config/auth_provider/homeassistant/*` (local login
credentials) WS commands — again no REST API. Same scope-classification gap
as HACS turned up here too: `change_password`/`admin_change_password` match
none of the portal's `_WRITE_MARKERS`, so a read-only token could have reset
a password; same fix shape (explicit `config/auth/` branch, see the VomeHome
outline). The distinct risk this tool group carries, and the reason it went
through an explicit scope decision rather than being built straight off the
HACS precedent: a user + password created here is a **standing HA account
independent of the calling API key** — revoking the key does not revoke the
login, unlike every other write tool, which stops working the moment its key
is gone. `role` (mapping to Home Assistant's `system-admin` / `system-users`
/ `system-read-only` groups) has no default on `ha_create_user`, deliberately
— defaulting to admin would fail in exactly the wrong direction.

**Guest links** (`vomehome_create/list/revoke_guest_link`, September 2026)
build directly on the users work above, plus a mechanism that predates all of
it: the one-click login URL (`portal/ha_backdoor.py`). That page
(`vome_login.html`, baked into every Vome-hosted VM) turned out to already be
generic — it exchanges *any* refresh_token for a browser session, and had
just never been called with anything but the owner's own token. So a guest
link is: create a non-admin `config/auth/create` user → give it credentials
via `config/auth_provider/homeassistant/create` → run the *same* password
grant `ha_backdoor.password_grant_token()` already used for the owner's
re-auth, just with the guest's credentials → wrap the resulting token in the
same URL. No new transport, no on-device component changes. Only works for
Vome-hosted VMs — the password grant needs the portal's direct host→VM
network reach, which a self-hosted/relay-linked instance doesn't have (same
reason `login-url` is unavailable there). `expires_in` is enforced by a
portal-side sweep (`portal/guest_link_expiry.py`, mirrors `trial_expiry.py`)
since Home Assistant's own long-lived tokens don't expire on their own.
Revoke is `config/auth/delete` — deleting the user cascades to invalidate
every credential and token in one call, so there's no separate "revoke the
token" step to forget.

Config files (`tools/configFiles.ts`) gained an opt-in `encoding: 'base64'`
on read/write (September 2026), alongside the UTF-8 default, so a packaged
binary asset (an icon, a data file a custom integration ships) can round-trip
without corruption. `verify` (the `check_config` + rollback dance) defaults
to *off* for base64 — `check_config` only validates YAML, so it has nothing
useful to say about a binary write, and running it anyway would be free but
misleading (a "verified" binary write that check_config never actually
looked at).

Traces (`tools/traces.ts`): `trace/list` + `trace/get` over WS, for automations
and scripts. Raw traces embed the whole config and every step's variables, so
these summarise by default — ordered steps, the trigger, and `failed_at` (the
first step that errored or evaluated false), which is the thing logs never say.
`full: true` returns the raw payload. Item ids are resolved through
`resolveAutomationId` (exported from `tools/automations.ts`); scripts key on
their object_id.

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
`HA_ALLOW_DOMAINS`, `HA_ALLOW_CONFIG_WRITE`. ESPHome: nothing — it rides the
relay, so brokered HA is the only prerequisite. Node-RED: `NODERED_URL` (+ optional `NODERED_TOKEN` or
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
| POST | `/api/v1/instances` | `instances:write` | `{ instance: { id, name, status, granted_scopes? } }` — creating PAT is granted full HA access on the new instance |
| GET | `/api/v1/instances/{id}/login-url` | `instances:read` | `{ url }` |
| POST | `/api/v1/instances/{id}/guest-links` | `ha:config` | `{ id, url, expires_at }` — non-admin (unless `admin: true`) HA user + one-click URL. Vome-hosted only. |
| GET | `/api/v1/instances/{id}/guest-links` | `ha:config` | `{ guest_links: [{ id, admin, dashboard, created_at, expires_at, revoked_at }] }` — never the URL again |
| DELETE | `/api/v1/instances/{id}/guest-links/{link_id}` | `ha:config` | `{ revoked: true }` — deletes the guest's HA user |

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
  `templates/account_api_tokens.html`, with scope checkboxes). Creating an
  instance grants that PAT every per-instance HA scope on the new server so the
  sandbox is usable immediately.
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
- `tools.test.ts` — tools via a fake MCP server + injected fake clients
  (including system-log filtering/summarising, the log-level guards and the
  trace summariser).
- `vomehome.test.ts` — VomeHome client (mocked `fetch`) + tool-layer guards.
- `nodered.test.ts` — Node-RED client (v2 header, token/password-grant auth,
  deploy headers, error surfacing) + tool-layer config-write guards.

Mocks are used only for tests. No live HA is required to develop or test.

## Roadmap

1. **Brokered HA (the real boundary)** — shipped (MVP): scoped, audited HA
   reads/writes proxied through VomeHome so the agent never holds the HA token.
   Remaining: registry (areas/devices) over the broker, brokered config-file
   editing, a per-token audit view in the portal, and Supervisor/add-on logs
   over the broker (`ha_get_supervisor_log` is direct-mode only — the portal
   proxies the HA API, not raw `/api/hassio` paths).
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
