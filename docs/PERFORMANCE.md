# Performance

Measured on an Apple M4 MacBook (10 cores, 16 GB, 120 Hz display), macOS 26.4.1, Electron 44.7. Everything below runs on synthetic data: generated transcripts and a fake `claude` that streams output. No real sessions are read and no real Claude processes are started.

## How to measure

```bash
npm run bench:main                 # main-process microbenchmarks (scan, search, pty path)
npm run build && node bench/e2e/run.mjs --label mine
node bench/summary.mjs mine        # the key numbers of a run
```

- `bench/fixtures.mjs` builds Claude folders with 1–250 transcripts (150 KB to 12 MB each, mostly tool output, like real ones). They're seeded, so every run uses the same bytes.
- `bench/e2e/run.mjs` launches the built app with its own `HOME`, data folder and Claude folder. `SHELL` points at `bench/e2e/fake-shell.sh`, whose `claude` is a perl script that draws a TUI and streams 50 chunks/s once resumed. The driver works the window over the DevTools protocol and collects:
  - startup timings
  - idle CPU per process (from `ps`)
  - CPU and memory with 1/10/25 sessions streaming, while 10 of them append to their transcripts every second
  - rAF frame intervals and long animation frames
  - how long stamped output takes to reach a rendered frame
- `BENCH_APP=<dir>` measures another built checkout (the A/B runs below used a worktree of the baseline commit). `--startup-only 1` skips the streaming part.
- The bench hook (`src/renderer/src/bench.ts`) is inert unless `SESSION_DESK_BENCH=1`.
- The driver passes `--disable-backgrounding-occluded-windows` and related flags so a window behind others is still measured as drawing. Without them, Chromium stops drawing and frame data is empty.

## Results

The A/B runs alternated baseline (`b2cffd9`) and optimized builds on the same machine: two rounds of each for e2e (`bench/results/A*`, `B*`, `SA*`, `SB*`) and two for main (`mainA*`, `mainB*`). The figures below are medians or means of those runs.

| Metric | Baseline | Optimized | Change |
|---|---|---|---|
| Idle CPU, window focused (all processes) | ~10.8% | ~1.4% | −87% |
| Main-process cost per streamed output chunk | 101 µs | 18.6 µs | −82% |
| Main-process CPU, 25 sessions streaming | 11.4% | 7.9% | −31% |
| Total CPU, 25 sessions streaming | 54.9% | 48.8% | −11% |
| Memory (RSS, all processes), 25 streaming | ~660 MB | ~615 MB | −7% |
| Output-to-display stalls (p95 > 300 ms) | 3 of 12 cells (5 of 18 incl. first baseline) | 0 of 12 | gone |
| Warm launch to first sidebar row, 250 sessions | ~710 ms | ~370 ms | −48% |
| Warm launch to first sidebar row, 100 sessions | ~484 ms | ~390 ms | −19% |
| Launch to first terminal frame | ~370 ms | ~370 ms | none |
| Session scan on relaunch, 250 sessions (315 MB) | ~400 ms | 2 ms | −99% |
| Cold search, 250 sessions | ~303 ms | ~243 ms | −20% |
| Search index heap, 250 sessions | ~161 MB | 25–68 MB | lower |
| Renderer bundle | 1,251 kB | 663 kB | −47% |

**Unchanged.** Both builds hold 120 fps with a 9.1 ms p95 frame. That covers 1, 10 and 25 streaming sessions with 100 or 250 sessions indexed, apart from a few baseline runs that dipped to 104–110 fps during the stalls. Renderer CPU while streaming is within noise (about 35% vs 38% at 25 streams), because it's xterm parsing output.

**Caveats**
- Idle baseline CPU depends on window focus: an unfocused baseline window idles at about 0.5%.
- Absolute output-to-display latency isn't reliable. The fake claude stamps with the system clock and Chromium's `timeOrigin` drifts from it, and some runs showed negative values. Only tails and comparisons within a run are reported.
- First-launch (fresh data folder) startup is within noise between builds: no saved scan yet, and a code-cache-cold renderer either way.

## What changed and why

