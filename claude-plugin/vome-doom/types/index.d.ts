/** Where a game is: what the pane draws. */
export type Phase = 'idle' | 'checking' | 'downloading' | 'reading' | 'building' | 'playing' | 'ended' | 'failed'

/** The game's status line, as house.wad's card shows it under the screen. */
export type Status = { room: string; aim: string; last: string; world: string }

declare module 'claude-code' {
  interface PluginState {
    'vome-doom': {
      phase: Phase
      /** One line about what is happening or went wrong. */
      note: string | null
      /** The screen in cells, once the game has said. */
      size: { columns: number; rows: number } | null
      status: Status | null
      /** Which home: the name the game titles its level with. */
      home: string | null
      /** Auto mode refused one of the pane's calls: on which server, and which tool. */
      blocked: { server: string; tool: string } | null
    }
  }
}
