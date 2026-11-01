import { execFile } from 'node:child_process'
import { totalmem } from 'node:os'
import type { MemoryReport, SessionMemory } from '../shared/types'

/**
 * Memory used by each session open here: its claude process and everything it
 * started (test runners, dev servers, browsers). macOS charges all of those to
 * this app, so a runaway test run shows up as "Session Desk is using 15 GB";
 * this says which session, and which of its processes.
 *
 * Resident memory (RSS) from one `ps` of every process: about 20 ms, against
 * about a second for `top`'s footprint. RSS leaves out what was compressed or
 * swapped out, so under memory pressure it reads low; a process that keeps
 * growing still crosses the warning lines on its way there.
 */
export const MEMORY_POLL_MS = 5000
/** Processes listed per session, largest first. */
const TOP_PROCESSES = 5
// Warning lines, as shares of the Mac's memory: 4 and 8 GB on a 24 GB Mac.
const WARN_SHARE = 1 / 6
const HIGH_SHARE = 1 / 3

export interface Proc {
  pid: number
  ppid: number
  pgid: number
  /** Bytes. */
  rss: number
  name: string
}

// Interpreters whose script says more than their own name ("node" alone names nothing).
const INTERPRETERS = /^(node|python[\d.]*|ruby|bun|deno|sh|bash|zsh)$/
const base = (p: string) => p.split('/').pop() || p

/** A short label for a command line: the program, or the script an interpreter runs ("vitest", "next-server"). */
export function processName(args: string): string {
  const words = args.trim().split(/\s+/)
  const exe = base(words[0] ?? '')
  if (!INTERPRETERS.test(exe)) return exe.slice(0, 60)
  // The first word that isn't a flag; npx/pnpm run scripts through node_modules/.bin.
  const script = words.slice(1).find((w) => !w.startsWith('-'))
  return script ? `${exe} ${base(script)}`.slice(0, 60) : exe
}

/** Parses `ps -axo pid=,ppid=,pgid=,rss=,args=` (rss in KB). */
export function parsePs(out: string): Proc[] {
  const procs: Proc[] = []
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (m) procs.push({ pid: +m[1], ppid: +m[2], pgid: +m[3], rss: +m[4] * 1024, name: processName(m[5]) })
  }
  return procs
}

/** What earlier samples saw: kept between calls to attribute(). */
export interface Seen {
  /** pid -> session. */
  pids: Map<number, string>
  /** Process group -> session, for groups that had a process of the session in them. */
  groups: Map<number, string>
}

export const newSeen = (): Seen => ({ pids: new Map(), groups: new Map() })

/**
 * Which session each process belongs to. A process belongs to the session
 * whose claude it descends from. One started in the background whose shell
 * then exited is re-parented to launchd (ppid 1): it's found by what an
 * earlier sample saw of it, or by its process group, which it keeps after
 * the shell that led it is gone. `seen` is updated in place and forgets
 * processes and groups that are gone.
 */
export function attribute(procs: Proc[], roots: Map<string, number>, seen: Seen): Map<string, Proc[]> {
  const children = new Map<number, Proc[]>()
  const byPid = new Map<number, Proc>()
  const liveGroups = new Set<number>()
  for (const p of procs) {
    byPid.set(p.pid, p)
    liveGroups.add(p.pgid)
    children.set(p.ppid, [...(children.get(p.ppid) ?? []), p])
  }
  for (const pid of seen.pids.keys()) if (!byPid.has(pid)) seen.pids.delete(pid)
  for (const g of seen.groups.keys()) if (!liveGroups.has(g)) seen.groups.delete(g)

  const owner = new Map<number, string>()
  const claim = (start: Proc, session: string) => {
    const queue = [start]
    while (queue.length) {
      const p = queue.pop()!
      if (owner.has(p.pid)) continue
      owner.set(p.pid, session)
      queue.push(...(children.get(p.pid) ?? []))
    }
  }
  for (const [session, pid] of roots) {
    const root = byPid.get(pid)
    if (root) claim(root, session)
  }
  for (const [pid, session] of owner) {
    const g = byPid.get(pid)!.pgid
    if (g > 1 && !seen.groups.has(g)) seen.groups.set(g, session)
  }
  for (const p of procs) {
    if (owner.has(p.pid) || p.ppid !== 1) continue
    const session = seen.pids.get(p.pid) ?? seen.groups.get(p.pgid)
    if (session && roots.has(session)) claim(p, session)
  }

  const out = new Map<string, Proc[]>()
  for (const [pid, session] of owner) {
    seen.pids.set(pid, session)
    out.set(session, [...(out.get(session) ?? []), byPid.get(pid)!])
  }
  return out
}

/** Per session: the total, and its largest processes with the same name added up ("node vitest × 4"). */
export function summarize(bySession: Map<string, Proc[]>): Record<string, SessionMemory> {
  const out: Record<string, SessionMemory> = {}
  for (const [session, procs] of bySession) {
    const byName = new Map<string, { bytes: number; count: number }>()
    for (const p of procs) {
      const e = byName.get(p.name) ?? { bytes: 0, count: 0 }
      e.bytes += p.rss
      e.count++
      byName.set(p.name, e)
    }
    out[session] = {
      bytes: procs.reduce((a, p) => a + p.rss, 0),
      processes: procs.length,
      top: [...byName]
        .map(([name, e]) => ({ name, ...e }))
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, TOP_PROCESSES)
    }
  }
  return out
}

export function thresholds(total = totalmem()): MemoryReport['thresholds'] {
  return { warn: Math.round(total * WARN_SHARE), high: Math.round(total * HIGH_SHARE), total }
}

function ps(): Promise<string> {
  return new Promise((resolve) =>
    execFile('ps', ['-axo', 'pid=,ppid=,pgid=,rss=,args='], { maxBuffer: 16 * 1024 * 1024 }, (err, out) => resolve(err ? '' : out))
  )
}

/**
 * Samples every MEMORY_POLL_MS while any session is open here. `onHigh` fires
 * once each time a session goes over the high line (again only after it has
 * dropped back under the warning line).
 */
export function watchMemory(
  roots: () => Map<string, number>,
  onReport: (r: MemoryReport) => void,
  onHigh: (sessionId: string, m: SessionMemory) => void
): () => void {
  const seen = newSeen()
  const alerted = new Set<string>()
  const limits = thresholds()
  let busy = false
  let wasEmpty = true
  const tick = async () => {
    const r = roots()
    if (busy) return
    if (!r.size) {
      seen.pids.clear()
      seen.groups.clear()
      alerted.clear()
      // One empty report, so the window stops showing the last numbers.
      if (!wasEmpty) onReport({ sessions: {}, thresholds: limits, at: Date.now() })
      wasEmpty = true
      return
    }
    busy = true
    try {
      const sessions = summarize(attribute(parsePs(await ps()), r, seen))
      for (const id of alerted) if (!sessions[id] || sessions[id].bytes < limits.warn) alerted.delete(id)
      for (const [id, m] of Object.entries(sessions)) {
        if (m.bytes >= limits.high && !alerted.has(id)) {
          alerted.add(id)
          onHigh(id, m)
        }
      }
      wasEmpty = false
      onReport({ sessions, thresholds: limits, at: Date.now() })
    } finally {
      busy = false
    }
  }
  void tick()
  const timer = setInterval(tick, MEMORY_POLL_MS)
  return () => clearInterval(timer)
}
