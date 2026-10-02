/** One build command Claude ran (validate, compile, upload or logs) and what it has produced. */
export type Build = {
  /** The MCP server it ran on, as the engine names it. */
  server: string
  command: string
  configuration: string
  startedAt: number
  finishedAt: number | null
  /** Display lines so far (the last few hundred). */
  lines: string[]
  /** The newest esphome_activity sequence seen, to ask only for what follows. */
  seq: number
  /** True once lines have arrived while it ran; false when they came only at the end. */
  isLive: boolean
  outcome: 'running' | 'ok' | 'failed'
  error: string | null
}

/** A device the dashboard knows, from esphome_list_devices. */
export type Device = {
  name: string
  configuration: string
  deployed: string | null
  current: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'vome-esphome': {
      build: Build | null
      devices: Device[] | null
      /** Auto mode refused the pane's read of esphome_activity: on which server. */
      blocked: { server: string; error: string } | null
      /** Whether the chip strip plays; kept across sessions in $.store as well. */
      fxOn: boolean
    }
  }
}
