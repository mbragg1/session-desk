import * as pty from 'node-pty'
import type { PermissionMode, PtyStartRequest } from '../shared/types'
import { claudeDirOverride } from './paths'
import { PLAN_KICKOFFS } from './ticketBrief'
import { statusLineLaunch } from './usage'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Variables a Claude host injects into its children (session ids, messaging
// sockets, the child-session marker that disables transcript saving, gateway
// URLs). If this app was itself launched from a Claude session they must not
// reach the claude we spawn. The login shell re-exports anything the user's
// own rc files set.
const HOST_ENV_RE = /^(CLAUDE|ANTHROPIC_|MCP_)/

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !HOST_ENV_RE.test(k)) env[k] = v
  }
  // The variables above are stripped, so a chosen non-default Claude folder
  // has to be passed on explicitly or sessions would use ~/.claude.
  const dir = claudeDirOverride()
  return { ...env, ...(dir ? { CLAUDE_CONFIG_DIR: dir } : {}), TERM: 'xterm-256color', COLORTERM: 'truecolor' }
}

// Replay buffer per terminal so a renderer reload can redraw what was on screen.
const SCROLLBACK_CHARS = 512 * 1024
// The footer is looked for in this much of the latest output.
const MODE_TAIL_CHARS = 3000
// …at most this often per session while output streams (the first chunk is read at once).
const MODE_CHECK_MS = 100

// Private modes (DECSET/DECRST) a program turns on once and relies on:
// bracketed paste, cursor keys, mouse and focus reporting, the alternate
// screen, cursor visibility.
const DECSET_RE = /\x1b\[\?([\d;]+)([hl])/g

/**
 * The last SCROLLBACK_CHARS of output (whole chunks), kept as the chunks that
 * arrived and joined only when a replay asks for it. Appending to one 512 KB
 * string copied it whole on every chunk, which was most of the main process's
 * time while sessions streamed.
 *
 * A replay starts with the private modes in force where the kept output
 * begins, so a terminal redrawn from it (a reload, or one unloaded while
 * hidden) pastes and reads keys the way the program set it up long ago.
 */
export class Replay {
  private chunks: string[] = []
  private head = 0
  private length = 0
  /** Mode -> 'h' | 'l', as of the oldest kept chunk. */
  private modes = new Map<string, string>()

  push(data: string): void {
    this.chunks.push(data)
    this.length += data.length
    // Drop whole chunks that are entirely older than the limit, keeping the modes they set.
    while (this.length - this.chunks[this.head].length >= SCROLLBACK_CHARS) {
      const old = this.chunks[this.head++]
      this.length -= old.length
      if (old.includes('\x1b[?')) {
        for (const m of old.matchAll(DECSET_RE)) for (const mode of m[1].split(';')) if (mode) this.modes.set(mode, m[2])
      }
    }
    if (this.head > 1024 && this.head * 2 > this.chunks.length) {
      this.chunks = this.chunks.slice(this.head)
      this.head = 0
    }
  }

  text(): string {
    let prefix = ''
    for (const [mode, v] of this.modes) prefix += `\x1b[?${mode}${v}`
    return prefix + (this.head ? this.chunks.slice(this.head) : this.chunks).join('')
  }
}

/** What a session that exited showed last, for redrawing its terminal; the most recent ones only. */
const ENDED_KEPT = 32

interface Term {
  proc: pty.IPty
  buffer: Replay
  /** The latest MODE_TAIL_CHARS of output. */
  tail: string
  /** Mode detection is throttled: a check is pending, and output arrived since the last one. */
  modeTimer?: NodeJS.Timeout
  modeDirty?: boolean
  /** The permission mode its footer shows last. */
  mode: PermissionMode | null
}

// Claude Code's footer names the mode ("⏵⏵ auto mode on", "⏸ plan mode on",
// …). It redraws only the cells that change, so the raw output loses letters
// ("m nual mode on", "ccept e its on"): the patterns allow for that. Measured
// on 2.1.295.
const MODE_PATTERNS: [PermissionMode, RegExp][] = [
  ['manual', /m.?n.?al mo.{0,3}on/],
  ['acceptEdits', /cc.?pt e.{0,3}its on/],
  ['plan', /pl.?n mo.{0,3}on/],
  ['auto', /a.?to mo.{0,3}on/],
  ['bypassPermissions', /bypass.{0,4}permissions on/],
  ['dontAsk', /don.?t ask/]
]
/** The order Shift+Tab steps through (bypass and don't-ask only when the session was started in them). */
export const MODE_CYCLE: PermissionMode[] = ['auto', 'manual', 'acceptEdits', 'plan']

// Global copies, compiled once: this runs on every output chunk.
const MODE_PATTERNS_G: [PermissionMode, RegExp][] = MODE_PATTERNS.map(([m, re]) => [m, new RegExp(re.source, 'g')])
const ESCAPES_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]/g

