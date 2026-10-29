// End-to-end benchmark of the built app on synthetic sessions.
//
//   npm run build && node bench/e2e/run.mjs --label baseline
//
// Launches Electron with its own HOME, data folder and Claude folder (synthetic
// transcripts), and a fake shell whose `claude` streams generated output, so
// nothing real is read or run. Drives the window over the DevTools protocol and
// measures startup, idle cost, streaming cost, frame timing, output-to-display
// latency and memory. Results go to bench/results/<label>-e2e.json.
import { spawn, execFileSync } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, totalmem, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { appendTurn, buildClaudeDir } from '../fixtures.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
// The app to measure: this checkout, or another built one (e.g. a worktree of the baseline commit).
const APP = process.env.BENCH_APP ?? REPO
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), [])
)
const LABEL = args.label ?? 'run'
const INDEXED = (args.indexed ?? '100,250').split(',').map(Number)
const OPEN = (args.open ?? '1,10,25').split(',').map(Number)
const RATE = Number(args.rate ?? 50)
const WINDOW_S = Number(args.window ?? 15)
const IDLE_S = Number(args.idle ?? 20)
const ROOT = process.env.BENCH_DIR ?? join(tmpdir(), 'session-desk-bench')
const PORT = 9333
// A window behind others (or on another Space) stops drawing; measure it as if on screen.
const THROTTLE_OFF = ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling']
const ELECTRON = createRequire(join(REPO, 'package.json'))('electron')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pct = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : null)
const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100)

function fixture(count) {
  const dir = join(ROOT, `claude-${count}`)
  if (!existsSync(join(dir, '.ready'))) {
    buildClaudeDir(dir, count)
    writeFileSync(join(dir, '.ready'), '')
  }
  return dir
}

/** CPU seconds and RSS of the app's processes by kind, from ps (fake claude children excluded). */
function processes(mainPid) {
  // args, not comm: the GPU and network helpers share one executable name.
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,time=,rss=,args='], { encoding: 'utf8', maxBuffer: 64 * 2 ** 20 })
    .trim()
    .split('\n')
    .map((l) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(l)
      return m && { pid: +m[1], ppid: +m[2], time: m[3], rss: +m[4], comm: m[5] }
    })
    .filter(Boolean)
  const kids = new Map()
  for (const r of rows) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r])
  const secs = (t) => t.split(':').reduce((a, p) => a * 60 + Number(p), 0)
  const out = { main: { cpu: 0, rssMB: 0 }, renderer: { cpu: 0, rssMB: 0 }, gpu: { cpu: 0, rssMB: 0 }, utility: { cpu: 0, rssMB: 0 } }
  const visit = (r) => {
    const kind = r.pid === mainPid ? 'main' : !/Electron Helper/.test(r.comm) ? null : /--type=gpu-process/.test(r.comm) ? 'gpu' : /--type=renderer/.test(r.comm) ? 'renderer' : 'utility'
    if (!kind) return
    out[kind].cpu += secs(r.time)
    out[kind].rssMB += r.rss / 1024
    for (const k of kids.get(r.pid) ?? []) visit(k)
  }
  const main = rows.find((r) => r.pid === mainPid)
  if (main) visit(main)
  return out
}

function cpuDelta(a, b, seconds) {
  const o = {}
  let total = 0
  for (const k of Object.keys(a)) {
    o[k] = r2(((b[k].cpu - a[k].cpu) / seconds) * 100)
    total += o[k]
  }
  o.total = r2(total)
  return o
}

const rss = (p) => Object.fromEntries([...Object.entries(p).map(([k, v]) => [k, r2(v.rssMB)]), ['total', r2(Object.values(p).reduce((a, v) => a + v.rssMB, 0))]])

class Cdp {
  static async connect() {
    for (let i = 0; i < 200; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
        const page = list.find((t) => t.type === 'page')
        if (page) return new Cdp(page.webSocketDebuggerUrl).ready
      } catch {}
      await sleep(50)
    }
    throw new Error('no page target')
  }
  constructor(url) {
    this.id = 0
    this.waiting = new Map()
    this.ws = new WebSocket(url)
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      const w = this.waiting.get(m.id)
      if (w) (this.waiting.delete(m.id), m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result))
    }
    this.ready = new Promise((r) => (this.ws.onopen = () => r(this)))
  }
  send(method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.waiting.set(id, { resolve, reject }))
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed')
    return r.result.value
  }
  close() {
    this.ws.close()
  }
}

async function waitFor(cdp, expr, timeoutMs = 30_000) {
  const t = Date.now()
  while (Date.now() - t < timeoutMs) {
    if (await cdp.eval(expr).catch(() => false)) return Date.now()
    await sleep(20)
  }
  throw new Error(`timed out waiting for ${expr}`)
}

