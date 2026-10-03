/** One thing Vome's health check found, as the MCP's vome_health_report returns it. */
export type Finding = {
  id: string
  category: string
  severity: string
  title: string
  evidence?: string
  recommendation?: string
  /** The entities it is about, when it is about some. */
  entities?: string[]
}

export type Category = { id: string; label: string; severity: string }

/** The home's latest health report, and where it was read from. */
export type Report = {
  server: string
  /** The home's name, from the reply's `[vome-instance]` stamp. */
  home: string
  entityId: string
  score: number | null
  summary: string
  /** ISO time the check ran. */
  generatedAt: string | null
  categories: Category[]
  findings: Finding[]
  healthUrl: string | null
}

/** What the latest check changed against the one before it. */
export type Change = {
  from: number | null
  to: number | null
  at: number
  /** Findings the new check no longer has. */
  resolved: Finding[]
  /** Finding ids that are new in this check. */
  added: string[]
}

/** A check that is running: the report it should replace. */
export type Checking = { server: string; startedAt: number; previousGeneratedAt: string | null }

declare module 'claude-code' {
  interface PluginState {
    'vome-health': {
      report: Report | null
      change: Change | null
      checking: Checking | null
      /** Finding ids Claude has changed something for since the report, and when. */
      touched: Record<string, number>
      /** Findings handed to Claude with Fix, and when. */
      asked: Record<string, number>
      /** Each finding's evidence and recommendation, not just its title. */
      details: boolean
      fxOn: boolean
      /** Auto mode refused one of the pane's background calls: on which server, and which tool. */
      blocked: { server: string; tool: string } | null
      note: string | null
    }
  }
}