/** The mode the most recent footer text names, from raw terminal output; null if none. */
export function detectMode(raw: string): PermissionMode | null {
  const text = raw.replace(ESCAPES_RE, ' ').replace(/\s+/g, ' ')
  let best: { mode: PermissionMode; at: number } | null = null
  for (const [mode, re] of MODE_PATTERNS_G) {
    re.lastIndex = 0
    let at = -1
    for (let m = re.exec(text); m; m = re.exec(text)) at = m.index
    if (at >= 0 && (!best || at > best.at)) best = { mode, at }
  }
  return best?.mode ?? null
}

/** A session display name safe to pass to `claude --name`. */
export function cleanName(name: string): string {
  return name.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 120)
}

// Run through an interactive login shell so claude sees the same PATH and env
// as a Terminal.app launch (Finder-launched apps get a bare PATH). `exec` makes
// the pty's pid the claude pid. Args go in as positionals, never interpolated
// into the command string.
function spawnClaude(args: string[], cwd: string, cols: number, rows: number): pty.IPty {
  // Our status line, for this session only: it saves the context window and
  // plan limits Claude Code reports, then shows yours if you have one.
  const status = statusLineLaunch()
  return pty.spawn(process.env.SHELL || '/bin/zsh', ['-ilc', 'exec claude "$@"', 'claude', ...status.args, ...args], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: { ...cleanEnv(), ...status.env }
  })
}

export class PtyManager {
  private terms = new Map<string, Term>()
  private ended = new Map<string, string>()
  private headless = new Set<pty.IPty>()

  constructor(
    private onData: (sessionId: string, data: string) => void,
    /** `declinedBypass`: started in Bypass but exited before reaching it (its warning was declined). */
    private onExit: (sessionId: string, code: number, declinedBypass: boolean) => void,
    private onMode: (sessionId: string, mode: PermissionMode) => void = () => {}
  ) {}

  mode(sessionId: string): PermissionMode | null {
    return this.terms.get(sessionId)?.mode ?? null
  }

  /**
   * Switches the mode live, as Shift+Tab does in the terminal: presses it and
   * reads the footer until it names the wanted mode, at most once round the
   * cycle. Resolves with the mode reached.
   */
  async setMode(sessionId: string, want: PermissionMode): Promise<PermissionMode | null> {
    const t = this.terms.get(sessionId)
    if (!t) return null
    for (let i = 0; i < MODE_CYCLE.length + 2 && t.mode !== want; i++) {
      t.proc.write('\x1b[Z')
      const before = t.mode
      // Wait for the footer to redraw with the next mode.
      for (let w = 0; w < 20 && t.mode === before; w++) await new Promise((r) => setTimeout(r, 50))
      if (!this.terms.has(sessionId)) return null
    }
    return t.mode
  }

  /** PIDs of the claude processes we own, so the scanner doesn't flag them as "open elsewhere". */
  pids(): Set<number> {
    return new Set([...this.terms.values()].map((t) => t.proc.pid).concat([...this.headless].map((p) => p.pid)))
  }

  has(sessionId: string): boolean {
    return this.terms.has(sessionId)
  }

  /** What the session's terminal shows (running, or recently exited), to redraw it; '' if unknown. Starts nothing. */
  replay(sessionId: string): string {
    return this.terms.get(sessionId)?.buffer.text() ?? this.ended.get(sessionId) ?? ''
  }

