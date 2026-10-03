# vome-panes: all four Vome side panes for Claude Code

One install for every Vome pane. Each shows what Claude is doing to your Home
Assistant as it happens, beside the conversation:

| | |
| --- | --- |
| [**vome-automation**](../vome-automation/README.md) | the automation Claude is working on, what a save changed, which steps the latest run took |
| [**vome-esphome**](../vome-esphome/README.md) | a map of the ESPHome device from its YAML, and its builds and flashes as they run |
| [**vome-health**](../vome-health/README.md) | your home's health score and findings, with a Fix button on each |
| [**vome-dash**](../vome-dash/README.md) | one of your dashboards, working: live states, controls, cameras, graphs |

![Claude Code asked to set two lights to 40% and switch a socket on; the dashboard pane beside it lights them up as the home reports the change.](../../docs/images/vome-dash.gif)

## Quickstart

**1. Add the Vome app to Home Assistant**, then get a key from it. No sign-up needed.

[![Add the Vome app to your Home Assistant.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FVortitron%2FVomeSync)

The button opens your own Home Assistant and adds the app's repository. Pick
**Vome** and **Install**, open it, and on the **Agent** tab create a key.

**2. Paste these into Claude Code**, in a terminal (version 2.1.275 or newer):

```
/plugin install vome-connect --marketplace Vortitron/home-assistant-mcp
/plugin install vome-panes --marketplace Vortitron/home-assistant-mcp
/reload-plugins
```

The first connects your home and asks for the key from step 1; the second
installs the four panes. This plugin has nothing of its own: it lists the
four, so Claude Code installs them, and each can be turned off or removed on
its own afterwards.

**3. Ask Claude something about your home**, for example *"Make me a dashboard
for the lights"* or *"How healthy is my Home Assistant?"*. The pane for it
opens beside the conversation; the panes are tabs when more than one is open.

## Auto mode

Each pane reads in the background, read-only, and auto mode refuses background
calls nobody asked for unless they are allowed by name. Each pane shows the
exact lines when it needs them, and each README lists its own. The Vome app's
**Agent** tab and the key page on vome.io give the whole list at once.