**PTY output path (`src/main/pty.ts`).**
- *Problem:* Every output chunk did `(buffer + data).slice(-512 KB)`. That flattens and copies the whole replay buffer per chunk, so a 100-byte token cost a 512 KB copy. Mode detection also recompiled six regexes per chunk.
- *Fix:* The replay buffer is now a list of chunks, joined only when a renderer reload asks for it. Mode detection runs on a 3,000-char rolling tail with precompiled regexes.
- *Effect:* Main-process CPU now scales with bytes streamed rather than with buffer size.

**Output batching (`src/main/ptyBatch.ts`, `src/renderer/src/ptyBus.ts`).**
- *Problem:* Each chunk was its own IPC message, and every mounted `Terminal` had its own `pty:data` listener. N open terminals meant N callbacks per chunk.
- *Fix:* Main now merges output per session:
  - The terminal on screen flushes at the end of the event-loop turn, so no latency is added.
  - Background terminals flush once per 16 ms frame, all sessions in one message.
  - The exit notice flushes first, so it always follows the last output.
- The renderer routes the single subscription by session id. The window tells main which terminal is visible (`ui:visibleTerminal`).

**Background refresh (`src/main/index.ts`).**
- *Problem:* The 10 s liveness tick, every transcript append and every status-file change sent `sessions:changed`. Each one made the window re-fetch three lists and re-render the whole sidebar, and made the board re-fetch Linear.
- *Fix:* Those background triggers now re-scan in main and message the window only when the list differs from what it last got.
- *Unchanged:* The Dock badge, notifications and Linear auto-moves/pins still run on every tick. Explicit actions (rename, pin, archive…) still notify unconditionally.

**Cursor blink (`Terminal.tsx`).**
- *Problem:* xterm's DOM renderer blinks the cursor with an infinite CSS animation on a paint property. Chromium therefore produces frames at the display rate (120 Hz) for as long as a terminal has focus, which was the whole of the ~10% idle CPU.
- *Fix:* The cursor blinks for 10 s after each keystroke, then holds steady.

**Scan cache on disk (`src/main/sessions.ts`).**
- *Problem:* The incremental transcript parser state was only in memory, so every launch re-read every transcript in full. With real histories that can be gigabytes.
- *Fix:* The state is saved to `userData/scan-cache.json`:
  - Written on quit, on SIGTERM/SIGINT, 30 s after launch and every 5 minutes.
  - Restored at launch. Each entry is still checked against the file's size, mtime and inode before use.
  - Discarded for a different cache version or different ticket keys.
  - Entries for deleted transcripts are pruned, which also stops the in-memory cache growing forever.

**Search (`src/main/search.ts`).** Lines with a `"toolUseResult":` key were parsed only to be skipped. They're now skipped before `JSON.parse`. Quotes inside JSON strings are escaped, so the check only matches the key.

**Renderer bundle.** electron-vite doesn't minify the renderer by default; it's minified now.

## Many sessions (second pass)

Measured with 50 sessions streaming at once, after 35 s of settling (`--open 50 --settle 35`). This is A/B against the first pass (`b3cf8da`): `bench/results/SSA*` vs `SSB3`, `SSB4`.

| Metric | First pass | Now | Change |
|---|---|---|---|
| Total CPU | 67.1 / 62.2% | 41.9 / 48.3% | about −30% |
| Renderer CPU | 51.4 / 48.3% | 27.1 / 31.0% | about −41% |
| Main-process CPU | 10.8 / 9.8% | 9.7 / 11.3% | same |
| Terminals loaded in the window | 51 | 8 | |
| Switch to a long-unviewed session | 3–5 ms | 21–31 ms | +~25 ms (a redraw) |
| Switch to a recently viewed one | 3–6 ms | 3–7 ms | same |

Frames stay at 120 fps (p99 9.3 ms). Memory is too noisy at this load to report: total RSS for the same build ranged from 441 to 825 MB between runs.

