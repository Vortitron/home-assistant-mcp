# home-assistant-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that lets
coding agents — Cursor, VS Code (Copilot), Claude Desktop and anything else that
speaks MCP — talk **directly** to [Home Assistant](https://www.home-assistant.io)
and (optionally) the [ESPHome](https://esphome.io) dashboard.

Instead of copy-pasting entity ids, YAML and current values into your agent, the
agent can discover entities, read live state, render templates, call services and
edit automations itself — and iterate until the code actually works.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

> Part of the [Vome](https://vome.io) family and an open-source companion to
> **VomeHome** (managed Home Assistant). It is useful stand-alone for any Home
> Assistant user.

---

## Why

A typical "change an automation" loop today looks like: you tell the agent which
entities exist, paste their current values, paste the YAML, apply the change, then
manually check whether it worked. With this server the agent does all of that:

- **See** — list entities/areas/devices, read exact states and attributes, pull
  history and the logbook.
- **Experiment** — render Jinja templates against live state, check configuration,
  read the error log.
- **Change** — call services, create/update/delete/trigger automations, and (for
  ESPHome) edit, validate, compile and flash device firmware.

All write operations are **off by default** and gated behind an explicit safety
policy (see [Safety](#safety)).

---

## Tools

### Home Assistant — read

| Tool | Description |
| --- | --- |
| `ha_get_config` | Core config: version, location, time zone, loaded components. |
| `ha_list_entities` | List entities (filter by domain, free-text search, area). |
| `ha_get_state` | Full state + attributes for one or more entities. |
| `ha_get_history` | Historical state changes over a time window. |
| `ha_list_services` | Available services (and their fields for a given domain). |
| `ha_list_areas` | Areas (rooms/zones). |
| `ha_list_devices` | Device registry (filter by area / search). |
| `ha_get_entity_registry` | Registry metadata: platform, area, device, disabled/hidden. |
| `ha_render_template` | Render a Jinja2 template against live state. |
| `ha_list_automations` | Automations with entity_id, unique id, state, last-triggered. |
| `ha_get_automation` | Full automation config (triggers/conditions/actions). |
| `ha_check_config` | Validate the configuration (Check configuration). |
| `ha_get_error_log` | Tail of the Home Assistant error log. |
| `ha_get_logbook` | Human-readable logbook entries. |

### Home Assistant — write (write-gated)

> Write-gating depends on the mode. In **direct** mode the MCP is the only guard,
> so these refuse until `HA_ALLOW_WRITE=true`. In **brokered** mode your VomeHome
> API key carries the per-instance `ha:write` / `ha:config` scopes and the server
> enforces them, so the client flags are optional local-only restrictions.

| Tool | Description |
| --- | --- |
| `ha_call_service` | Call any service (turn_on, set_temperature, …). |
| `ha_set_automation` | Create or update an automation (also needs `HA_ALLOW_CONFIG_WRITE`). |
| `ha_delete_automation` | Delete an automation (also needs `HA_ALLOW_CONFIG_WRITE`). |
| `ha_trigger_automation` | Manually run an automation now. |
| `ha_reload_automations` | Reload automations without restarting. |
| `ha_fire_event` | Fire a custom event on the event bus. |

### ESPHome (`ESPHOME_DASHBOARD_URL`, or brokered to a relay-connected HA)

| Tool | Description |
| --- | --- |
| `esphome_list_devices` | List dashboard configurations/devices. |
| `esphome_get_config` | Read a configuration's YAML. |
| `esphome_save_config` | Write a configuration's YAML (write-gated). |
| `esphome_validate` | Validate a configuration. |
| `esphome_compile` | Compile firmware. |
| `esphome_upload` | Compile + flash a device, OTA by default (write-gated). |

### Node-RED (`NODERED_URL`)

[Node-RED](https://nodered.org) is the flow-based editor that ships as a Home
Assistant add-on. It is powerful but fiddly to edit by hand — so let the agent
read and write the flow JSON for you. Flows are stored as a JSON array of nodes
grouped into tabs; these tools work a tab at a time (safe) or on the whole
config (deliberate). Writes are gated behind the same switches as editing HA
automations (`HA_ALLOW_WRITE` + `HA_ALLOW_CONFIG_WRITE`).

| Tool | Description |
| --- | --- |
| `nodered_get_flows` | Get the full flow config (all tabs) plus the current revision. |
| `nodered_get_flow` | Get one flow (tab) and its nodes by id. |
| `nodered_list_nodes` | List installed node modules/types (the palette). |
| `nodered_create_flow` | Add a new tab without disturbing existing flows (write-gated). |
| `nodered_update_flow` | Replace one tab by id, leaving others untouched (write-gated). |
| `nodered_delete_flow` | Delete a tab and its nodes (write-gated). |
| `nodered_set_flows` | Replace the **entire** flow config and deploy (write-gated). |

### VomeHome (require `VOMEHOME_TOKEN`)

[VomeHome](https://vome.io) is managed Home Assistant hosting. Log in to the
portal with GitHub, mint a personal access token under **Account → API tokens**,
and the agent can manage your instances from the editor. Advanced management
stays behind a full browser login on the portal.

| Tool | Description |
| --- | --- |
| `vomehome_list_instances` | List your HA instances with status, tier, URL, live health, the **active** instance and per-instance client write/config access. |
| `vomehome_get_instance` | Details + live status for one instance. |
| `vomehome_use_instance` | Switch which instance the `ha_*` tools target (multi-instance — see [Several instances from one token](#several-instances-from-one-token)). |
| `vomehome_reboot_instance` | Reboot an instance's VM (write-gated). |
| `vomehome_create_instance` | Create a throwaway test/sandbox instance (needs the create scope on your API key; the new instance becomes the active target). |
| `vomehome_get_login_url` | Mint a one-click HA login URL to open in a new tab. |

---

## Install

Requires **Node.js ≥ 18.18** (Node 20+ recommended). There is nothing to install
by hand — your editor launches the server on demand with `npx`, so the same
config works on every machine (no absolute paths).

### One‑click (Cursor)

[![Add to Cursor](https://img.shields.io/badge/Add%20to-Cursor-000?logo=cursor)](cursor://anysphere.cursor-deeplink/mcp/install?name=home-assistant&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkB2b3J0aXRyb24vaG9tZS1hc3Npc3RhbnQtbWNwIl0sImVudiI6eyJIQV9VUkwiOiJodHRwOi8vaG9tZWFzc2lzdGFudC5sb2NhbDo4MTIzIiwiSEFfVE9LRU4iOiJZT1VSX0hBX0xPTkdfTElWRURfVE9LRU4iLCJIQV9BTExPV19XUklURSI6ImZhbHNlIn19)

Click it, then edit the pre‑filled `HA_URL` and `HA_TOKEN`. (If the button does
nothing, copy the [`cursor://` link from the source of this section](#) into your
browser's address bar.)

### One‑line config

Add this to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one
project) and fill in your token — that's the whole install:

```json
{
	"mcpServers": {
		"home-assistant": {
			"command": "npx",
			"args": ["-y", "@vortitron/home-assistant-mcp"],
			"env": {
				"HA_URL": "http://homeassistant.local:8123",
				"HA_TOKEN": "paste-your-long-lived-token",
				"HA_ALLOW_WRITE": "false"
			}
		}
	}
}
```

### Verify / from source

```bash
npx -y @vortitron/home-assistant-mcp doctor   # one-off connectivity check

# or hack on it:
git clone https://github.com/Vortitron/home-assistant-mcp.git
cd home-assistant-mcp && npm install && npm run build
```

---

## Configuration

Configuration is via environment variables (a local `.env` is also read). Copy
`.env.example` to `.env` and fill it in, or set the variables in your editor's MCP
config.

| Variable | Default | Description |
| --- | --- | --- |
| `HA_URL` | — (required) | Base URL, e.g. `http://homeassistant.local:8123`. |
| `HA_TOKEN` | — (required) | Long-lived access token (Profile → Security). |
| `HA_ALLOW_WRITE` | off (direct) / permissive (brokered) | Local write guard. In brokered mode the API key's per-instance scope decides (server-enforced); setting `false` only adds a local restriction. In direct mode this is the master switch and defaults off. |
| `HA_DENY_DOMAINS` | `lock,alarm_control_panel,cover,climate,vacuum,valve,water_heater,lawn_mower,camera` | Domains that can never be written. Set empty to clear. |
| `HA_ALLOW_DOMAINS` | _(any)_ | If set, only these domains may be written. |
| `HA_ALLOW_CONFIG_WRITE` | off (direct) / permissive (brokered) | Local guard for editing automation config. Same semantics as `HA_ALLOW_WRITE`. |
| `ESPHOME_DASHBOARD_URL` | _(disabled)_ | ESPHome dashboard URL to enable ESPHome tools directly. In brokered mode (relay-connected HA) the REST subset works without it. |
| `ESPHOME_DASHBOARD_TOKEN` | — | Bearer token, if the dashboard is behind an auth proxy. |
| `ESPHOME_DASHBOARD_USERNAME` / `..._PASSWORD` | — | HTTP basic auth alternative. |
| `NODERED_URL` | _(disabled)_ | Node-RED editor/admin base URL, e.g. `http://homeassistant.local:1880`. Enables the `nodered_*` tools. |
| `NODERED_TOKEN` | — | Bearer token if Node-RED `adminAuth` is enabled. |
| `NODERED_USERNAME` / `NODERED_PASSWORD` | — | Credentials exchanged for a token via `/auth/token`, if you prefer not to mint one by hand. |
| `VOMEHOME_API_URL` | `https://vome.io` | VomeHome portal base URL. |
| `VOMEHOME_TOKEN` | _(disabled)_ | VomeHome personal access token; enables the `vomehome_*` tools. |
| `VOMEHOME_INSTANCE_ID` | _(direct mode)_ | The active/default instance to broker HA calls to. With a token and **no** `HA_TOKEN`, HA tools route through VomeHome (see [Brokered mode](#brokered-mode-the-real-boundary)). What it may do is set by your token's per-instance scopes in the portal (server-enforced). |
| `VOMEHOME_INSTANCES` | _(none)_ | Optional JSON registry to make **multiple** instances known at startup, e.g. `[{"id":"rly-house","label":"home"},{"id":"sbx"}]`. Per-instance `write`/`config` here are optional **local** restrictions (omit to defer to the server). Switch between them with `vomehome_use_instance`. See [Several instances from one token](#several-instances-from-one-token). |
| `VOMEHOME_ALLOW_CREATE` | _(defer to key)_ | Optional **local** guard for creating an instance. The real authority is the account-wide create scope on your API key; set `false` to block creation locally regardless. Instances you create become the active target for the session. |
| `HA_TIMEOUT_MS` | `15000` | HTTP/WebSocket request timeout. |
| `MAX_RESULTS` | `500` | Max items a list tool returns before truncating. |
| `LOG_LEVEL` | `info` | `error` \| `warn` \| `info` \| `debug` (logs go to stderr). |

### Getting a token

In Home Assistant: click your user (bottom-left) → **Security** tab → **Long-lived
access tokens** → **Create token**.

---

## Editor setup

This is a standard stdio MCP server, so the same binary works everywhere.

### Cursor

Use the [one‑click button](#one-click-cursor) above, or create `.cursor/mcp.json`
in your project (or `~/.cursor/mcp.json` for all projects). See
[`examples/cursor.mcp.json`](./examples/cursor.mcp.json):

```json
{
	"mcpServers": {
		"home-assistant": {
			"command": "npx",
			"args": ["-y", "@vortitron/home-assistant-mcp"],
			"env": {
				"HA_URL": "http://homeassistant.local:8123",
				"HA_TOKEN": "paste-your-long-lived-token",
				"HA_ALLOW_WRITE": "false"
			}
		}
	}
}
```

### VS Code

Create `.vscode/mcp.json` (see [`examples/vscode.mcp.json`](./examples/vscode.mcp.json)).
VS Code can prompt for the token so it is not stored in the file:

```json
{
	"inputs": [
		{ "id": "ha_token", "type": "promptString", "description": "Home Assistant token", "password": true }
	],
	"servers": {
		"home-assistant": {
			"type": "stdio",
			"command": "npx",
			"args": ["-y", "@vortitron/home-assistant-mcp"],
			"env": {
				"HA_URL": "http://homeassistant.local:8123",
				"HA_TOKEN": "${input:ha_token}"
			}
		}
	}
}
```

### Claude Desktop

Add the same block under `mcpServers` in `claude_desktop_config.json`.

### Multiple Home Assistants

Each entry under `mcpServers` is its own server process with its own
environment, so to control several Home Assistants — each with a different
token — add one entry per instance and give each a distinct name. The name
prefixes the tool names in your editor (e.g. `ha-home: ha_list_entities`), so
the agent always knows which house it is talking to. See
[`examples/cursor.multi.mcp.json`](./examples/cursor.multi.mcp.json):

```json
{
	"mcpServers": {
		"ha-home": {
			"command": "npx",
			"args": ["-y", "@vortitron/home-assistant-mcp"],
			"env": {
				"VOMEHOME_TOKEN": "vh_token-for-home",
				"VOMEHOME_INSTANCE_ID": "rly-aaaaaaaaaaaa"
			}
		},
		"ha-cottage": {
			"command": "npx",
			"args": ["-y", "@vortitron/home-assistant-mcp"],
			"env": {
				"VOMEHOME_TOKEN": "vh_token-for-cottage",
				"VOMEHOME_INSTANCE_ID": "rly-bbbbbbbbbbbb"
			}
		}
	}
}
```

Brokered and direct entries mix freely (e.g. a brokered home plus a direct
`HA_URL`/`HA_TOKEN` lab instance), and each entry can carry its own safety
flags — a read-only token for the family home, writes enabled for the test
bench.

### Several instances from one token

The multi-process layout above is one process per token. When several instances
live on the **same** VomeHome account (same token), you can instead drive them
all from **one** server and switch between them at runtime. Permissions live on
the key — you grant `ha:write` / `ha:config` per instance in the portal and the
server enforces it — so the config below is just about which instances are known
at startup (plus any optional local belt-and-braces restrictions).

```json
{
	"mcpServers": {
		"home-assistant": {
			"command": "npx",
			"args": ["-y", "@vortitron/home-assistant-mcp"],
			"env": {
				"VOMEHOME_TOKEN": "vh_your-account-token",
				"VOMEHOME_INSTANCE_ID": "rly-house",
				"VOMEHOME_INSTANCES": "[{\"id\":\"rly-house\",\"write\":false,\"label\":\"home (locked read-only here)\"},{\"id\":\"sbx-plc\",\"label\":\"PLC sandbox\"}]"
			}
		}
	}
}
```

- **`VOMEHOME_INSTANCE_ID`** is the *active/default* instance the `ha_*` tools
  target at startup (folded into the registry automatically as `"default"`).
  What it may do is set by your token's per-instance scopes in the portal.
- **`VOMEHOME_INSTANCES`** declares which instances are known at startup. Listing
  them is optional — the token already reaches them — but it lets you pin the
  active target and add local restrictions. A per-instance `write` / `config`
  here is an **optional local-only** restriction: omit it to defer to the server,
  or set `false` to keep an instance read-only on this machine regardless of what
  the key allows (the example locks the house locally).
- **`vomehome_use_instance`** switches the active instance for subsequent `ha_*`
  calls; **`vomehome_list_instances`** shows which one is active and each
  instance's effective access.
- **Creating instances** (`vomehome_create_instance`) needs the create scope on
  your key — **you own what you create**: a created instance becomes the active
  target for the session. Add its id to `VOMEHOME_INSTANCES` to keep it known
  across restarts.

The **API key is the single source of truth** and the server has the final say
(it returns `403` if the key lacks a scope). The client flags above only ever
restrict further on this machine; they never widen what the token can do.

### Verify

```bash
npx -y @vortitron/home-assistant-mcp doctor
```

`doctor` checks REST, the WebSocket registry and (if configured) the ESPHome
dashboard, and prints a health summary. It never starts the MCP server, so it is
safe to run any time.

---

## Safety

Designed to be safe to point at a real home:

1. **Read-only by default (direct mode).** With a raw `HA_TOKEN` the MCP is the
   only guard, so every state-changing tool refuses until `HA_ALLOW_WRITE=true`.
   In **brokered mode** permissions instead live on your VomeHome API key and are
   enforced server-side per instance (see [Brokered mode](#brokered-mode-the-real-boundary)).
2. **Domain deny-list.** Even with writes on, sensitive domains (locks, alarms,
   covers, climate, …) are blocked unless you remove them from `HA_DENY_DOMAINS`.
3. **Optional allow-list.** Set `HA_ALLOW_DOMAINS` to permit *only* specific
   domains.
4. **Cross-domain guard.** `ha_call_service` checks the domain of every target
   entity, so a generic service (e.g. `homeassistant.turn_on`) cannot be used to
   reach a denied domain.
5. **Separate config-write scope.** Editing automation YAML needs its own
   `ha:config` scope (brokered) or `HA_ALLOW_CONFIG_WRITE=true` (direct).
6. **VomeHome guards.** Rebooting or creating an instance is gated by the matching
   scope on your API key (server-enforced); the optional `VOMEHOME_ALLOW_CREATE`
   client flag can add a local block. The VomeHome token is scoped server-side to
   your own account.

Tools are also annotated with MCP hints (`readOnlyHint`, `destructiveHint`) so
clients can warn before destructive calls.

### What the write‑guard protects (and what it doesn't)

The guard constrains what **these tools** will do, and it's a strong guardrail
when the MCP server is the agent's *only* route to Home Assistant. It is **not** a
cryptographic boundary: a Home Assistant long‑lived token grants full access, so
an agent that *also* holds that token can call the HA API directly and bypass the
guard. So keep the token in your editor's MCP config (ideally `~/.cursor/mcp.json`,
outside any repo the agent can read) — not in files the agent browses.

For a genuine boundary, point the agent at **VomeHome** instead: it holds only a
revocable `VOMEHOME_TOKEN` while the powerful HA credential stays server‑side,
where access is policed and audited — so the agent *can't* go around the policy.
See [Brokered mode](#brokered-mode-the-real-boundary).

---

## Brokered mode (the real boundary)

Direct mode is convenient, but the write‑guard only helps if the agent doesn't
*also* hold the HA token. **Brokered mode closes that gap**: the agent is given a
revocable, scoped [VomeHome](https://vome.io) token and an instance id — and
**no Home Assistant token at all**. Every HA read/write is proxied through the
VomeHome portal, which:

- keeps the HA credential server‑side (the agent never sees it);
- enforces **read / write / config per token, per instance** — a token without
  `ha:write` for an instance genuinely cannot change it, no matter how it's used;
- blocks sensitive domains (locks, alarms, …) server‑side, including via generic
  services (`homeassistant.turn_on` can't reach a lock);
- **audits every call** (allowed or denied) against the token that made it.

Because the policy lives on the server, the agent cannot bypass it — that's the
difference between a guardrail and a boundary.

```json
{
	"mcpServers": {
		"home-assistant": {
			"command": "npx",
			"args": ["-y", "@vortitron/home-assistant-mcp"],
			"env": {
				"VOMEHOME_TOKEN": "vh_paste-your-token",
				"VOMEHOME_INSTANCE_ID": "your-instance-id"
			}
		}
	}
}
```

Mint the token at **Account → API tokens** in the portal. There you grant, **per
instance**, whether it may control Home Assistant (`ha:write`) and/or edit
automation config (`ha:config`) — and you can edit those grants after issuing the
key. The key is the single source of truth; the MCP just carries it. Get the
instance id from the dashboard or the `vomehome_list_instances` tool. (The portal's
token page generates this token-only snippet for you.)

> **Token scopes for the `vomehome_*` tools.** The instance-management tools
> (`vomehome_list_instances`, `_get_instance`, `_use_instance`, `_get_login_url`)
> need the **`instances:read`** scope, and `vomehome_create_instance` needs
> **`instances:write`** (which implies read). A token minted with only the HA
> scopes (`ha:read` / `ha:write` / `ha:config`) can broker Home Assistant calls
> but will get `403 … missing required scope(s): instances:read` from the
> instance tools. If you want the agent to spin up sandboxes, mint the token with
> `instances:write` **and** the `ha:*` scopes, and set `VOMEHOME_ALLOW_CREATE=true`.
> A default (read-only) token already includes `instances:read` — the 403 only
> appears when a token was scoped to HA access *without* the instances scopes.

Brokered mode proxies the everyday loop — list/get entities, list services, call
services, read config, render templates — **plus automation editing**:
`ha_get_automation`, `ha_set_automation`, `ha_delete_automation` and
`ha_check_config`. Reading an automation needs `ha:read`; writing one needs the
separate **`ha:config`** scope on the token *for that instance*, enforced
server-side. The client write guards (`HA_ALLOW_WRITE` / `HA_ALLOW_CONFIG_WRITE`)
default permissive in brokered mode and are optional local restrictions on top.
Registry tools (areas/devices), logs and history still need direct mode for now.

**ESPHome over the relay.** When you broker to a **relay-connected** Home
Assistant (your own HA linked via the Vome component's outbound tunnel), the
ESPHome dashboard's REST subset is brokered too — `esphome_list_devices`,
`esphome_get_config` and `esphome_save_config` work with no `ESPHOME_DASHBOARD_URL`
(reads need `ha:read`; saving YAML needs the instance's `ha:config` scope).
The streaming build commands (`esphome_validate` / `_compile` / `_upload`) stream
output, so they still need a directly-reachable `ESPHOME_DASHBOARD_URL`.

**Bring your own Home Assistant.** The instance you broker to does not have to be
a VomeHome VM. In the VomeHome portal, **Account → Connect HA** lets you attach a
Home Assistant you host yourself (public URL / external IP, or Nabu Casa Remote
UI) with a long‑lived access token. It then appears in `vomehome_list_instances`
with an `ext-…` id — set `VOMEHOME_INSTANCE_ID` to that, and the same scoped,
deny‑listed, audited boundary applies. Your HA token stays on the VomeHome server;
the agent only ever gets the revocable VomeHome token.

---

## Example agent workflows

- *"What lights are on in the living room?"* → `ha_list_entities` (domain `light`,
  area `living room`).
- *"Make this template return true only after sunset"* → iterate with
  `ha_render_template`.
- *"Turn the porch light to 30%"* → `ha_call_service` (`light.turn_on`,
  `brightness_pct: 30`). Requires writes enabled.
- *"Fix my morning automation"* → `ha_get_automation` → edit → `ha_set_automation`
  → `ha_check_config` → `ha_trigger_automation`.
- *"Add a sensor to this ESPHome node and flash it"* → `esphome_get_config` →
  `esphome_save_config` → `esphome_validate` → `esphome_upload`.
- *"Tidy up my Node-RED 'Heating' tab"* → `nodered_get_flows` (find the tab id)
  → `nodered_get_flow` → edit the nodes → `nodered_update_flow`.
- *"Spin up a sandbox and open it"* → `vomehome_create_instance` →
  `vomehome_get_instance` (poll status) → `vomehome_get_login_url` (open the link).

---

## ESPHome notes

- REST endpoints (`/devices`, `/edit`) are used for listing and reading/writing
  YAML.
- `validate`, `compile` and `upload` are WebSocket command channels. The dashboard
  authorises these with its own cookie/XSRF when a **dashboard password** is set,
  so these commands work against **password-less** dashboards or ones reachable on
  a trusted network / behind an auth-terminating proxy. Token/basic auth here only
  helps for the latter.

---

## Node-RED notes

- The HA **Node-RED add-on** exposes the editor on port `1880`
  (`http://homeassistant.local:1880`). Point `NODERED_URL` at it.
- If the add-on has a **credential secret / `adminAuth`** set, supply
  `NODERED_TOKEN` (or `NODERED_USERNAME`/`NODERED_PASSWORD`, which the client
  exchanges for a token). An add-on reachable only on your trusted network, or
  behind HA ingress / an auth-terminating proxy, needs no auth here.
- `nodered_set_flows` rewrites **everything** — prefer `nodered_create_flow` /
  `nodered_update_flow` for day-to-day edits. Pass the `rev` from
  `nodered_get_flows` so a concurrent change in the editor is detected rather
  than silently overwritten.
- Node-RED flows are plain JSON, which makes them a natural target for
  alternative front-ends (PLC-style ladder, Scratch/Blockly). That exploration
  lives in the VomeHome repo (`docs/alt_interfaces_plan.md`).

## Development

```bash
npm run dev          # run from source with tsx (watch)
npm run build        # compile to dist/
npm test             # vitest
npm run lint         # eslint
npm run typecheck    # tsc --noEmit
```

Layout:

```
src/
	index.ts              # entry: MCP stdio server + `doctor` CLI
	config.ts             # env parsing + validation
	safety.ts             # write-guard policy
	logger.ts             # stderr logger
	ha/                   # Home Assistant REST + WebSocket + brokered clients
	esphome/              # ESPHome dashboard client
	nodered/              # Node-RED admin API client
	vomehome/             # VomeHome portal client
	tools/                # one module per tool group
	cli/doctor.ts         # connectivity check
tests/                  # vitest unit tests
```

---

## Roadmap

- **VomeHome‑brokered HA access (the real boundary) — shipped (MVP).** HA
  reads/writes can be proxied *through* VomeHome with a revocable `VOMEHOME_TOKEN`
  so the HA credential never reaches the agent and the read‑only / deny‑domain /
  audit policy is enforced **server‑side**. Automation editing and the ESPHome
  REST subset are brokered too (the latter over a relay-connected HA). See
  [Brokered mode](#brokered-mode-the-real-boundary). Next: registry (areas/devices)
  over the broker and a per‑token audit view in the portal.
- **VomeHome test installs.** The `vomehome_*` tools already list, create, reboot
  and open instances. Next: point `HA_URL`/`HA_TOKEN` at a freshly created sandbox
  automatically so an agent can try changes there before touching a real home,
  then promote what works. (Requires the portal API endpoints described in
  [`project_outline.md`](./project_outline.md).)
- ESPHome live-log streaming and device adoption.
- **Node-RED** — flow read/write/deploy shipped. Next: brokering the admin API
  through VomeHome (as HA and the ESPHome REST subset already are) so a
  relay-connected home needs no directly-reachable Node-RED URL, and a flow
  *diff/validate* step before deploy.
- MCP resources for entities/areas (in addition to tools).
- Optional HTTP/SSE transport for remote use.

---

## License

[MIT](./LICENSE) © Vortitron
