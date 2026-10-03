# vome-health: your Home Assistant's health, beside Claude Code

A side pane with Vome's health score for your Home Assistant, out of 100, and
everything its check found, kept beside the conversation while Claude works
through it.

- **The score**, big, in the terminal, with a heart beating beside it,
  coloured by how the home is doing, and when it was checked.
- **What the check found, by severity**: *To fix*, *Worth doing*, *Fine*, each
  with what to do about it. Devices flooding the recorder, entities left
  behind by removed integrations, automations that are off or never run,
  batteries not reporting, error noise.
- **What Claude is working on**: when Claude changes something a finding is
  about (one of its entities, the recorder for a flooding sensor, an
  automation for the automation findings), the finding is marked ✎ until a
  re-check settles it.
- **The re-check**: press **r** (or ask Claude). The new score rolls in,
  findings it no longer has are struck through ✓, and a better score gets
  fireworks.

The pane never fixes anything itself: Claude does, with its own tool calls,
which you approve as usual. **r** only asks Vome for a fresh check.

## Quickstart

**1. Add the Vome app to Home Assistant**, then get a key from it. No sign-up needed.

[![Add the Vome app to your Home Assistant.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FVortitron%2FVomeSync)

The button opens your own Home Assistant and adds the app's repository. Pick
**Vome** and **Install**, open it, and on the **Agent** tab create a key.

**2. Paste these into Claude Code**, in a terminal (version 2.1.275 or newer):

```
/plugin install vome-connect --marketplace Vortitron/home-assistant-mcp
```

It asks for the key from step 1. Then:

```
/plugin install vome-health --marketplace Vortitron/home-assistant-mcp
/reload-plugins
```

**3. Ask Claude** *"How healthy is my Home Assistant? Fix what you can."* The
pane opens with the score. No score yet? Claude runs the first check, which
takes a couple of minutes.

## Allow its reads (auto mode)

The pane reads the report in the background while a check runs, with the
MCP's read-only `vome_health_report`; **r** calls `vome_health_check`. In auto
mode, Claude Code refuses background calls that no request of yours is behind
unless they're allowed by name, and the pane then shows the exact line. With
`vome-connect`:

```json
{ "permissions": { "allow": ["mcp__plugin_vome-connect_vome__vome_health_report"] } }
```

## Keys

| | |
| --- | --- |
| `/health` | open the pane and read the latest report |
| **r** | run a fresh check |
| **d** | each finding's evidence, not just its title |
| **b** | the animation off or on (remembered) |

## Privacy

The report is Vome's health check of your own Home Assistant, read from the
sensor the Vome integration keeps it on (`sensor.vome_health_score` or
similar). The pane reads it through the connection Claude Code already has;
nothing is sent anywhere else.
