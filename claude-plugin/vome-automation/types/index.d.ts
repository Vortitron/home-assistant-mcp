export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** An automation's config as Home Assistant stores it (alias, triggers, conditions, actions, mode). */
export type AutomationConfig = { [key: string]: Json }

/** The automation the pane shows, and the version before the last save when there was one. */
export type AutomationView = {
  /** The MCP server it was read through, as the engine names it (`vome`, `home-assistant`, ...). */
  server: string
  id: string
  alias: string
  config: AutomationConfig
  /** The config before the last ha_set_automation, when the pane knew it: what the diff is against. */
  prev: AutomationConfig | null
  /** ISO time of the last save made through Vome, or null when the pane only read it. */
  savedAt: string | null
  /** The VomeHome instance the config came from, off the MCP's [vome-instance] stamp. */
  instance: string | null
  home: string | null
}

/** One step of a run, as ha_get_trace summarises it. */
export type RunStep = { path: string; result?: string; error?: string }

/** A run of the automation, as ha_get_trace summarises it. */
export type RunView = {
  runId: string
  started: string
  finished: string | null
  state: string | null
  execution: string | null
  trigger: string | null
  error: string | null
  failedAt: { path: string; reason: string } | null
  steps: RunStep[]
}

/** Watching for new runs after a save (or on request), until `until`. */
export type Watch = { id: string; instance: string | null; since: string; until: number }

/** A config the pane has seen, and the VomeHome instance it came from. */
export type Known = { instance: string | null; config: AutomationConfig }

/** Work the poller owes the pane: fetch a config by name, fetch the latest run. */
export type Pending = { automation?: string; run?: boolean; server?: string }

/** Rows lit for a few seconds: those a save changed, or those a new run went through. */
export type Flash = { at: number; paths: string[]; kind: 'change' | 'run' }

/** A device the interstitial shows: what it is called, its kind (the entity's domain), which way it went. */
export type Lamp = { label: string; isOn: boolean; domain: string }

/** What the interstitial acts out: lights switched, a save, a run that stopped, failed or simply ran. */
export type Interstitial =
  | { kind: 'switch'; lamps: Lamp[] }
  | { kind: 'saved'; caption: string }
  | { kind: 'stopped'; caption: string }
  | { kind: 'error'; caption: string }
  | { kind: 'ran'; caption: string }

/** The interstitial playing now, and when it started. */
export type Fx = { at: number; scene: Interstitial }

declare module 'claude-code' {
  interface PluginState {
    'vome-automation': {
      view: AutomationView | null
      run: RunView | null
      watch: Watch | null
      pending: Pending | null
      note: string | null
      /** Last config seen per automation id, and which home it was read from: the baseline a save is diffed against. */
      known: Record<string, Known>
      /** Home Assistant URL per VomeHome instance ('' once looked up and absent). */
      haUrls: Record<string, string>
      flash: Flash | null
      fx: Fx | null
      /** True from the model reading an automation until it saves or its turn ends: the swimmers play. */
      building: boolean
      /** Auto mode refused one of the pane's background reads: which, and on which server. */
      blocked: { server: string; tool: string; error: string; isDismissed: boolean } | null
      /** Connected MCP servers that carry our tools; empty means nothing to follow yet. */
      servers: string[]
      /** Whether the bulb strip plays; kept across sessions in $.store as well. */
      fxOn: boolean
    }
  }
}
