// Synthetic Claude Code state for benchmarks: transcripts shaped like real
// ones (mostly tool output, a few prompts and replies), never real sessions.
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** Deterministic PRNG so every run builds the same bytes. */
export function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS =
  'the of and to in is that for it with as was on be by this are or from at an have not which but all they were can more one has there their what about would when so up out if into time only new some could these two may first then do any like my now over such our man me even most made after also did many before must through back years where much your way well down should because each just those people how too little state good very make world still own see men work long get here between both life being under never day same another know while last might us great old year off come since against go came right used take three'.split(' ')

function words(r, n) {
  let out = ''
  for (let i = 0; i < n; i++) out += (i ? ' ' : '') + WORDS[Math.floor(r() * WORDS.length)]
  return out
}

export function uuid(r) {
  const h = () => Math.floor(r() * 16).toString(16)
  const s = (n) => Array.from({ length: n }, h).join('')
  return `${s(8)}-${s(4)}-4${s(3)}-8${s(3)}-${s(12)}`
}

/** One transcript of roughly `bytes` bytes. */
export function transcript(r, id, cwd, bytes, startMs) {
  const lines = []
  let size = 0
  let t = startMs
  const push = (o) => {
    const line = JSON.stringify(o)
    lines.push(line)
    size += line.length + 1
  }
  const ts = () => new Date((t += 1000 + Math.floor(r() * 20000))).toISOString()
  const base = { sessionId: id, cwd, entrypoint: 'cli', gitBranch: r() < 0.5 ? 'main' : `me/eng-${1000 + Math.floor(r() * 9000)}-fix` }
  push({ type: 'user', ...base, message: { role: 'user', content: `Please ${words(r, 12)}` }, timestamp: ts() })
  push({ type: 'ai-title', sessionId: id, aiTitle: words(r, 5) })
  let n = 0
  while (size < bytes) {
    n++
    const toolId = `toolu_${n}`
    const tool = ['Bash', 'Read', 'Edit', 'Grep'][Math.floor(r() * 4)]
    push({
      type: 'assistant',
      ...base,
      message: {
        model: 'claude-opus-5-5',
        role: 'assistant',
        content: [
          { type: 'text', text: words(r, 20 + Math.floor(r() * 60)) },
          { type: 'tool_use', id: toolId, name: tool, input: { command: words(r, 6) } }
        ],
        usage: { input_tokens: 3, cache_creation_input_tokens: 500, cache_read_input_tokens: 40000 + n * 100, output_tokens: 200 }
      },
      effort: 'high',
      timestamp: ts()
    })
    // Tool output dominates real transcripts' bytes.
    const out = words(r, 300 + Math.floor(r() * 3000))
    push({
      type: 'user',
      ...base,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: out }] },
      toolUseResult: { stdout: out.slice(0, 2000), stderr: '' },
      timestamp: ts()
    })
    if (n % 12 === 0) {
      push({ type: 'user', ...base, message: { role: 'user', content: `Now ${words(r, 15)}` }, timestamp: ts() })
      push({ type: 'system', subtype: 'turn_duration', sessionId: id, timestamp: ts() })
    }
  }
  return lines.join('\n') + '\n'
}

/** Sizes: mostly small, some medium, a few tens-of-MB-class ones (scaled by `scale`). */
export function sizeFor(r, scale = 1) {
  const p = r()
  const kb = p < 0.7 ? 150 + r() * 450 : p < 0.95 ? 1000 + r() * 2000 : 8000 + r() * 4000
  return Math.floor(kb * 1024 * scale)
}

/**
 * Builds `<root>/projects/<project>/<id>.jsonl` for `count` sessions across a
 * few projects, plus an empty `sessions/` registry. Returns the session ids.
 */
export function buildClaudeDir(root, count, { seed = 1, scale = 1, workspace = join(root, '..', 'workspace') } = {}) {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true })
  // Sessions resume in their start folder, so it has to exist.
  mkdirSync(workspace, { recursive: true })
  mkdirSync(join(root, 'sessions'), { recursive: true })
  const r = rng(seed)
  const ids = []
  const now = Date.now()
  for (let i = 0; i < count; i++) {
    const project = `-bench-project-${i % 6}`
    const dir = join(root, 'projects', project)
    mkdirSync(dir, { recursive: true })
    const id = uuid(r)
    ids.push(id)
    writeFileSync(join(dir, `${id}.jsonl`), transcript(r, id, workspace, sizeFor(r, scale), now - (count - i) * 3_600_000))
  }
  return ids
}

/** Appends one assistant/tool round to a transcript, as a working session does. */
export function appendTurn(path, id, seed = 7) {
  const r = rng(seed)
  return transcript(r, id, '/tmp/bench-ws', 4000, Date.now()).split('\n').slice(2).join('\n')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [root, count = '100', scale = '1'] = process.argv.slice(2)
  if (!root) throw new Error('usage: node bench/fixtures.mjs <dir> [count] [scale]')
  const t = Date.now()
  const ids = buildClaudeDir(root, Number(count), { scale: Number(scale) })
  console.log(`${ids.length} transcripts in ${root} (${Date.now() - t} ms)`)
}