/** One app launch on a copy of the fixture. `fresh`: new data folder (no code cache). */
async function launch(indexed, run, { fresh }) {
  const runDir = join(ROOT, `run-${LABEL}`)
  const home = join(runDir, 'home')
  const data = join(runDir, 'data')
  const claude = join(runDir, 'claude')
  const ws = join(runDir, 'workspace')
  if (fresh) {
    rmSync(runDir, { recursive: true, force: true })
    mkdirSync(home, { recursive: true })
    mkdirSync(data, { recursive: true })
    mkdirSync(ws, { recursive: true })
    writeFileSync(join(data, 'session-desk.json'), JSON.stringify({ paths: { claudeDir: claude, workspace: ws } }))
  }
  // A relaunch keeps the same Claude folder (same files, so a saved scan is still valid).
  // APFS clones: instant, and the fixture stays pristine for the next run.
  if (fresh) execFileSync('/bin/cp', ['-cR', fixture(indexed), claude])
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: process.env.TMPDIR,
    SHELL: join(HERE, 'fake-shell.sh'),
    BENCH_BIN: join(HERE, 'bin'),
    BENCH_RATE: String(RATE),
    CLAUDE_CONFIG_DIR: claude,
    SESSION_DESK_DATA_DIR: data,
    SESSION_DESK_CWD: ws,
    SESSION_DESK_BENCH: '1'
  }
  const t0 = Date.now()
  const proc = spawn(ELECTRON, [...(process.env.BENCH_MAIN_PROFILE ? ['--inspect=9339'] : []), APP, `--remote-debugging-port=${PORT}`, ...THROTTLE_OFF], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  proc.stderr.on('data', (d) => (stderr += d))
  const cdp = await Cdp.connect()
  await cdp.send('Runtime.enable')
  await cdp.send('Page.bringToFront').catch(() => {})
  const firstRow = await waitFor(cdp, `document.querySelectorAll('.session-row').length > 0`, 60_000)
  await waitFor(cdp, `!!window.__deskBench?.firstRenderAt`, 60_000)
  const timing = await cdp.eval(`({
    nav: performance.timeOrigin,
    dcl: performance.timeOrigin + performance.getEntriesByType('navigation')[0].domContentLoadedEventEnd,
    firstTerm: window.__deskBench.firstRenderAt,
    rows: document.querySelectorAll('.session-row').length
  })`)
  return {
    proc,
    cdp,
    claude,
    stderr: () => stderr,
    startup: {
      run,
      toNavigationMs: r2(timing.nav - t0),
      toDomContentLoadedMs: r2(timing.dcl - t0),
      toFirstSidebarRowMs: r2(firstRow - t0),
      toFirstTerminalFrameMs: r2(timing.firstTerm - t0),
      sidebarRows: timing.rows
    }
  }
}

async function quit(app) {
  app.cdp.close()
  app.proc.kill('SIGTERM')
  await new Promise((r) => (app.proc.exitCode !== null ? r() : app.proc.once('exit', r)))
  await sleep(300)
}

/** Installs observers in the page: rAF frame intervals and long animation frames. */
const OBSERVE = `(() => {
  const s = (window.__obs = { frames: [], loaf: [], running: true })
  let last = performance.now()
  const tick = (t) => { s.frames.push(t - last); last = t; if (s.running) requestAnimationFrame(tick) }
  requestAnimationFrame(tick)
  s.po = new PerformanceObserver((l) => { for (const e of l.getEntries()) s.loaf.push({ d: e.duration, b: e.blockingDuration }) })
  s.po.observe({ type: 'long-animation-frame' })
  window.__deskBench.parse = []; window.__deskBench.render = []; window.__deskBench.renders = 0
})()`
const COLLECT = `(() => {
  const s = window.__obs; s.running = false; s.po.disconnect()
  const b = window.__deskBench
  return { frames: s.frames.slice(1), loaf: s.loaf, parse: b.parse, render: b.render, renders: b.renders,
    heapMB: performance.memory.usedJSHeapSize / 1048576 }
})()`
// Long animation frames only (no rAF loop, which would itself make frames): for idle.
const OBSERVE_LOAF = `(() => {
  const s = (window.__obs = { frames: [], loaf: [], running: false })
  s.po = new PerformanceObserver((l) => { for (const e of l.getEntries()) s.loaf.push({ d: e.duration, b: e.blockingDuration }) })
  s.po.observe({ type: 'long-animation-frame' })
  window.__deskBench.renders = 0
})()`

