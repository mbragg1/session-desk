import { promises as fs } from 'node:fs'
import { claudeDir } from './paths'
import { join } from 'node:path'
import type { SearchHit } from '../shared/types'

// Read at call time: the Claude folder is a setting.
const PROJECTS_DIR = () => join(claudeDir(), 'projects')
const SNIPPET_CONTEXT = 70
const SNIPPETS_PER_SESSION = 3
const MAX_SESSIONS = 30

interface Entry {
  role: 'you' | 'claude'
  text: string
  /** Lower-cased once, for matching. */
  lower: string
  at: number
}

interface IndexedFile {
  mtimeMs: number
  size: number
  sessionId: string
  entries: Entry[]
}

// Conversation text only (prompts and Claude's replies): about 2% of the
// transcripts' bytes. Tool output is the rest, and mostly noise for search.
const index = new Map<string, IndexedFile>()

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
}

async function indexFile(path: string): Promise<IndexedFile | null> {
  const raw = await fs.readFile(path, 'utf8').catch(() => null)
  if (raw === null) return null
  let sessionId = ''
  const entries: Entry[] = []
  for (const line of raw.split('\n')) {
    const user = line.includes('"type":"user"')
    if (!user && !line.includes('"type":"assistant"')) continue
    // Tool results (skipped below) are most of a transcript's bytes: don't
    // parse them to find that out. Quotes inside JSON strings are escaped, so
    // this only matches the key itself.
    if (user && line.includes('"toolUseResult":')) continue
    let d: any
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    if (d.isMeta || d.isSidechain || d.toolUseResult) continue
    sessionId ||= d.sessionId ?? ''
    const text = textOf(d.message?.content).trim()
    // Command wrappers and injected reminders start with a tag.
    if (!text || (user && text.startsWith('<'))) continue
    entries.push({ role: user ? 'you' : 'claude', text, lower: text.toLowerCase(), at: Date.parse(d.timestamp) || 0 })
  }
  return sessionId ? { mtimeMs: 0, size: 0, sessionId, entries } : null
}

/** Brings the index up to date: only new or changed transcripts are re-read. */
async function refresh(projectsDir: string): Promise<void> {
  const seen = new Set<string>()
  for (const dir of await fs.readdir(projectsDir).catch(() => [] as string[])) {
    for (const f of await fs.readdir(join(projectsDir, dir)).catch(() => [] as string[])) {
      if (!f.endsWith('.jsonl')) continue
      const path = join(projectsDir, dir, f)
      seen.add(path)
      const st = await fs.stat(path).catch(() => null)
      if (!st) continue
      const hit = index.get(path)
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) continue
      const fresh = await indexFile(path)
      if (fresh) index.set(path, { ...fresh, mtimeMs: st.mtimeMs, size: st.size })
      else index.delete(path)
    }
  }
  for (const path of [...index.keys()]) if (!seen.has(path)) index.delete(path)
}

function snippet(text: string, lower: string, term: string): string {
  const i = lower.indexOf(term)
  const start = Math.max(0, i - SNIPPET_CONTEXT)
  const end = Math.min(text.length, i + term.length + SNIPPET_CONTEXT)
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '')
}

/**
 * Sessions whose conversation contains every word of the query (any order,
 * same message, case-insensitive), most matches first, then most recent.
 */
export async function searchTranscripts(query: string, projectsDir = PROJECTS_DIR()): Promise<SearchHit[]> {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return []
  await refresh(projectsDir)
  const hits: SearchHit[] = []
  for (const file of index.values()) {
    const matching = file.entries.filter((e) => terms.every((t) => e.lower.includes(t)))
    if (!matching.length) continue
    hits.push({
      sessionId: file.sessionId,
      matches: matching.length,
      lastMatchAt: Math.max(...matching.map((e) => e.at)),
      snippets: matching
        .slice(-SNIPPETS_PER_SESSION)
        .reverse()
        .map((e) => ({ role: e.role, text: snippet(e.text, e.lower, terms[0]), at: e.at }))
    })
  }
  return hits.sort((a, b) => b.matches - a.matches || b.lastMatchAt - a.lastMatchAt).slice(0, MAX_SESSIONS)
}
