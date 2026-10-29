import { promises as fs, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type { PrLink, SessionSummary } from '../shared/types'
import { mapLimit } from './mapLimit'
import { claudeDir } from './paths'


// Linear team keys whose identifiers we look for: the connected workspace's
// teams (setTicketKeys); none until one is known. Lower-case branch names
// (me/eng-123) and worktree dirs (api-wt/eng-123) match too.
let ticketKeys: string[] = []
let TICKET_RE = ticketPattern(ticketKeys)

function ticketPattern(keys: string[]): RegExp {
  const alts = keys.map((k) => k.replace(/[^A-Za-z0-9]/g, '')).filter(Boolean)
  // No team keys yet (Linear not connected): nothing is a ticket.
  if (!alts.length) return /(?!)/g
  return new RegExp(`\\b(${alts.join('|')})-(\\d{2,6})\\b`, 'gi')
}

/** Uses these team keys for ticket detection; resolves true if they changed (transcripts are then re-read). */
export function setTicketKeys(keys: string[]): boolean {
  const next = [...new Set(keys.map((k) => k.toUpperCase()))].sort()
  if (!next.length || next.join() === ticketKeys.join()) return false
  ticketKeys = next
  TICKET_RE = ticketPattern(next)
  cache.clear()
  return true
}

// Where a ticket mention came from, weighted by how deliberately it was set.
// `ambientBranch` is whatever the repo had checked out when the session began;
// repos often sit on a stale feature branch, so that alone says little.
const WEIGHT = { customTitle: 4, branch: 3, cwd: 3, aiTitle: 2, ambientBranch: 1, prompt: 1 } as const

interface CacheEntry {
  mtimeMs: number
  size: number
  /** The file's identity: a different one at the same path is read from the start. */
  ino: number
  state: ParseState
  summary: Omit<SessionSummary, 'liveElsewhere' | 'archived' | 'groupId' | 'pinned' | 'activity' | 'launch'> | null
}

const cache = new Map<string, CacheEntry>()
// A parse holds a whole transcript (some are tens of MB) in memory; reading
// every changed one at once took a cold scan to 1.5 GB of a 4 GB heap.
const PARSE_CONCURRENCY = 4
// One read per file at a time: two scans feeding the same state would count its new lines twice.
const reading = new Map<string, Promise<CacheEntry['summary']>>()

export function ticketsIn(text: string | undefined): string[] {
  if (!text) return []
  return [...text.matchAll(TICKET_RE)].map((m) => `${m[1].toUpperCase()}-${m[2]}`)
}

function promptText(message: unknown): string | null {
  const content = (message as { content?: unknown } | undefined)?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const text = content.find((c) => c?.type === 'text')?.text
    return typeof text === 'string' ? text : null
  }
  return null
}

/**
 * What a transcript says so far. Transcripts only grow (lines are appended),
 * so a session that's working is read on from where the last read stopped:
 * re-reading whole files, several tens of MB each, on every change was the
 * main cost with several sessions running.
 */
interface ParseState {
  /** Bytes read so far, always up to the end of a whole line. */
  offset: number
  lineNo: number
  id: string
  startCwd: string
  entrypoint: string
  customTitle: string
  aiTitle: string
  firstPrompt: string
  lastActivity: number
  userTurns: number
  prs: Map<string, PrLink>
  // ticket -> [score, last line index seen]. Each (source, ticket) pair scores
  // once; otherwise a branch present on every turn outweighs a deliberate title.
  tickets: Map<string, [number, number]>
  scored: Set<string>
  firstBranch: string | undefined
  // Plan mode: ExitPlanMode calls, and whether one was approved.
  planCalls: Set<string>
  planApproved: boolean
  edited: boolean
  turnEndedAt: number
  // The latest reply's model and effort: what /model and /effort are set to now.
  model: string | null
  effort: string | null
  // Tokens in context at the latest reply: its input plus cache reads and writes.
  contextTokens: number | null
}

function newState(): ParseState {
  return {
    offset: 0,
    lineNo: 0,
    id: '',
    startCwd: '',
    entrypoint: '',
    customTitle: '',
    aiTitle: '',
    firstPrompt: '',
    lastActivity: 0,
    userTurns: 0,
    prs: new Map(),
    tickets: new Map(),
    scored: new Set(),
    firstBranch: undefined,
    planCalls: new Set(),
    planApproved: false,
    edited: false,
    turnEndedAt: 0,
    model: null,
    effort: null,
    contextTokens: null
  }
}

/** A copy of a string, so a short piece cut from a line can't keep the whole read alive in V8. */
const own = (text: string): string => JSON.parse(JSON.stringify(text))

