# vome-esphome: ESPHome at the side of Claude Code

A side pane for the ESPHome device Claude is working on. Claude reads and
edits YAML and runs builds that take minutes, and its tools answer only at the
end; this pane shows the device and the build as they are:

- **A map of the device**, from its YAML, whenever Claude reads, saves or
  builds a config: the board and framework, how it connects, its buses, every
  entity with its pins, what reacts to what (`on press → light.toggle`), and
  which pin does what. A pin used twice, or a strapping pin the chip boots
  from, is flagged. After a save, what it added, changed or removed is lit for
  a few seconds. Passwords and keys in the YAML are never shown.
- **The build as it runs**: the phase and a progress bar (compiling with its
  percentage, linking, uploading), the latest two lines of output with errors
  in red and warnings in yellow, and the result: "✓ Flashed in 2:41", or
  "✗ Failed after 1:02" with the first error. Press **l** for the whole log.
- **Your devices**, after Claude lists them, with the ones that have newer
  firmware waiting marked ↑.
- **A chip on the bench**, in the terminal, in round dots. Compiling is a
  forge: cogs turn and spark, object files fall onto the growing firmware.
  Flashing sends it to the chip in glittering whooshes. A good build ends in
  fireworks, a failed one in smoke. At rest the device's own things hang off
  the chip (a bulb glowing, a thermometer creeping, a button blinking), and
  with no device known it sleeps and dreams of some. Press **b** to turn it
  off.

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

## Allow its reads (auto mode)

The pane reads in the background with two of the MCP's read-only tools: the
build's progress (`esphome_activity`) and, when Claude builds a device it has
not read, its YAML for the map (`esphome_get_config`). In auto mode, Claude
Code refuses background calls that no request of yours is behind, unless
they're allowed by name; the pane then shows the exact lines to add and where.
Under your server's name, for example:

```json
{ "permissions": { "allow": ["mcp__vome__esphome_activity", "mcp__vome__esphome_get_config"] } }
```

With `vome-connect` the server is `plugin_vome-connect_vome`, so the lines are
`mcp__plugin_vome-connect_vome__esphome_activity` and
`mcp__plugin_vome-connect_vome__esphome_get_config`. Without them, the pane
still shows the elapsed time, the map of any config Claude reads, and the
output once the build finishes.

## Keys

| | |
| --- | --- |
| `/esphome` | open the pane |
| **l** | the whole build log, or back to the map and the latest lines |
| **b** | the chip animation off or on (remembered) |

If another pane is in front, the ESPHome tab's title says how the build is
going (`ESPHome · 45%`, `ESPHome ✓`).

## Privacy

The pane reads only from your own MCP server, through the connection Claude
Code already has: what the build commands Claude ran have printed, and the
YAML of the device being built.
Nothing is sent anywhere else.
