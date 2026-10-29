import { appendFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectMode, Replay } from '../src/main/pty'
import { BACKGROUND_FLUSH_MS, PtyBatcher } from '../src/main/ptyBatch'
import { listSessions, restoreScanCache, serializeScanCache, setTicketKeys } from '../src/main/sessions'
import { tmp, userTurn, writeTranscript } from './helpers'

describe('replay buffer', () => {
  it('replays exactly what one growing string cut to the last 512 KB would', () => {
    const r = new Replay()
    let whole = ''
    for (let i = 0; i < 3000; i++) {
      const chunk = String.fromCharCode(97 + (i % 26)).repeat(1 + ((i * 37) % 900))
      r.push(chunk)
      whole = (whole + chunk).slice(-512 * 1024)
    }
    expect(r.text()).toBe(whole)
  })

  it('keeps a single chunk bigger than the limit, cut to it', () => {
    const r = new Replay()
    r.push('x'.repeat(600 * 1024) + 'end')
    expect(r.text().length).toBe(512 * 1024)
    expect(r.text().endsWith('end')).toBe(true)
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