/** Feeds whole lines (text ending at a line break, or a whole file) into the state. */
function feed(s: ParseState, text: string): void {
  const note = (found: string[], source: keyof typeof WEIGHT, at: number) => {
    for (const t of found) {
      const prev = s.tickets.get(t) ?? [0, 0]
      const key = `${source}:${t}`
      const add = s.scored.has(key) ? 0 : WEIGHT[source]
      s.scored.add(key)
      s.tickets.set(t, [prev[0] + add, Math.max(prev[1], at)])
    }
  }
  const lines = text.split('\n')
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]
    const i = s.lineNo++
    if (!line) continue
    // Model and effort are read straight off the line: every reply carries them,
    // and parsing each one would be the bulk of the scan.
    if (line.includes('"type":"assistant"') && !line.includes('"isSidechain":true')) {
      const m = MODEL_RE.exec(line)?.[1]
      // `<synthetic>` marks replies the CLI made up itself (errors, interrupts).
      if (m && !m.startsWith('<')) s.model = own(m)
      // The reply's own effort comes after its content, which may hold a tool
      // call's own "effort" (a subagent asked for low effort, say): take the last.
      const efforts = [...line.matchAll(EFFORT_RE)]
      if (efforts.length) s.effort = own(efforts[efforts.length - 1][1])
      // message.usage's own counts come first; quoted text is escaped, so it can't match.
      const tokens = TOKEN_KEYS.map((k) => Number(new RegExp(`"${k}":(\\d+)`).exec(line)?.[1] ?? NaN))
      if (!Number.isNaN(tokens[0])) s.contextTokens = tokens.reduce((a, n) => a + (Number.isNaN(n) ? 0 : n), 0)
    }
    // Cheap pre-filter: transcripts are large and most lines are tool output.
    const interesting =
      line.includes('"type":"user"') ||
      line.includes('"type":"custom-title"') ||
      line.includes('"type":"ai-title"') ||
      line.includes('"type":"pr-link"') ||
      (line.includes('"type":"assistant"') && TOOL_HINT.test(line)) ||
      line.includes('"subtype":"turn_duration"') ||
      (!s.startCwd && line.includes('"cwd"'))
    if (!interesting) continue
    let d: Record<string, any>
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    if (d.sessionId && !s.id) s.id = d.sessionId
    if (d.cwd && !s.startCwd) s.startCwd = d.cwd
    if (d.entrypoint && !s.entrypoint) s.entrypoint = d.entrypoint
    if (d.timestamp) s.lastActivity = Math.max(s.lastActivity, Date.parse(d.timestamp) || 0)

    switch (d.type) {
      case 'custom-title':
        s.customTitle = d.customTitle ?? s.customTitle
        note(ticketsIn(d.customTitle), 'customTitle', i)
        break
      case 'ai-title':
        s.aiTitle = d.aiTitle ?? s.aiTitle
        note(ticketsIn(s.aiTitle), 'aiTitle', i)
        break
      case 'system':
        if (d.subtype === 'turn_duration') s.turnEndedAt = Math.max(s.turnEndedAt, Date.parse(d.timestamp) || 0)
        break
      case 'assistant':
        for (const b of Array.isArray(d.message?.content) ? d.message.content : []) {
          if (b?.type !== 'tool_use') continue
          if (b.name === 'ExitPlanMode') s.planCalls.add(b.id)
          if (EDIT_TOOLS.has(b.name)) s.edited = true
        }
        break
      case 'pr-link':
        if (d.prUrl) s.prs.set(d.prUrl, { repo: d.prRepository, number: d.prNumber, url: d.prUrl })
        break
      case 'user': {
        if (d.isMeta || d.isSidechain) break
        const branch: string | undefined = d.gitBranch
        if (s.firstBranch === undefined) s.firstBranch = branch ?? ''
        if (branch && branch !== 'HEAD' && branch !== 'main' && branch !== 'master') {
          note(ticketsIn(branch), branch === s.firstBranch ? 'ambientBranch' : 'branch', i)
        }
        note(ticketsIn(d.cwd), 'cwd', i)
        if (s.planCalls.size && Array.isArray(d.message?.content)) {
          for (const b of d.message.content) {
            const result = typeof b?.content === 'string' ? b.content : Array.isArray(b?.content) ? b.content[0]?.text ?? '' : ''
            if (b?.type === 'tool_result' && s.planCalls.has(b.tool_use_id) && !b.is_error && result.startsWith(PLAN_APPROVED)) {
              s.planApproved = true
            }
          }
        }
        const text = promptText(d.message)
        if (text && !text.startsWith('<') && !d.toolUseResult) {
          s.userTurns++
          if (!s.firstPrompt) {
            s.firstPrompt = text
            note(ticketsIn(text), 'prompt', i)
          }
        }
        break
      }
    }
  }

}

