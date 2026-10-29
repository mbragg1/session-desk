// Main-process benchmarks on synthetic fixtures: session scanning, search and
// the PTY output path. Run with `npm run bench:main` (BENCH_LABEL names the
// results file). Timings are wall-clock medians on this machine.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus, totalmem, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, it, vi } from 'vitest'
// @ts-expect-error plain JS helper
import { appendTurn, buildClaudeDir } from './fixtures.mjs'

const fakePty = vi.hoisted(() => ({ last: null as null | { emit: (d: string) => void } }))
vi.mock('node-pty', () => ({
  spawn: () => {
    let onData: (d: string) => void = () => {}
    const proc = {
      pid: 1,
      onData: (cb: (d: string) => void) => ((onData = cb), { dispose() {} }),
      onExit: () => ({ dispose() {} }),
      write() {},
      resize() {},
      kill() {}
    }
    fakePty.last = { emit: (d) => onData(d) }
    return proc
  }
}))

const ROOT = process.env.BENCH_DIR ?? join(tmpdir(), 'session-desk-bench')
const COUNTS = (process.env.BENCH_COUNTS ?? '1,10,25,50,100,250').split(',').map(Number)
const results: Record<string, unknown> = {
  label: process.env.BENCH_LABEL ?? 'run',
  at: new Date().toISOString(),
  machine: { cpu: cpus()[0]?.model, cores: cpus().length, memGB: Math.round(totalmem() / 2 ** 30), node: process.version }
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const ms = (n: number) => Math.round(n * 100) / 100

/** Fixture dirs are kept between runs (same seed, same bytes). */
function fixture(count: number): string {
  const dir = join(ROOT, `claude-${count}`)
  const marker = join(dir, '.ready')
  if (!existsSync(marker)) {
    buildClaudeDir(dir, count)
    writeFileSync(marker, '')
  }
  return dir
}

async function freshSessions() {
  vi.resetModules()
  const m = await import('../src/main/sessions')
  m.setTicketKeys(['ENG'])
  return m
}

describe('session scan', () => {
  for (const count of COUNTS) {
    it(`${count} sessions`, async () => {
      const dir = fixture(count)
      const cold: number[] = []
      let heapCold = 0
      for (let i = 0; i < 3; i++) {
        const { listSessions } = await freshSessions()
        global.gc?.()
        const h0 = process.memoryUsage().heapUsed
        const t = performance.now()
        await listSessions({ ownPids: new Set(), includeSdk: false, claudeDir: dir })
        cold.push(performance.now() - t)
        heapCold = Math.max(heapCold, process.memoryUsage().heapUsed - h0)
      }
      const { listSessions } = await freshSessions()
      const list = await listSessions({ ownPids: new Set(), includeSdk: false, claudeDir: dir })
      const warm: number[] = []
      for (let i = 0; i < 9; i++) {
        const t = performance.now()
        await listSessions({ ownPids: new Set(), includeSdk: false, claudeDir: dir })
        warm.push(performance.now() - t)
      }
      // One session working: its transcript grows between scans.
      const s = list[0]
      const grow: number[] = []
      for (let i = 0; i < 5; i++) {
        appendFileSync(s.transcriptPath, appendTurn(s.transcriptPath, s.id, i))
        const t = performance.now()
        await listSessions({ ownPids: new Set(), includeSdk: false, claudeDir: dir })
        grow.push(performance.now() - t)
      }
      // A relaunch: a fresh process seeded with the scan cache the last run saved (when this build has one).
      let relaunchMs: number | null = null
      const saver = (await import('../src/main/sessions')) as Record<string, any>
      if (typeof saver.serializeScanCache === 'function') {
        const saved = saver.serializeScanCache()
        const relaunches: number[] = []
        for (let i = 0; i < 3; i++) {
          const fresh = (await freshSessions()) as Record<string, any>
          const t = performance.now()
          fresh.restoreScanCache(saved)
          await fresh.listSessions({ ownPids: new Set(), includeSdk: false, claudeDir: dir })
          relaunches.push(performance.now() - t)
        }
        relaunchMs = ms(median(relaunches))
      }
      results[`scan.${count}`] = {
        relaunchWithSavedCacheMs: relaunchMs,
        sessions: list.length,
        coldMs: ms(median(cold)),
        warmNoChangeMs: ms(median(warm)),
        warmOneGrowingMs: ms(median(grow)),
        coldHeapDeltaMB: ms(heapCold / 2 ** 20),
        ipcPayloadKB: ms(JSON.stringify(list).length / 1024)
      }
    }, 600_000)
  }
})

describe('search', () => {
  for (const count of COUNTS.filter((c) => c >= 25)) {
    it(`${count} sessions`, async () => {
      const dir = fixture(count)
      vi.resetModules()
      const { searchTranscripts } = await import('../src/main/search')
      const projects = join(dir, 'projects')
      let t = performance.now()
      await searchTranscripts('state world', projects)
      const cold = performance.now() - t
      const warm: number[] = []
      for (const q of ['good people', 'little state work', 'never day', 'zzzz', 'the']) {
        t = performance.now()
        await searchTranscripts(q, projects)
        warm.push(performance.now() - t)
      }
      results[`search.${count}`] = { coldMs: ms(cold), warmMedianMs: ms(median(warm)), heapMB: ms(process.memoryUsage().heapUsed / 2 ** 20) }
    }, 600_000)
  }
})

/** Output like Claude Code's TUI while it streams: line rewrites, colours, the footer redrawn. */
function streamChunk(i: number): string {
  const text = `token ${i} `.repeat(1 + (i % 7))
  return `\x1b[2K\x1b[1G\x1b[38;2;200;200;200m${text}\x1b[39m` + (i % 5 === 0 ? `\x1b[s\x1b[40;1H\x1b[38;5;246m⏵⏵ auto mode on\x1b[39m\x1b[u` : '')
}

describe('pty output path', () => {
  it('streaming chunks and bulk output', async () => {
    vi.resetModules()
    const { PtyManager } = await import('../src/main/pty')
    let delivered = 0
    const mgr = new PtyManager(
      (_id, d) => (delivered += d.length),
      () => {}
    )
    const id = '11111111-1111-4111-8111-111111111111'
    mgr.start({ sessionId: id, resume: false, cwd: '/tmp', cols: 120, rows: 40 })
    const emit = fakePty.last!.emit
    // Fill the replay buffer first: a session that has been running a while.
    const filler = 'x'.repeat(16 * 1024)
    for (let i = 0; i < 40; i++) emit(filler)

    const N = 20_000
    let t = performance.now()
    for (let i = 0; i < N; i++) emit(streamChunk(i))
    const perChunkUs = ((performance.now() - t) / N) * 1000

    const bulk = 'y'.repeat(64 * 1024)
    const B = 2_000
    t = performance.now()
    for (let i = 0; i < B; i++) emit(bulk)
    const bulkMBps = (B * bulk.length) / 2 ** 20 / ((performance.now() - t) / 1000)
    const flushed = await new Promise<number>((r) => setTimeout(() => r(delivered), 50))
    results.pty = { streamPerChunkUs: ms(perChunkUs), bulkMBps: ms(bulkMBps), delivered: flushed }
  }, 120_000)
})

afterAll(() => {
  const out = join(__dirname, 'results')
  mkdirSync(out, { recursive: true })
  const file = join(out, `${results.label}-main.json`)
  const prev = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  writeFileSync(file, JSON.stringify({ ...prev, ...results }, null, 2) + '\n')
  console.log(JSON.stringify(results, null, 2))
})