function frameStats(c) {
  const f = c.frames
  return {
    frames: f.length,
    fps: r2(f.length / (f.reduce((a, b) => a + b, 0) / 1000)),
    frameP50Ms: r2(pct(f, 50)),
    frameP95Ms: r2(pct(f, 95)),
    frameP99Ms: r2(pct(f, 99)),
    framesOver20Ms: f.filter((x) => x > 20).length,
    longAnimationFrames: c.loaf.length,
    blockingMs: r2(c.loaf.reduce((a, l) => a + l.b, 0)),
    latencyParseP50Ms: r2(pct(c.parse, 50)),
    latencyParseP95Ms: r2(pct(c.parse, 95)),
    latencyDisplayP50Ms: r2(pct(c.render, 50)),
    latencyDisplayP95Ms: r2(pct(c.render, 95)),
    latencyDisplayP99Ms: r2(pct(c.render, 99)),
    terminalRenders: c.renders,
    rendererHeapMB: r2(c.heapMB)
  }
}

async function main() {
  try {
    execFileSync('pkill', ['-f', `remote-debugging-port=${PORT}`])
  } catch {}
  const results = {
    label: LABEL,
    at: new Date().toISOString(),
    machine: {
      cpu: cpus()[0]?.model,
      cores: cpus().length,
      memGB: Math.round(totalmem() / 2 ** 30),
      os: execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(),
      electron: execFileSync(ELECTRON, ['--version'], { encoding: 'utf8', env: { ELECTRON_RUN_AS_NODE: '1' } }).trim()
    },
    config: { indexed: INDEXED, open: OPEN, ratePerSession: RATE, windowS: WINDOW_S, idleS: IDLE_S },
    startup: [],
    idle: {},
    streaming: {},
    switching: {}
  }
  for (const indexed of INDEXED) {
    // Startup: one launch on a fresh data folder, two warm ones.
    for (let run = 0; run < 3; run++) {
      const app = await launch(indexed, run, { fresh: run === 0 })
      results.startup.push({ indexed, cold: run === 0, ...app.startup })
      console.log('startup', indexed, app.startup)
      if (run < 2 || args['startup-only']) {
        await quit(app)
        continue
      }
      // Idle: settle, then measure with nothing happening.
      await sleep(12_000)
      await app.cdp.eval(OBSERVE_LOAF)
      if (process.env.BENCH_PROFILE) await app.cdp.send('Profiler.enable').then(() => app.cdp.send('Profiler.start'))
      const a = processes(app.proc.pid)
      await sleep(IDLE_S * 1000)
      const b = processes(app.proc.pid)
      if (process.env.BENCH_DEBUG) {
        const shot = await app.cdp.send('Page.captureScreenshot', { format: 'png' })
        writeFileSync(join(ROOT, `idle-${LABEL}-${indexed}.png`), Buffer.from(shot.data, 'base64'))
      }
      if (process.env.BENCH_PROFILE) {
        const { profile } = await app.cdp.send('Profiler.stop')
        writeFileSync(join(ROOT, `idle-${LABEL}-${indexed}.cpuprofile`), JSON.stringify(profile))
        const self = new Map()
        const dt = profile.timeDeltas
        const byId = new Map(profile.nodes.map((n) => [n.id, n]))
        profile.samples.forEach((id, i) => {
          const n = byId.get(id).callFrame
          const k = `${n.functionName || '(anon)'} ${n.url.split('/').pop()}:${n.lineNumber}`
          self.set(k, (self.get(k) ?? 0) + (dt[i] ?? 0) / 1000)
        })
        console.log('idle profile (self ms):', [...self].sort((x, y) => y[1] - x[1]).slice(0, 15))
      }
      const idle = await app.cdp.eval(`(() => { const s = window.__obs; s.po.disconnect(); return { loaf: s.loaf.length, renders: window.__deskBench.renders, heapMB: performance.memory.usedJSHeapSize / 1048576 } })()`)
      results.idle[indexed] = { cpuPercent: cpuDelta(a, b, IDLE_S), rssMB: rss(b), longAnimationFrames: idle.loaf, terminalRenders: idle.renders, rendererHeapMB: r2(idle.heapMB) }
      console.log('idle', indexed, results.idle[indexed])

      // Streaming: open sessions one by one (each resumes and streams); the last one is on screen.
      let opened = 0
      const baseRss = rss(b)
      // By session id: the sidebar re-sorts as sessions get activity, so row positions move.
      const sids = await app.cdp.eval(`[...document.querySelectorAll('.row-more[data-sid]')].map((b) => b.dataset.sid)`)
      const clickSession = (id) => `document.querySelector('.row-more[data-sid="${id}"]').closest('.session-row').click()`
      for (const open of OPEN) {
        if (open > sids.length) break
        for (; opened < open; opened++) {
          await app.cdp.eval(clickSession(sids[opened]))
          await sleep(open > 10 ? 80 : 150)
        }
        await sleep(3000 + Number(args.settle ?? 0) * 1000)
        if (process.env.BENCH_DEBUG) {
          const shot = await app.cdp.send('Page.captureScreenshot', { format: 'png' })
          writeFileSync(join(ROOT, `shot-${LABEL}-${open}.png`), Buffer.from(shot.data, 'base64'))
          console.log(execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=,comm='], { encoding: 'utf8' }).split('\n').filter((l) => /Electron|perl|zsh/.test(l)).join('\n'))
          console.log(await app.cdp.eval(`JSON.stringify({ terms: document.querySelectorAll('.term-host').length, b: window.__deskBench })`))
        }
        // Working sessions append to their transcripts: the sidebar re-scans as it would.
        const paths = execFileSync('find', [join(app.claude, 'projects'), '-name', '*.jsonl'], { encoding: 'utf8' }).trim().split('\n').slice(0, open)
        let k = 0
        const appender = setInterval(() => {
          for (const p of paths.slice(0, Math.min(open, 10))) appendFileSync(p, appendTurn(p, 'x', k++))
        }, 1000)
        await app.cdp.send('Page.bringToFront').catch(() => {})
        await app.cdp.eval(OBSERVE)
        let mainCdp = null
        if (process.env.BENCH_MAIN_PROFILE) {
          const [t] = await (await fetch('http://127.0.0.1:9339/json/list')).json()
          mainCdp = await new Cdp(t.webSocketDebuggerUrl).ready
          await mainCdp.send('Profiler.enable')
          await mainCdp.send('Profiler.start')
        }
        const a2 = processes(app.proc.pid)
        await sleep(WINDOW_S * 1000)
        if (mainCdp) {
          const { profile } = await mainCdp.send('Profiler.stop')
          const self = new Map()
          const byId = new Map(profile.nodes.map((n) => [n.id, n]))
          profile.samples.forEach((id, i) => {
            const n = byId.get(id).callFrame
            const k = `${n.functionName || '(anon)'} ${n.url.split('/').pop()}:${n.lineNumber}`
            self.set(k, (self.get(k) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000)
          })
          console.log('main profile (self ms):', JSON.stringify([...self].sort((x, y) => y[1] - x[1]).slice(0, 15)))
          mainCdp.close()
        }
        const b2 = processes(app.proc.pid)
        clearInterval(appender)
        const c = await app.cdp.eval(COLLECT)
        const now = rss(b2)
        results.streaming[`${indexed}x${open}`] = {
          indexed,
          openStreaming: open,
          cpuPercent: cpuDelta(a2, b2, WINDOW_S),
          rssMB: now,
          rssPerOpenTerminalMB: r2((now.total - baseRss.total) / open),
          ...frameStats(c)
        }
        console.log('streaming', indexed, open, results.streaming[`${indexed}x${open}`])
      }
      // Switching back: to the first session opened (longest unviewed) and to a recently viewed one.
      if (opened > 2) {
        const switchTo = (i) =>
          app.cdp.eval(`new Promise((done) => {
            const t0 = performance.now()
            ${clickSession(sids[i])}
            const check = () => {
              const host = [...document.querySelectorAll('.term-host')].find((h) => h.style.display !== 'none')
              const text = host?.querySelector('.xterm-rows')?.textContent ?? ''
              if (text.trim().length > 0) done(performance.now() - t0)
              else requestAnimationFrame(check)
            }
            requestAnimationFrame(check)
          })`)
        const oldest = []
        const recent = []
        for (let k = 0; k < 3; k++) {
          oldest.push(await switchTo(k))
          await sleep(500)
          recent.push(await switchTo(opened - 2 - k))
          await sleep(500)
        }
        if (process.env.BENCH_DEBUG) {
          await switchTo(0)
          await sleep(300)
          const shot = await app.cdp.send('Page.captureScreenshot', { format: 'png' })
          writeFileSync(join(ROOT, `switch-${LABEL}.png`), Buffer.from(shot.data, 'base64'))
        }
        results.switching[indexed] = { opened, toLongUnviewedMs: r2(pct(oldest, 50)), toRecentMs: r2(pct(recent, 50)), loadedTerminals: await app.cdp.eval(`document.querySelectorAll('.term-host').length`) }
        console.log('switching', indexed, results.switching[indexed])
      }
      await quit(app)
    }
  }
  const out = join(REPO, 'bench', 'results')
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, `${LABEL}-e2e.json`), JSON.stringify(results, null, 2) + '\n')
  console.log(`wrote bench/results/${LABEL}-e2e.json`)
}

main().catch((e) => {
  console.error(e)
  try {
    execFileSync('pkill', ['-f', `remote-debugging-port=${PORT}`])
  } catch {}
  process.exit(1)
})