/** The summary of what's been read so far; null until it has a session id and a prompt. */
function summarize(s: ParseState, path: string): CacheEntry['summary'] {
  if (!s.id || s.userTurns === 0) return null

  const ranked = [...s.tickets.entries()]
    .sort((a, b) => b[1][0] - a[1][0] || b[1][1] - a[1][1])
    .map(([t]) => t)

  let title = s.customTitle
  let titleSource: SessionSummary['titleSource'] = 'custom'
  if (!title && s.aiTitle) [title, titleSource] = [s.aiTitle, 'ai']
  if (!title && s.firstPrompt) [title, titleSource] = [s.firstPrompt.replace(/\s+/g, ' ').trim().slice(0, 80), 'prompt']
  if (!title) [title, titleSource] = [s.id.slice(0, 8), 'id']

  return {
    id: s.id,
    transcriptPath: path,
    startCwd: s.startCwd,
    title,
    titleSource,
    tickets: ranked,
    ticketSource: ranked.length ? 'transcript' : null,
    prs: [...s.prs.values()],
    entrypoint: s.entrypoint,
    lastActivity: s.lastActivity,
    plan: s.planApproved ? 'approved' : s.planCalls.size ? 'proposed' : 'none',
    worked: s.edited || s.prs.size > 0,
    turnEndedAt: s.turnEndedAt,
    model: s.model,
    effort: s.effort,
    contextTokens: s.contextTokens
  }
}

/** The cached summary, brought up to date by reading only what was appended. */
async function readSession(path: string): Promise<CacheEntry['summary']> {
  const st = await fs.stat(path)
  const hit = cache.get(path)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size && hit.ino === st.ino) return hit.summary
  let state = hit && hit.ino === st.ino ? hit.state : newState()
  if (!(await readOn(path, state, st.size))) {
    state = newState()
    await readOn(path, state, st.size)
  }
  const summary = summarize(state, path)
  cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, state, summary })
  return summary
}

export async function parseSession(path: string): Promise<CacheEntry['summary']> {
  const s = newState()
  feed(s, await fs.readFile(path, 'utf8'))
  return summarize(s, path)
}

/**
 * Reads what was appended since `s.offset`, up to the last whole line (a line
 * still being written is read next time). Resolves false when the file is
 * shorter than what was read, i.e. it was replaced: read it again from the start.
 */
async function readOn(path: string, s: ParseState, size: number): Promise<boolean> {
  if (size < s.offset) return false
  if (size === s.offset) return true
  const handle = await fs.open(path, 'r')
  try {
    const buf = Buffer.alloc(size - s.offset)
    const { bytesRead } = await handle.read(buf, 0, buf.length, s.offset)
    // A line break byte never falls inside a UTF-8 character, so cutting there is safe.
    const end = buf.subarray(0, bytesRead).lastIndexOf(0x0a)
    if (end < 0) return true
    feed(s, buf.toString('utf8', 0, end))
    s.offset += end + 1
    return true
  } finally {
    await handle.close()
  }
}

const MODEL_RE = /"model":"([^"]+)"/
const TOKEN_KEYS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']
const EFFORT_RE = /"effort":"([a-z]+)"/g

// Assistant lines are parsed only when they may call one of these (most are long tool chatter).
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const TOOL_HINT = /"name":"(ExitPlanMode|Edit|MultiEdit|Write|NotebookEdit)"/
/** How Claude Code words the ExitPlanMode result when you approve (measured on 2.1.29x). */
const PLAN_APPROVED = 'User has approved your plan'

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Claude Code registers each running process in ~/.claude/sessions/<pid>.json.
 * This is an internal format, so any read failure just means "unknown".
 */
async function liveSessions(
  ownPids: Set<number>,
  liveDir: string
): Promise<Map<string, { pid: number; entrypoint: string }>> {
  const live = new Map<string, { pid: number; entrypoint: string }>()
  let names: string[] = []
  try {
    names = await fs.readdir(liveDir)
  } catch {
    return live
  }
  await Promise.all(
    names
      .filter((n) => n.endsWith('.json'))
      .map(async (n) => {
        try {
          const d = JSON.parse(await fs.readFile(join(liveDir, n), 'utf8'))
          if (typeof d.pid !== 'number' || ownPids.has(d.pid) || !pidAlive(d.pid)) return
          if (d.sessionId) live.set(d.sessionId, { pid: d.pid, entrypoint: d.entrypoint ?? 'unknown' })
        } catch {
          // Torn write or unexpected shape; skip.
        }
      })
  )
  return live
}