**Unloading terminals (`App.tsx`, `Terminal.tsx`).**
- *What stays loaded:* only the terminal on screen and the 8 most recently viewed. A new one also stays for its first 30 s, so the program's start-up exchanges with the terminal complete.
- *What happens to the rest:* the `claude` process keeps running and main keeps its latest output. Mounting the terminal again redraws from that output. An unloaded terminal parses nothing, and that's where the renderer CPU went.
- *Correctness:*
  - The replay starts with the private modes (bracketed paste, cursor keys, mouse, alternate screen…) set by output that has scrolled out of it. Without that, a redrawn terminal could paste multi-line text without bracketing and submit it early.
  - The replay holds old terminal queries, and the terminal's answers to them are dropped. Otherwise a redraw would type `^[[12;1R` into the prompt.
  - Exits are tracked by `App`, not each terminal. An unloaded session that exits is redrawn from its last output (main keeps the last 32) and is never restarted.
- *Known gap:* a query Claude Code sends while its terminal is unloaded gets no answer, because no terminal is there to answer it.

**Mode detection throttle (`pty.ts`).** The permission-mode footer is read from the first chunk at once, then at most every 100 ms per session while output keeps coming, with a trailing check so the last state is always read. At 50 sessions this was the largest JS cost in the main process.

## Long transcripts and what was left alone (third pass)

**Reading transcripts in 4 MB pieces (`sessions.ts`).** The scan read everything appended since its last read in one buffer and parsed it in one synchronous pass. For one 64 MB session, that blocked the main process's event loop for 89 ms, holding up terminal output and IPC, with a 79 MB peak heap. It now reads and parses 4 MB at a time and yields in between. The worst block is now 7.4 ms and the peak heap is 38 MB, at the same total time (96 vs 102 ms, `bench/results/hugeA-main.json` vs `hugeB-main.json`). A test checks that lines crossing piece boundaries (one longer than a piece, multi-byte text) parse exactly as a whole-file read does.

**Measured and left alone:**
- **A worker thread for scanning or search.** With the pieces above, the cold scan of 250 sessions blocks the event loop for at most ~18 ms (before chunking) and search for at most ~9 ms (`block-main.json`). A worker would add a process boundary for no visible gain.
- **Re-reading only changed files.** A re-check of 250 sessions costs 1.6 ms (it lists and stats every transcript).
- **Startup.** A bare Electron window reaches navigation in ~175 ms on this machine; the app takes ~220–300 ms. Profiling the main process at launch:
  - ~72 ms is `new BrowserWindow()` itself (native).
  - The app's own JS before navigation is ~20 ms (menu, paths, watchers).
  - The rest is the renderer: about 80 ms to DOMContentLoaded and 50 ms more to the first terminal frame.

**Terminal queries while unloaded.** Claude Code 2.1.312 probes the terminal for XTVERSION and synchronized output (DECRQM 2026). Its own messages include "XTVERSION: no reply (terminal ignored query)" and "no reply to DECRQM 2026", so it has a no-reply path. These look like start-up probes, which the 30 s start-up grace covers; that wasn't confirmed against a running session.

## Tried and rejected

**WebGL terminal renderer (`@xterm/addon-webgl`).**
- *Setup:* Attached to the visible terminal and released when it's hidden, because Chromium allows only a handful of contexts per page.
- *Result at 25 streams:* renderer CPU rose from 36% to 112%, frame rate dropped from 120 to 84 fps (p95 25 ms) and memory grew by about 200 MB.
- *Result with one visible stream:* no gain.
- Without WebGL the DOM renderer already holds 120 fps here, so it was removed (A/B in `bench/results/opt1-e2e.json` vs `nowebgl-e2e.json`).

**Holding hidden sessions' output for 250 ms** (instead of 16 ms) so their terminals parse a few large writes. Renderer CPU was unchanged at 25 sessions: xterm's cost is per byte, not per write. It was removed, along with the terminal-query fast path it needed.

**No native or Metal code.** Chromium's compositor already runs on Metal. Frames are 9 ms at 120 Hz with headroom, and no profile pointed at composition.

## Where the time goes now

- **Renderer CPU for the loaded terminals.** About 30% at 50 × 50 chunks/s with 8 loaded: xterm parsing and the visible one's DOM rendering.
- **First launch with a large history.** It still scans every transcript once, on the main process's event loop, in 4-file batches. A worker thread would keep IPC responsive during that first scan.
