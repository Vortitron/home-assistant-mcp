/** The dashboard in the pane: where it came from and its Lovelace config. */
export type Dash = {
  server: string
  urlPath: string
  title: string
  config: Record<string, unknown>
  at: number
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
      /** The home's dashboards, while the picker is open. */
      choices: Array<{ urlPath: string; title: string }> | null
      /** Auto mode refused one of the pane's calls: on which server, which tool. */
      blocked: { server: string; tool: string } | null
      note: string | null
    }
  }
}
