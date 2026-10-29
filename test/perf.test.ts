import { appendFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectMode, Replay } from '../src/main/pty'
import { BACKGROUND_FLUSH_MS, PtyBatcher } from '../src/main/ptyBatch'
import { listSessions, restoreScanCache, serializeScanCache, setTicketKeys } from '../src/main/sessions'
import { tmp, userTurn, writeTranscript } from './helpers'

describe('replay buffer', () => {
  const LIMIT = 512 * 1024

  it('keeps at least the last 512 KB, in whole chunks (never cutting a sequence in half)', () => {
    const r = new Replay()
    let whole = ''
    const chunks: string[] = []
    for (let i = 0; i < 3000; i++) {
      const chunk = String.fromCharCode(97 + (i % 26)).repeat(1 + ((i * 37) % 900))
      r.push(chunk)
      chunks.push(chunk)
      whole += chunk
    }
    const text = r.text()
    expect(whole.endsWith(text)).toBe(true)
    expect(text.length).toBeGreaterThanOrEqual(LIMIT)
    expect(text.length).toBeLessThan(LIMIT + 900)
    // It starts where a chunk started.
    let at = whole.length
    const starts = new Set<number>()
    for (let i = chunks.length - 1; i >= 0; i--) starts.add((at -= chunks[i].length))
    expect(starts.has(whole.length - text.length)).toBe(true)
  })

  it('keeps a single chunk bigger than the limit whole', () => {
    const r = new Replay()
    r.push('x'.repeat(600 * 1024) + 'end')
    expect(r.text().length).toBe(600 * 1024 + 3)
  })

  it('starts with the private modes set by output it no longer holds', () => {
    const r = new Replay()
    // Bracketed paste and mouse reporting on at launch, mouse later off, then lots of output.
    r.push('\x1b[?2004h\x1b[?1000;1006h')
    r.push('\x1b[?1000l')
    for (let i = 0; i < 700; i++) r.push('y'.repeat(1024))
    const text = r.text()
    expect(text.startsWith('\x1b[?2004h\x1b[?1000l\x1b[?1006h')).toBe(true)
    expect(text.includes('\x1b[?1000;1006h')).toBe(false)
  })
})

describe('mode detection is repeatable', () => {
  it('gives the same answer when called again (global regexes reset)', () => {
    const out = '⏵⏵ auto mode on … ⏸ plan mode on'
    expect(detectMode(out)).toBe('plan')
    expect(detectMode(out)).toBe('plan')
    expect(detectMode('⏵⏵ auto mode on')).toBe('auto')
  })
})

describe('terminal output batching', () => {
  afterEach(() => vi.useRealTimers())

  it("sends the visible session's output at the end of the turn, in order, merged", async () => {
    const sent: [string, string][][] = []
    const b = new PtyBatcher((batch) => sent.push(batch), () => 'a')
    b.push('a', 'one ')
    b.push('a', 'two')
    expect(sent).toEqual([])
    await new Promise((r) => setImmediate(r))
    expect(sent).toEqual([[['a', 'one two']]])
  })

  it('holds background output for at most a frame', () => {
    vi.useFakeTimers()
    const sent: [string, string][][] = []
    const b = new PtyBatcher((batch) => sent.push(batch), () => null)
    b.push('a', '1')
    b.push('b', '2')
    b.push('a', '3')
    vi.advanceTimersByTime(BACKGROUND_FLUSH_MS - 1)
    expect(sent).toEqual([])
    vi.advanceTimersByTime(1)
    expect(sent).toEqual([[['a', '13'], ['b', '2']]])
  })

  it('flush() sends what is held at once (before an exit notice)', () => {
    const sent: [string, string][][] = []
    const b = new PtyBatcher((batch) => sent.push(batch), () => null)
    b.push('a', 'last words')
    b.flush()
    expect(sent).toEqual([[['a', 'last words']]])
    b.flush()
    expect(sent.length).toBe(1)
  })
})

describe('scan cache on disk', () => {
  const ID = '55555555-5555-4555-8555-555555555555'

  it('a restored cache reads on from where it stopped and matches a fresh scan', async () => {
    setTicketKeys(['ENG'])
    const dir = tmp()
    const path = writeTranscript(dir, ID, [userTurn('fix ENG-1234 login', { gitBranch: 'me/eng-1234-login' })])
    const scan = async () => (await listSessions({ ownPids: new Set(), includeSdk: true, claudeDir: dir })).find((s) => s.id === ID)
    await scan()
    const saved = serializeScanCache()

    // A new run: other keys clear the cache, the originals come back, then the saved cache.
    setTicketKeys(['OPS'])
    setTicketKeys(['ENG'])
    expect(restoreScanCache(saved)).toBe(true)
    appendFileSync(path, JSON.stringify({ type: 'custom-title', sessionId: ID, customTitle: 'ENG-1234 renamed' }) + '\n')
    const resumed = await scan()

    setTicketKeys(['OPS'])
    setTicketKeys(['ENG'])
    expect(resumed).toEqual(await scan())
    expect(resumed).toMatchObject({ title: 'ENG-1234 renamed', tickets: ['ENG-1234'] })
  })

  it('ignores a cache made for other ticket keys or another version', () => {
    setTicketKeys(['ENG'])
    const saved = JSON.parse(serializeScanCache())
    expect(restoreScanCache(JSON.stringify({ ...saved, ticketKeys: ['OPS'] }))).toBe(false)
    expect(restoreScanCache(JSON.stringify({ ...saved, version: -1 }))).toBe(false)
    expect(restoreScanCache('not json')).toBe(false)
  })
})

describe('reading a transcript in pieces', () => {
  const ID = '77777777-7777-4777-8777-777777777777'

  it('gives what reading it whole does, with lines across piece boundaries and one longer than a piece', async () => {
    setTicketKeys(['ENG'])
    const dir = tmp()
    const filler = (n: number) => ({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'é€'.repeat(n) }] },
      toolUseResult: {}
    })
    const path = writeTranscript(dir, ID, [
      userTurn('fix ENG-4242 first'),
      ...Array.from({ length: 30 }, (_, i) => filler(100_000 + i * 1_337)),
      // About 6 MB of UTF-8 in one line: longer than a 4 MB piece.
      filler(1_000_000),
      { type: 'custom-title', customTitle: 'ENG-4242 after the long line' },
      userTurn('and then this', { gitBranch: 'me/eng-4243-next' })
    ])
    const scanned = (await listSessions({ ownPids: new Set(), includeSdk: true, claudeDir: dir })).find((s) => s.id === ID)
    const { parseSession } = await import('../src/main/sessions')
    expect(scanned).toMatchObject((await parseSession(path))!)
    expect(scanned).toMatchObject({ title: 'ENG-4242 after the long line', tickets: ['ENG-4242', 'ENG-4243'] })
  })
})