  /**
   * `brief` is appended to Claude's system prompt: on new sessions, and on a
   * resume that kicks off ticket work. `prompt` is sent as the opening turn.
   */
  start(req: PtyStartRequest, brief?: string, prompt?: string): string {
    if (!UUID_RE.test(req.sessionId)) throw new Error(`not a session id: ${req.sessionId}`)
    const existing = this.terms.get(req.sessionId)
    if (existing) return existing.buffer.text()
    this.ended.delete(req.sessionId)

    const args = req.resume ? ['--resume', req.sessionId] : ['--session-id', req.sessionId]
    if (brief && (!req.resume || req.kickoff)) args.push('--append-system-prompt', brief)
    // Planning runs in plan mode: Claude can read but not edit until you approve.
    // The session's own model and effort: flags apply to this process only, unlike /model.
    if (req.launch?.model) args.push('--model', req.launch.model)
    if (req.launch?.effort) args.push('--effort', req.launch.effort)
    // Bypass can't be reached with Shift+Tab: it's chosen at launch (unless a plan kickoff sets plan mode).
    if (req.launch?.permissionMode === 'bypassPermissions' && !(prompt && req.kickoff && PLAN_KICKOFFS.has(req.kickoff))) {
      args.push('--permission-mode', 'bypassPermissions')
    }
    if (prompt && req.kickoff && PLAN_KICKOFFS.has(req.kickoff)) args.push('--permission-mode', 'plan')
    if (prompt) args.push('--', prompt)
    const proc = spawnClaude(args, req.cwd, req.cols, req.rows)
    const term: Term = { proc, buffer: new Replay(), tail: '', mode: null }
    this.terms.set(req.sessionId, term)

    proc.onData((data) => {
      term.buffer.push(data)
      this.onData(req.sessionId, data)
      term.tail = data.length >= MODE_TAIL_CHARS ? data.slice(-MODE_TAIL_CHARS) : (term.tail + data).slice(-MODE_TAIL_CHARS)
      // The footer's words arrive split by cursor moves, so a cheap pre-check
      // would miss them. Read the tail now, then at most every MODE_CHECK_MS
      // while output keeps coming (with dozens of sessions streaming, reading
      // it on every chunk was the main process's biggest cost).
      if (term.modeTimer) term.modeDirty = true
      else checkMode()
    })
    const checkMode = () => {
      term.modeDirty = false
      const mode = detectMode(term.tail)
      if (mode && mode !== term.mode) {
        term.mode = mode
        this.onMode(req.sessionId, mode)
      }
      term.modeTimer = setTimeout(() => {
        term.modeTimer = undefined
        if (term.modeDirty) checkMode()
      }, MODE_CHECK_MS)
    }
    proc.onExit(({ exitCode }) => {
      clearTimeout(term.modeTimer)
      this.terms.delete(req.sessionId)
      this.ended.delete(req.sessionId)
      this.ended.set(req.sessionId, term.buffer.text())
      if (this.ended.size > ENDED_KEPT) this.ended.delete(this.ended.keys().next().value!)
      const declinedBypass = args.includes('bypassPermissions') && term.mode !== 'bypassPermissions'
      this.onExit(req.sessionId, exitCode, declinedBypass)
    })
    return ''
  }

  /**
   * Resumes a session with no terminal attached, polls `done` until it reports
   * true (or the timeout passes), then stops the process. Nothing is typed into
   * it, so no turn is sent. Resolves whether `done` succeeded.
   */
  async runHeadless(
    sessionId: string,
    cwd: string,
    extraArgs: string[],
    done: () => Promise<boolean>,
    timeoutMs = 30_000
  ): Promise<boolean> {
    if (!UUID_RE.test(sessionId)) throw new Error(`not a session id: ${sessionId}`)
    const proc = spawnClaude(['--resume', sessionId, ...extraArgs], cwd, 120, 40)
    this.headless.add(proc)
    let exited = false
    proc.onExit(() => (exited = true))
    try {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline && !exited) {
        if (await done()) return true
        await new Promise((r) => setTimeout(r, 400))
      }
      return await done()
    } finally {
      if (!exited) proc.kill()
      this.headless.delete(proc)
    }
  }

  write(sessionId: string, data: string): void {
    this.terms.get(sessionId)?.proc.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.terms.get(sessionId)?.proc.resize(cols, rows)
  }

  kill(sessionId: string): void {
    this.terms.get(sessionId)?.proc.kill()
  }

  /**
   * Stops the session's process and resolves once it has exited (SIGKILL after
   * 5s), after the exit has been reported, so a restart never races it.
   */
  stop(sessionId: string): Promise<void> {
    const t = this.terms.get(sessionId)
    if (!t) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          t.proc.kill('SIGKILL')
        } catch {
          // Already gone.
        }
      }, 5000)
      const sub = t.proc.onExit(() => {
        clearTimeout(timer)
        sub.dispose()
        resolve()
      })
      t.proc.kill()
    })
  }

  killAll(): void {
    for (const t of this.terms.values()) t.proc.kill()
    for (const p of this.headless) p.kill()
  }
}
