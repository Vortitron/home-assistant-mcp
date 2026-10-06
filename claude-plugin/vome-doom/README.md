# vome-doom: house.wad in a Claude Code pane

Your Home Assistant home as a Doom level, played in the terminal beside
Claude. The rooms are your areas, and lamps, plugs and screens are where they
really are. Shoot a lamp and it turns off for real. Use a door and its lock
opens, after a Y/N. House problems are the monsters: a lamp left burning, a
plug on standby, a window open while the heating runs.

It is [house.wad](https://github.com/Vortitron/housewad), the Lovelace card,
run by Node instead of a browser and drawn in coloured half blocks.

## Quickstart

**1. Add the Vome app to Home Assistant**, then get a key from it. No sign-up needed.

[![Add the Vome app to your Home Assistant.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FVortitron%2FVomeSync)

Open **Vome** and create a key on its **Agent** tab.

**2. In Claude Code**, in a terminal:

```
/plugin install vome-connect --marketplace Vortitron/home-assistant-mcp
/plugin install vome-doom --marketplace Vortitron/home-assistant-mcp
/reload-plugins
```

**3. Play:** `/doom`, then **Practice** (nothing in the house changes) or
**Play for real**. `/doom practice` and `/doom play` start one straight away.
Click the strip under the screen to give the game the keyboard.

It needs **Node 18 or newer** on the computer. The first game downloads its
data once, about 19 MB (house.wad's engine and Freedoom's free game data),
into `~/.cache/vome-doom`.

## Keys

| | |
| --- | --- |
| Arrows, or W A S D | move, turn and strafe |
| Space or F | fire |
| E | use (doors, switches) |
| Y / N | answer the door's question |
| 1 to 7 | weapons |
| M | the menu (a pane never sees Escape) |
| Esc | gives the keyboard back to Claude Code |

A terminal reports key presses but not releases, so a press holds the key for a
moment and holding it down keeps you moving.

## Auto mode

Starting a game reads the home in the background: `ha_list_areas`,
`ha_list_devices`, `ha_get_entity_registry`, `ha_list_entities` and
`ha_get_state`, all read-only. In auto mode Claude Code refuses background
calls nobody asked for unless they are allowed by name; when it does, the pane
shows the exact lines for your Vome server, a link to your `settings.json`, a
Copy button and Retry. With `vome-connect` they are:

```json
"mcp__plugin_vome-connect_vome__ha_list_areas",
"mcp__plugin_vome-connect_vome__ha_list_devices",
"mcp__plugin_vome-connect_vome__ha_get_entity_registry",
"mcp__plugin_vome-connect_vome__ha_list_entities",
"mcp__plugin_vome-connect_vome__ha_get_state"
```

Playing for real calls `ha_call_service` when you shoot a lamp or open a door.
Allowing that by name would let Claude change things without asking too, so the
pane leaves that choice to you: practise, play with auto mode off, or allow it
if you are happy to.

## What it can change

What house.wad's card can, by its own rules: lights, switches, media players
and vacuums. Switches whose names look important (a NAS, a router, a server
rack) are left alone, and a lock or door asks Y/N first. Practice changes
nothing.

## Credits

[house.wad](https://github.com/Vortitron/housewad) is GPL-2.0-or-later,
built on doomgeneric. [Freedoom](https://freedoom.github.io) is BSD-licensed.
This plugin downloads them; it does not include them.
