// Prints the key numbers of an e2e results file: node bench/summary.mjs <label>
import { readFileSync } from 'node:fs'
const r = JSON.parse(readFileSync(new URL(`./results/${process.argv[2]}-e2e.json`, import.meta.url)))
for (const s of r.startup) console.log('startup', s.indexed, s.cold ? 'cold' : 'warm', 'dcl', s.toDomContentLoadedMs, 'row', s.toFirstSidebarRowMs, 'term', s.toFirstTerminalFrameMs)
for (const [k, v] of Object.entries(r.idle)) console.log('idle', k, JSON.stringify(v.cpuPercent), 'rss', v.rssMB.total, 'loaf', v.longAnimationFrames, 'renders', v.terminalRenders)
for (const [k, v] of Object.entries(r.streaming))
  console.log(k, JSON.stringify(v.cpuPercent), 'rss', v.rssMB.total, 'fps', v.fps, 'p95', v.frameP95Ms, 'p99', v.frameP99Ms, '>20', v.framesOver20Ms, 'loaf', v.longAnimationFrames, 'blk', v.blockingMs, 'lat50/95/99', v.latencyDisplayP50Ms, v.latencyDisplayP95Ms, v.latencyDisplayP99Ms, 'heap', v.rendererHeapMB)
