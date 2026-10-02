# vome-connect: Home Assistant in Claude Code, through Vome

Connects Claude Code to your Home Assistant with one key and nothing to install
or run: it adds Vome's hosted MCP endpoint (`https://vome.io/mcp`), which runs
[`@vortitron/home-assistant-mcp`](../../README.md) for you. Claude can then read
and change your home: entities and their state, automations and their runs,
logs, dashboards and the rest of the MCP's tools, within what the key allows.

## Quickstart

**1. Add the Vome app to Home Assistant**, then get a key from it. No sign-up needed.

[![Add the Vome app to your Home Assistant.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FVortitron%2FVomeSync)

The button opens your own Home Assistant and adds the app's repository. Pick
**Vome** and **Install**, open it, and on the **Agent** tab create a key. A home
hosted on Vome gets its key at vome.io instead, under **Account → API tokens**.

**2. Paste this into Claude Code**, in a terminal (version 2.1.275 or newer):

```
/plugin install vome-connect --marketplace Vortitron/home-assistant-mcp
```

It asks for the key from step 1. Then run `/reload-plugins` and check with
`/mcp`.

**3. Ask Claude about your home**, for example *"Which lights are on?"*. To see
the automation Claude is working on in a side pane, add
[`vome-automation`](../vome-automation/README.md) too:

```
/plugin install vome-automation --marketplace Vortitron/home-assistant-mcp
```

## Get a key

- **Home Assistant on your own hardware:** install the Vome app in Home
  Assistant ([add it to your Home Assistant](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FVortitron%2FVomeSync): this opens your own Home
  Assistant and adds the app's repository; then pick **Vome** and **Install**),
  open it and go to the **Agent** tab. Tick what Claude may do and
  create a key; no account is needed. A key made this way is a trial that lasts
  two days, covering that one home; sign in to Vome from the app to keep it, and
  the same key carries on working.
- **A home hosted on Vome, or one you've linked:** at vome.io, open
  **Account → API tokens** and create a key, ticking the homes it may reach.

What a key may do is set where you made it, and Vome enforces it: it reaches
only the homes you ticked, through Vome's broker, never with a Home Assistant
token.

## Install

In Claude Code (2.1.275 or newer):

```
/plugin install vome-connect --marketplace Vortitron/home-assistant-mcp
```

Claude Code asks for the key (masked, and kept in its secure credential store,
not in a settings file) and, optionally, a home to start every session on. Then
run `/reload-plugins` and check with `/mcp`: the server is listed as
`plugin:vome-connect:vome`. To change the key later, run
`/plugin configure vome-connect@vome`.

If Vome's MCP server is already in your Claude Code config, added by hand
from the portal's or the app's JSON snippet or with `claude mcp add`, you
don't need this plugin. It adds the same server under a second name, which
would give Claude every tool twice. Remove one of the two.

## Which home

One key can reach several homes. Claude switches between them with
`vomehome_use_instance`, and a new session resumes the one you used last. To
have sessions always start on one home, set **Start on this home** to its
instance id.

## Pair it with the automation pane

[`vome-automation`](../vome-automation/README.md) shows the automation Claude is
working on in a side pane. In auto mode it needs its read-only tools allowed by
name; with this plugin the server's tools are named
`mcp__plugin_vome-connect_vome__<tool>`, and the pane shows the exact lines if a
read is refused.

## Privacy

The key goes only to `vome.io`, in the connection Claude Code makes to the MCP
endpoint. The plugin runs no code of its own on your machine.
