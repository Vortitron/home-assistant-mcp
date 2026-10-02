// Reads ESPHome's build and log output into what the pane shows: the phase a
// build is in, how far through it is where that is knowable, the errors and
// warnings, and each line's kind. Pure: no `$` here.
//
// ESPHome drives PlatformIO, whose output has a recognisable shape: one
// "Compiling <file>.o" per source file, then "Linking", then the firmware image,
// RAM and Flash usage, and for a flash an "Uploading: [====   ] 45%" bar that
// redraws itself with carriage returns.

export type Phase = 'starting' | 'config' | 'compiling' | 'linking' | 'image' | 'uploading' | 'done' | 'failed'

export type LineKind = 'error' | 'warning' | 'info' | 'debug' | 'plain'

export type Progress = {
  phase: Phase
  /** Source files compiled so far. */
  compiled: number
  /** Upload progress, 0 to 100, once uploading. */
  uploadPercent: number | null
  ram: string | null
  flash: string | null
  errors: string[]
  warnings: number
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g

/** Output chunks as display lines: colours removed, carriage-return redraws collapsed to their last state. */
export function toLines(chunks: string[]): string[] {
  const out: string[] = []
  for (const chunk of chunks) {
    for (const raw of chunk.replace(ANSI, '').split('\n')) {
      const last = raw.split('\r').filter(part => part.trim() !== '').at(-1)
      if (last !== undefined) out.push(last.trimEnd())
    }
  }
  return out
}

export function kindOf(line: string): LineKind {
  if (/\[E\]|^ERROR\b|\berror:|\bFAILED\b|Error \d+$/i.test(line) && !/\b0 errors?\b/i.test(line)) return 'error'
  if (/\[W\]|^WARNING\b|\bwarning:/i.test(line)) return 'warning'
  if (/\[I\]|^INFO\b/.test(line)) return 'info'
  if (/\[[DVC]\]/.test(line)) return 'debug'
  return 'plain'
}

/** Where a build is, from all its lines so far. */
export function progressOf(lines: string[], command: string): Progress {
  const p: Progress = { phase: 'starting', compiled: 0, uploadPercent: null, ram: null, flash: null, errors: [], warnings: 0 }
  for (const line of lines) {
    const kind = kindOf(line)
    if (kind === 'error') p.errors.push(line)
    if (kind === 'warning') p.warnings += 1
    if (/Reading configuration|Generating C\+\+ source|Configuration is valid/.test(line)) p.phase = higher(p.phase, 'config')
    if (/^Compiling .*\.o\b/.test(line)) {
      p.compiled += 1
      p.phase = higher(p.phase, 'compiling')
    }
    if (/^Linking /.test(line)) p.phase = higher(p.phase, 'linking')
    if (/^Building .*firmware\.(bin|elf|factory\.bin)|Successfully created .* image/i.test(line)) p.phase = higher(p.phase, 'image')
    const ram = /^RAM:\s+\[[^\]]*\]\s+([\d.]+%)/.exec(line)
    if (ram) p.ram = ram[1] ?? null
    const flash = /^Flash:\s+\[[^\]]*\]\s+([\d.]+%)/.exec(line)
    if (flash) p.flash = flash[1] ?? null
    const upload = /Uploading:\s+\[[=\s]*\]\s+(\d+)%/.exec(line)
    if (upload) {
      p.uploadPercent = Number(upload[1])
      p.phase = higher(p.phase, 'uploading')
    }
    if (/OTA successful|Successfully uploaded program/i.test(line)) p.uploadPercent = 100
  }
  if (command === 'validate' && p.phase === 'starting' && lines.length > 0) p.phase = 'config'
  return p
}

const ORDER: Phase[] = ['starting', 'config', 'compiling', 'linking', 'image', 'uploading', 'done', 'failed']

function higher(a: Phase, b: Phase): Phase {
  return ORDER.indexOf(b) > ORDER.indexOf(a) ? b : a
}

/** "1:23" from milliseconds. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** A text progress bar: `width` cells, filled to `percent`. */
export function bar(percent: number, width: number): string {
  const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * width)
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

/** What a phase reads as, for the status line. */
export function phaseWords(p: Progress, command: string): string {
  switch (p.phase) {
    case 'starting':
      return command === 'logs' ? 'Connecting to the device' : 'Starting'
    case 'config':
      return command === 'validate' ? 'Checking the configuration' : 'Reading the configuration'
    case 'compiling':
      return `Compiling (${p.compiled} file${p.compiled === 1 ? '' : 's'})`
    case 'linking':
      return 'Linking'
    case 'image':
      return 'Building the firmware image'
    case 'uploading':
      return `Uploading ${p.uploadPercent ?? 0}%`
    case 'done':
      return 'Done'
    case 'failed':
      return 'Failed'
  }
}
