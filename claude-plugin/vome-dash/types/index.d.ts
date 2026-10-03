/** The dashboard in the pane: where it came from and its Lovelace config. */
export type Dash = {
  server: string
  urlPath: string
  title: string
  config: Record<string, unknown>
  at: number
}

/** A press on its way: sent to Home Assistant, accepted, and then seen to change the device (or not). */
export type Pending = {
  phase: 'sending' | 'sent' | 'done' | 'quiet' | 'failed'
  at: number
  /** The entity the press is about, and how it looked before, to see it change. */
  entity: string | null
  before: string | null
}

/** One entity's live state, as the pane last read it. */
export type Live = { state: string; attributes: Record<string, unknown>; at: number }

declare module 'claude-code' {
  interface PluginState {
    'vome-dash': {
      dash: Dash | null
      /** Which view is shown, by index. */
      view: number
      states: Record<string, Live>
      /** Cards a save added or changed, lit for a few seconds. */
      lit: { keys: string[]; at: number } | null
      /** Markdown cards with templates, as the home renders them, by card key. */
      rendered: Record<string, string>
      /** History graphs' series by card key, then entity: numbers, or the states it went through. */
      history: Record<string, Record<string, Array<number | string>>>
      /** A press that asks first: which control, until when. */
      confirm: { key: string; until: number } | null
      /** The home's dashboards: the sidebar. */
      choices: Array<{ urlPath: string; title: string }> | null
      /** Presses on their way, by control. */
      pending: Record<string, Pending>
      /** The dashboards sidebar, shown until one is picked. */
      sidebarOpen: boolean
      /** Auto mode refused one of the pane's calls: on which server, which tool. */
      blocked: { server: string; tool: string } | null
      note: string | null
    }
  }
}