export async function listSessions(opts: {
  ownPids: Set<number>
  includeSdk: boolean
  /** Claude Code's state folder; tests point this at fixtures. */
  claudeDir?: string
}): Promise<SessionSummary[]> {
  const base = opts.claudeDir ?? claudeDir()
  const projectsDir = join(base, 'projects')
  const files: string[] = []
  for (const dir of await fs.readdir(projectsDir).catch(() => [] as string[])) {
    const full = join(projectsDir, dir)
    for (const f of await fs.readdir(full).catch(() => [] as string[])) {
      if (f.endsWith('.jsonl')) files.push(join(full, f))
    }
  }

  const summaries = await mapLimit(files, PARSE_CONCURRENCY, async (path) => {
    try {
      const pending = reading.get(path)
      if (pending) return await pending
      const read = readSession(path)
      reading.set(path, read)
      try {
        return await read
      } finally {
        reading.delete(path)
      }
    } catch {
      return null
    }
  })

  if (!opts.claudeDir) pruneScanCache(new Set(files))
  const live = await liveSessions(opts.ownPids, join(base, 'sessions'))
  return summaries
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .filter((s) => opts.includeSdk || s.entrypoint !== 'sdk-cli')
    .map((s) => ({
      ...s,
      liveElsewhere: live.get(s.id) ?? null,
      archived: false,
      groupId: null,
      pinned: false,
      activity: null,
      launch: null
    }))
    .sort((a, b) => b.lastActivity - a.lastActivity)
}

// The scan cache on disk, so a launch reads only what was appended since the
// last run instead of every transcript in full (hundreds of MB for a long
// history). Bump the version whenever ParseState or what feed() reads changes.
const SCAN_CACHE_VERSION = 1

type SavedState = Omit<ParseState, 'prs' | 'tickets' | 'scored' | 'planCalls'> & {
  prs: [string, PrLink][]
  tickets: [string, [number, number]][]
  scored: string[]
  planCalls: string[]
}

/** The cache as JSON, for the ticket keys it was read with. */
export function serializeScanCache(): string {
  const entries: [string, Omit<CacheEntry, 'state'> & { state: SavedState }][] = []
  for (const [path, e] of cache) {
    const s = e.state
    entries.push([
      path,
      { ...e, state: { ...s, prs: [...s.prs], tickets: [...s.tickets], scored: [...s.scored], planCalls: [...s.planCalls] } }
    ])
  }
  return JSON.stringify({ version: SCAN_CACHE_VERSION, ticketKeys, entries })
}

/**
 * Seeds the cache from serializeScanCache() output. Ignored when it was made
 * by another version or for other ticket keys; entries are still checked
 * against each file's size, mtime and inode before use.
 */
export function restoreScanCache(json: string): boolean {
  let d: { version?: number; ticketKeys?: string[]; entries?: [string, CacheEntry & { state: SavedState }][] }
  try {
    d = JSON.parse(json)
  } catch {
    return false
  }
  if (d.version !== SCAN_CACHE_VERSION || d.ticketKeys?.join() !== ticketKeys.join() || !Array.isArray(d.entries)) return false
  for (const [path, e] of d.entries) {
    if (cache.has(path)) continue
    const s = e.state
    cache.set(path, {
      ...e,
      state: { ...s, prs: new Map(s.prs), tickets: new Map(s.tickets), scored: new Set(s.scored), planCalls: new Set(s.planCalls) }
    })
  }
  return true
}

/** Forgets files that no longer exist, so the saved cache doesn't grow forever. */
export function pruneScanCache(seen: Set<string>): void {
  for (const path of cache.keys()) if (!seen.has(path)) cache.delete(path)
}

/** Calls `onChange` (debounced) whenever any transcript or the live-session registry changes. */
export function watchSessions(onChange: () => void, base = claudeDir()): () => void {
  let timer: NodeJS.Timeout | undefined
  const fire = () => {
    clearTimeout(timer)
    timer = setTimeout(onChange, 750)
  }
  const watchers: FSWatcher[] = []
  for (const dir of [join(base, 'projects'), join(base, 'sessions')]) {
    try {
      watchers.push(watch(dir, { recursive: true }, fire))
    } catch {
      // Directory may not exist yet on a fresh install.
    }
  }
  return () => watchers.forEach((w) => w.close())
}
