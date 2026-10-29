import { afterEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ emit: (_d: string) => {} }))
vi.mock('node-pty', () => ({
  spawn: () => ({
    pid: 1,
    onData: (cb: (d: string) => void) => ((fake.emit = cb), { dispose() {} }),
    onExit: () => ({ dispose() {} }),
    write() {},
    resize() {},
    kill() {}
  })
}))

import { PtyManager } from '../src/main/pty'

const ID = '66666666-6666-4666-8666-666666666666'

describe('mode detection while output streams', () => {
  afterEach(() => vi.useRealTimers())

  it('reports the first footer at once and a later change within 100ms', () => {
    vi.useFakeTimers()
    const modes: string[] = []
    const mgr = new PtyManager(() => {}, () => {}, (_id, m) => modes.push(m))
    mgr.start({ sessionId: ID, resume: false, cwd: '/tmp', cols: 80, rows: 24 })
    fake.emit('⏵⏵ auto mode on')
    expect(modes).toEqual(['auto'])
    // Shift+Tab: the footer changes while output is still arriving.
    fake.emit('some output ⏸ plan mode on')
    fake.emit('more output')
    expect(modes).toEqual(['auto'])
    vi.advanceTimersByTime(100)
    expect(modes).toEqual(['auto', 'plan'])
    expect(mgr.mode(ID)).toBe('plan')
    // Quiet again: nothing pending, the next footer is read at once.
    vi.advanceTimersByTime(100)
    fake.emit('⏵⏵ accept edits on')
    expect(modes).toEqual(['auto', 'plan', 'acceptEdits'])
  })
})
