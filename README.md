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

### Home Assistant — write (require `HA_ALLOW_WRITE=true`)

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

### VomeHome (require `VOMEHOME_TOKEN`)

[VomeHome](https://vome.io) is managed Home Assistant hosting. Log in to the
portal with GitHub, mint a personal access token under **Account → API tokens**,
and the agent can manage your instances from the editor. Advanced management
stays behind a full browser login on the portal.

| Tool | Description |
| --- | --- |
| `vomehome_list_instances` | List your HA instances with status, tier, URL and live health. |
| `vomehome_get_instance` | Details + live status for one instance. |
| `vomehome_reboot_instance` | Reboot an instance's VM (write-gated). |
| `vomehome_create_instance` | Create a throwaway test instance (needs `VOMEHOME_ALLOW_CREATE`). |
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
| `HA_ALLOW_WRITE` | `false` | Master switch for any state-changing tool. |
| `HA_DENY_DOMAINS` | `lock,alarm_control_panel,cover,climate,vacuum,valve,water_heater,lawn_mower,camera` | Domains that can never be written. Set empty to clear. |
| `HA_ALLOW_DOMAINS` | _(any)_ | If set, only these domains may be written. |
| `HA_ALLOW_CONFIG_WRITE` | `false` | Allow editing automation config (with `HA_ALLOW_WRITE`). |
| `ESPHOME_DASHBOARD_URL` | _(disabled)_ | ESPHome dashboard URL to enable ESPHome tools directly. In brokered mode (relay-connected HA) the REST subset works without it. |
| `ESPHOME_DASHBOARD_TOKEN` | — | Bearer token, if the dashboard is behind an auth proxy. |
| `ESPHOME_DASHBOARD_USERNAME` / `..._PASSWORD` | — | HTTP basic auth alternative. |
| `VOMEHOME_API_URL` | `https://vome.io` | VomeHome portal base URL. |
| `VOMEHOME_TOKEN` | _(disabled)_ | VomeHome personal access token; enables the `vomehome_*` tools. |
| `VOMEHOME_INSTANCE_ID` | _(direct mode)_ | Instance to broker HA calls to. With a token and **no** `HA_TOKEN`, HA tools route through VomeHome (see [Brokered mode](#brokered-mode-the-real-boundary)). |
| `VOMEHOME_ALLOW_CREATE` | `false` | Extra guard required (with `HA_ALLOW_WRITE`) to create an instance. |
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

1. **Read-only by default.** Every state-changing tool refuses until
   `HA_ALLOW_WRITE=true`.
2. **Domain deny-list.** Even with writes on, sensitive domains (locks, alarms,
   covers, climate, …) are blocked unless you remove them from `HA_DENY_DOMAINS`.
3. **Optional allow-list.** Set `HA_ALLOW_DOMAINS` to permit *only* specific
   domains.
4. **Cross-domain guard.** `ha_call_service` checks the domain of every target
   entity, so a generic service (e.g. `homeassistant.turn_on`) cannot be used to
   reach a denied domain.
5. **Separate config-write switch.** Editing automation YAML additionally requires
   `HA_ALLOW_CONFIG_WRITE=true`.
6. **VomeHome guards.** Rebooting an instance respects the master `HA_ALLOW_WRITE`
   switch; creating one additionally requires `VOMEHOME_ALLOW_CREATE=true`. The
   VomeHome token is scoped server-side to your own account.

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
- enforces **read‑only vs read/write per token** — a read‑only token genuinely
  cannot change anything, no matter how it's used;
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

Mint the token at **Account → API tokens** in the portal. Tick "Control Home
Assistant" for a token that can call services, and/or "Edit automations" for one
that can read **and write automation config**. Get the instance id from the
dashboard or the `vomehome_list_instances` tool. (The portal's token page
generates this snippet for you, with the write flags pre‑filled to match the
token's scopes.)

Brokered mode proxies the everyday loop — list/get entities, list services, call
services, read config, render templates — **plus automation editing**:
`ha_get_automation`, `ha_set_automation`, `ha_delete_automation` and
`ha_check_config`. Reading an automation needs `ha:read`; writing one needs the
separate **`ha:config`** scope on the token *and* `HA_ALLOW_WRITE=true` +
`HA_ALLOW_CONFIG_WRITE=true` on the client (defence in depth — both the server
scope and the client guard must agree). Registry tools (areas/devices), logs and
history still need direct mode for now.

**ESPHome over the relay.** When you broker to a **relay-connected** Home
Assistant (your own HA linked via the Vome component's outbound tunnel), the
ESPHome dashboard's REST subset is brokered too — `esphome_list_devices`,
`esphome_get_config` and `esphome_save_config` work with no `ESPHOME_DASHBOARD_URL`
(reads need `ha:read`; saving YAML needs `ha:config` + the client write guards).
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
- MCP resources for entities/areas (in addition to tools).
- Optional HTTP/SSE transport for remote use.

---

## License

[MIT](./LICENSE) © Vortitron
