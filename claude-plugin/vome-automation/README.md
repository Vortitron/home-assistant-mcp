# vome-automation: an automation pane for Claude Code

A side pane in Claude Code that shows the Home Assistant automation Claude is
working on, kept up to date as Claude reads it, edits it and runs it.

- **The automation as Home Assistant's editor nests it.** Triggers, conditions
  and actions, with `choose`, `if`/`then`/`else`, `repeat` and `parallel`
  blocks indented the way the editor shows them.
- **What a save changed.** After Claude saves, each line is marked **+** added,
  **~** changed or **−** removed, and the changed lines light up for a few
  seconds.
- **What the latest run did.** Each step is marked ● ran, ✗ evaluated false
  (or errored) or ○ not reached, so "why didn't it fire?" is answered at a
  glance. Whenever Claude reads, refreshes or saves an automation, the pane
  watches for its runs for the next 30 minutes and tells you when one happens.
- **A car-stereo dot-matrix display.** When something happens, it is acted
  out for a few seconds: a bulb glides in and lights when a run turns a light
  on, a fan spins up, a blind opens, a lock snaps shut. A condition that
  stopped the run flickers and stays dark, an error pops, and a save screws a
  new bulb in. While Claude is working on an automation, bulbs swim across
  the display like the dolphins did. Press **b** to turn it off.

The pane only reads. It never changes anything in your home itself; every
change is Claude's own tool call, which you see and approve as usual.

## Connect Home Assistant first

The pane follows Claude's work through the Home Assistant MCP server,
[`@vortitron/home-assistant-mcp`](../../README.md). Connect that to Claude Code
before (or after) installing the pane; until it is connected, the pane says so
and shows these two ways in:

- **Through Vome (one key, nothing to run):** get a key from the Vome app's
  **Agent** tab in Home Assistant (no sign-up needed;
  [add the app to your Home Assistant](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FVortitron%2FVomeSync))
  or, for a home hosted on
  Vome, from vome.io under **Account → API tokens**. Then install
  [`vome-connect`](../vome-connect/README.md), which asks for the key:

  ```
  /plugin install vome-connect --marketplace Vortitron/home-assistant-mcp
  ```

- **Without Vome:** run the MCP on your machine with `npx`, pointed at your
  Home Assistant's address and a long-lived access token. See
  [Install](../../README.md#install) in the MCP's README.

Check it's connected with `/mcp`; the pane picks it up by itself.

## What it needs

- **[`@vortitron/home-assistant-mcp`](../../README.md)** connected to Claude
  Code. Any setup works: a home hosted on [Vome](https://vome.io), one linked
  through the Vome relay, or your own Home Assistant via `HA_URL` and a token.
  The server can have any name; the pane follows our tools whatever it is
  called. Other Home Assistant MCP servers are not supported; their tools and
  replies differ.
- **Claude Code 2.1.287 or newer, in a terminal.** The pane is drawn in the
  terminal. The VS Code and Cursor extensions don't show plugin panes yet, so
  run `claude` in a terminal there.
- **Plugins of function hooks enabled for you.** Panes like this one are an
  early-access Claude Code feature, being rolled out gradually. If yours
  doesn't have it yet, the plugin installs but doesn't load; nothing else
  is affected.

## Install

In Claude Code (2.1.275 or newer), one command adds the marketplace and
installs the pane:

```
/plugin install vome-automation --marketplace Vortitron/home-assistant-mcp
```

On an older Claude Code, use two:

```
/plugin marketplace add Vortitron/home-assistant-mcp
/plugin install vome-automation@vome
```

Then run `/reload-plugins`, or restart Claude Code.

### Get updates

Claude Code doesn't update plugins from a marketplace like this one unless you
ask it to. Turn it on once: run `/plugin`, open **Marketplaces**, select
**vome** and choose **Enable auto-update**. Or update by hand with
`claude plugin update vome-automation@vome`.

## Allow the pane's reads (auto mode)

The pane reads the latest run of the automation in the background, and checks
every 15 seconds for new ones while it watches. In **auto mode**, Claude
Code's safety check refuses background calls like these, because no request
of yours is behind them. The pane then shows a line such as
`$.mcp.call(vome, ha_get_trace) refused: The server-side auto mode classifier gave no verdict`,
and run marks and "it ran" notices are missing.

Allow the three read-only tools it uses, under **your** server's name. Find
the name with `claude mcp list`; the Vome portal's snippet calls it `vome`.
Add them to `~/.claude/settings.json` (every project) or the project's
`.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__vome__ha_get_automation",
      "mcp__vome__ha_get_trace",
      "mcp__vome__ha_list_traces",
      "mcp__vome__vomehome_get_instance"
    ]
  }
}
```

If you skip this, the pane turns into a "needs permission" screen the first
time a read is refused. It names the read, shows these exact lines for your
server with a button to copy them, links your `settings.json`, and quotes
what Claude Code said. **d** dismisses it and **h** brings it back.

Replace `vome` with your server's name, for example
`mcp__home-assistant__ha_get_trace` for a server named `home-assistant`. The
last line is only for homes on Vome: it lets the pane show an "Open in Home
Assistant" link. You can also add each one with `/permissions` → **Allow**.

These tools only read: an automation's config and its recorded runs. Allowing
them also lets Claude call them without asking, which it would mostly do
anyway.

## Using it

The pane opens on its own the first time Claude reads or saves an automation
through the MCP. On a narrow terminal (under 144 columns) it waits; open it
with `/automation`.

| | |
| --- | --- |
| `/automation` | open the pane |
| `/automation <id>` | show an automation by its id or `automation.` entity id |
| **r** | refresh the automation and its latest run |
| **w** | stop watching for runs, or start again (30 minutes) |
| **b** | the dot-matrix display off or on (remembered) |

The keys work while the pane has focus: click it, or press **ctrl+x** then **tab**.

## Troubleshooting

- **No pane at all.** Check you're in a terminal, not the VS Code or Cursor
  extension. `/automation` says where it is being drawn; "no surface is
  attached to draw it" means an editor extension. If `/automation` is an
  unknown command, the plugin didn't load: plugins of function hooks aren't
  enabled for you yet.
- **"No run shown yet" and a line about the classifier.** See
  [Allow the pane's reads](#allow-the-panes-reads-auto-mode).
- **"Vome now points at a different home".** The MCP was switched to another
  home (`vomehome_use_instance`) while the pane showed an automation from the
  first. The pane stops rather than mixing two homes up; ask Claude to read
  the automation again.
- **No dot-matrix display.** It draws only in the terminal, and only while
  something happens or Claude is working on an automation. If you turned it
  off, press **b**.

## Privacy

The pane talks only to your own MCP server, with the same connection Claude
Code already has, and only to read. It keeps what it shows in the Claude Code
session; the only thing stored between sessions is whether you turned the
display off. Nothing is sent anywhere else.

## Development

The hooks module is `hooks/register.tsx`. `hooks/flow.ts` turns an automation
and a run into the pane's rows, and `hooks/bulbs.ts` draws the display; both
are pure. Load a checkout with `claude --plugin-dir claude-plugin/vome-automation`
(saving a file reloads it), and run the tests with
`claude plugin test claude-plugin/vome-automation`. `claude plugin validate`
checks the plugin and the marketplace at the repository root.
