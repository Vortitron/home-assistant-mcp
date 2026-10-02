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

/** One line of a device's map (hooks/config.ts builds them). */
export type MapRow = {
  section: string
  depth: number
  icon: string
  label: string
  detail: string
}

export type RowChange = 'added' | 'changed' | 'removed'

/** The map of the device Claude last read or wrote, and what its latest save changed. */
export type ConfigView = {
  configuration: string
  name: string
  chip: string
  rows: MapRow[]
  /** Row keys (config.rowKey) a save added, changed or removed, shown for a few seconds. */
  changes: Record<string, RowChange>
  removed: MapRow[]
  changedAt: number | null
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
      config: ConfigView | null
      /** The whole build log instead of its last lines and the map. */
      showLog: boolean
    }
  }
}
