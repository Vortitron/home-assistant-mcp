# vome-esphome: watch an ESPHome build in Claude Code

A side pane that shows the ESPHome build Claude is running, while it runs. A
compile or a flash takes minutes, and Claude's tool returns its output only at
the end; this pane shows it as it happens:

- **The phase and a progress bar**: reading the configuration, compiling (with
  a count of files), linking, building the firmware image, uploading with its
  percentage, done.
- **The latest output**, with errors in red and warnings in yellow, and the
  first error picked out if the build fails.
- **The result**: "✓ Flashed in 2:41", or "✗ Failed after 1:02".
- **Your devices**, after Claude lists them, with the ones that have newer
  firmware waiting marked ↑.
- **A chip on the bench**, in the terminal: data streams into it while the
  build runs, its LED lights green when the flash succeeds, and a failed one
  lets a little smoke out. Press **b** to turn it off.

The pane only reads. It never starts a build: Claude does, with its own tool
calls, which you approve as usual.

## Quickstart

**1. Connect a Home Assistant that runs ESPHome, through Vome.** ESPHome's
dashboard is only reachable through the Vome app in Home Assistant, so a home
linked to Vome is needed. See [vome-connect](../vome-connect/README.md): one key
from the Vome app's Agent tab, no sign-up.

**2. Paste this into Claude Code** (version 2.1.275 or newer, in a terminal):

```
/plugin install vome-esphome --marketplace Vortitron/home-assistant-mcp
/reload-plugins
```

**3. Ask Claude to build something**, for example *"Update the living room
sensor's firmware"*. The pane opens when the build starts.

## Allow its read (auto mode)

The pane reads the build's progress in the background with the MCP's
read-only `esphome_activity` tool. In auto mode, Claude Code refuses
background calls that no request of yours is behind, unless they're allowed by
name; the pane then shows the exact line to add and where. Under your server's
name, for example:

```json
{ "permissions": { "allow": ["mcp__vome__esphome_activity"] } }
```

With `vome-connect` the server is `plugin_vome-connect_vome`, so the line is
`mcp__plugin_vome-connect_vome__esphome_activity`. Without it, the pane still
shows the elapsed time, and the output once the build finishes.

## Keys

| | |
| --- | --- |
| `/esphome` | open the pane |
| **b** | the chip animation off or on (remembered) |

## Privacy

The pane reads only from your own MCP server, through the connection Claude
Code already has, and only what the build commands Claude ran have printed.
Nothing is sent anywhere else.
