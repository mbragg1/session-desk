import type { Terminal } from '@xterm/xterm'

// Benchmark instrumentation, on only with SESSION_DESK_BENCH=1 (bench/e2e).
// The fake claude stamps its output with OSC 7777 carrying the wall-clock ms
// it was written; this records how long each stamp took to be parsed and to
// reach a rendered frame in a visible terminal.

interface BenchState {
  firstRenderAt: number | null
  parse: number[]
  render: number[]
  renders: number
}

declare global {
  interface Window {
    __deskBench?: BenchState
  }
}

function state(): BenchState {
  return (window.__deskBench ??= { firstRenderAt: null, parse: [], render: [], renders: 0 })
}

export function benchTerminal(xterm: Terminal, host: HTMLElement): () => void {
  const s = state()
  let pending: number[] = []
  const osc = xterm.parser.registerOscHandler(7777, (data) => {
    const sent = Number(data)
    if (!Number.isFinite(sent)) return true
    const now = performance.timeOrigin + performance.now()
    s.parse.push(now - sent)
    if (host.offsetParent !== null) pending.push(sent)
    return true
  })
  const render = xterm.onRender(() => {
    s.renders++
    const now = performance.timeOrigin + performance.now()
    s.firstRenderAt ??= now
    for (const sent of pending) s.render.push(now - sent)
    pending = []
  })
  return () => {
    osc.dispose()
    render.dispose()
  }
}
