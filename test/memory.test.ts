import { describe, expect, it } from 'vitest'
import { attribute, newSeen, parsePs, processName, summarize, thresholds, type Proc } from '../src/main/memory'
import { formatBytes } from '../src/shared/memory'
import { memoryTone } from '../src/renderer/src/components/MemoryButton'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const MB = 1024 * 1024
const proc = (pid: number, ppid: number, mb: number, name = 'node', pgid = pid): Proc => ({ pid, ppid, pgid, rss: mb * MB, name })

describe('processName', () => {
  it('names an interpreter by the script it runs', () => {
    expect(processName('node /repo/node_modules/.bin/../vitest/vitest.mjs run --coverage')).toBe('node vitest.mjs')
    expect(processName('/usr/local/bin/node --max-old-space-size=4096 ./node_modules/.bin/tsc --noEmit')).toBe('node tsc')
    expect(processName('.venv/bin/python worker.py')).toBe('python worker.py')
  })

  it('names anything else by its program', () => {
    expect(processName('/Applications/Chrome.app/Contents/MacOS/chrome-headless-shell --headless')).toBe('chrome-headless-shell')
    expect(processName('next-server (v15.5.19)')).toBe('next-server')
    expect(processName('node')).toBe('node')
  })
})

describe('parsePs', () => {
  it('reads pid, ppid, group and resident KB, and skips what it cannot read', () => {
    const out = '  101     1   101  2048 claude --resume x\n  102   101   102 1048576 node ./node_modules/.bin/vitest run\nnonsense\n'
    expect(parsePs(out)).toEqual([
      { pid: 101, ppid: 1, pgid: 101, rss: 2 * MB, name: 'claude' },
      { pid: 102, ppid: 101, pgid: 102, rss: 1024 * MB, name: 'node vitest' }
    ])
  })
})

describe('attribute', () => {
  it('gives each session its claude and everything under it', () => {
    const procs = [proc(1, 0, 1), proc(10, 1, 300, 'claude'), proc(11, 10, 50, 'zsh'), proc(12, 11, 900), proc(20, 1, 200, 'claude'), proc(99, 1, 4000, 'python')]
    const out = attribute(procs, new Map([[A, 10], [B, 20]]), newSeen())
    expect(out.get(A)!.map((p) => p.pid).sort()).toEqual([10, 11, 12])
    expect(out.get(B)!.map((p) => p.pid)).toEqual([20])
  })

  it('keeps a background process whose shell exited, by what was seen of it', () => {
    const seen = newSeen()
    const roots = new Map([[A, 10]])
    attribute([proc(10, 1, 300, 'claude'), proc(11, 10, 5, 'zsh'), proc(12, 11, 800, 'node')], roots, seen)
    // The shell is gone; the server is now launchd's child.
    const later = attribute([proc(10, 1, 300, 'claude'), proc(12, 1, 900, 'node')], roots, seen)
    expect(later.get(A)!.map((p) => p.pid).sort()).toEqual([10, 12])
  })

  it('keeps a process never seen under the session when its group was, and its children with it', () => {
    const seen = newSeen()
    const roots = new Map([[A, 10]])
    attribute([proc(10, 1, 300, 'claude'), proc(11, 10, 5, 'zsh', 11)], roots, seen)
    // Started and orphaned between samples; its group leader (the shell) is gone too.
    const later = attribute([proc(10, 1, 300, 'claude'), proc(13, 1, 900, 'node', 11), proc(14, 13, 400, 'node', 11)], roots, seen)
    expect(later.get(A)!.map((p) => p.pid).sort()).toEqual([10, 13, 14])
  })

  it('does not claim unrelated orphans, and forgets sessions that closed', () => {
    const seen = newSeen()
    attribute([proc(10, 1, 300, 'claude'), proc(11, 10, 5)], new Map([[A, 10]]), seen)
    const out = attribute([proc(11, 1, 5), proc(50, 1, 4000, 'python')], new Map(), seen)
    expect(out.size).toBe(0)
  })

  it('forgets processes that are gone, so a reused pid is not claimed', () => {
    const seen = newSeen()
    const roots = new Map([[A, 10]])
    attribute([proc(10, 1, 300, 'claude'), proc(11, 10, 5, 'zsh', 10)], roots, seen)
    attribute([proc(10, 1, 300, 'claude')], roots, seen)
    expect(seen.pids.has(11)).toBe(false)
    // Same pid, another program in another group, under launchd.
    const out = attribute([proc(10, 1, 300, 'claude'), proc(11, 1, 700, 'other', 500)], roots, seen)
    expect(out.get(A)!.map((p) => p.pid)).toEqual([10])
  })
})

describe('summarize', () => {
  it('totals a session and lists its largest programs, same names added up', () => {
    const procs = [proc(10, 1, 300, 'claude'), proc(12, 10, 900, 'node vitest'), proc(13, 10, 600, 'node vitest'), proc(14, 10, 100, 'zsh')]
    const s = summarize(new Map([[A, procs]]))[A]
    expect(s.bytes).toBe(1900 * MB)
    expect(s.processes).toBe(4)
    expect(s.top[0]).toEqual({ name: 'node vitest', bytes: 1500 * MB, count: 2 })
    expect(s.top.map((t) => t.name)).toEqual(['node vitest', 'claude', 'zsh'])
  })
})

describe('warning lines', () => {
  const t = thresholds(24 * 1024 * MB)

  it('are 4 and 8 GB on a 24 GB Mac', () => {
    expect(t.warn).toBe(4 * 1024 * MB)
    expect(t.high).toBe(8 * 1024 * MB)
  })

  it('tone the reading', () => {
    const m = (gb: number) => ({ bytes: gb * 1024 * MB, processes: 1, top: [] })
    expect(memoryTone(m(1), t)).toBeUndefined()
    expect(memoryTone(m(5), t)).toBe('warn')
    expect(memoryTone(m(9), t)).toBe('bad')
    expect(memoryTone(undefined, t)).toBeUndefined()
  })

  it('format as MB or GB', () => {
    expect(formatBytes(340 * MB)).toBe('340 MB')
    expect(formatBytes(9.1 * 1024 * MB)).toBe('9.1 GB')
  })
})
