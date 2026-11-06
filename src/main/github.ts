import { execFile } from 'node:child_process'
import type { PrInfo, PrLink, PrStatus } from '../shared/types'
import { loginPath } from './env'
import { greptileStatus } from './greptile'
import { deployOf } from './deploys'
import { localOf } from './sync'
import { ticketsIn } from './sessions'

const OPEN_TTL_MS = 5 * 60_000
const BATCH = 40
// Open PRs also fetch checks, threads and comments, which are much heavier.
const STATUS_BATCH = 8
const NAME_RE = /^[\w.-]+$/
const PR_URL_RE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/

const cache = new Map<string, { info: PrInfo | null; at: number }>()
const inFlight = new Set<string>()

export function parsePrUrl(url: string): PrLink | null {
  const m = PR_URL_RE.exec(url)
  return m ? { repo: `${m[1]}/${m[2]}`, number: Number(m[3]), url: m[0] } : null
}

/** Cached info only; never blocks on the network. */
export function withInfo(pr: PrLink): PrLink {
  const info = cache.get(pr.url)?.info
  if (!info) return pr
  const local = info.state === 'OPEN' ? localOf(pr.url) : undefined
  const deploy = info.state === 'MERGED' ? deployOf(pr.url) : undefined
  return { ...pr, info, ...(local ? { local } : {}), ...(deploy ? { deploy } : {}) }
}

function stale(url: string): boolean {
  const hit = cache.get(url)
  if (!hit) return true
  if (hit.info && hit.info.state !== 'OPEN') return false
  return Date.now() - hit.at > OPEN_TTL_MS
}

async function gh(query: string): Promise<any> {
  const env = { ...process.env, PATH: await loginPath() }
  return new Promise((resolve, reject) => {
    execFile('gh', ['api', 'graphql', '-f', `query=${query}`], { env, timeout: 30_000, maxBuffer: 8 << 20 }, (err, stdout) => {
      // A deleted PR makes gh exit non-zero but still return the rest of the data.
      try {
        resolve(JSON.parse(stdout))
      } catch {
        reject(err ?? new Error('gh returned no JSON'))
      }
    })
  })
}

const CHECKS: Record<string, PrStatus['checks']> = {
  SUCCESS: 'passing',
  FAILURE: 'failing',
  ERROR: 'failing',
  PENDING: 'running',
  EXPECTED: 'running'
}

/** Checks, review decision, threads and Greptile for open PRs (already validated, already cached). */
async function fetchStatuses(prs: PrLink[]): Promise<void> {
  for (let i = 0; i < prs.length; i += STATUS_BATCH) {
    const chunk = prs.slice(i, i + STATUS_BATCH)
    const query = `query{${chunk
      .map((p, j) => {
        const [owner, name] = p.repo.split('/')
        return `s${j}:repository(owner:"${owner}",name:"${name}"){pullRequest(number:${p.number}){headRefOid reviewDecision createdAt timelineItems(itemTypes:[READY_FOR_REVIEW_EVENT],last:1){nodes{...on ReadyForReviewEvent{createdAt}}} commits(last:100){nodes{commit{oid statusCheckRollup{state}}}} reviewThreads(first:100){nodes{isResolved}} comments(last:60){nodes{author{login} updatedAt body}}}}`
      })
      .join(' ')}}`
    let res: any
    try {
      res = await gh(query)
    } catch {
      continue
    }
    chunk.forEach((p, j) => {
      const pr = res?.data?.[`s${j}`]?.pullRequest
      const hit = cache.get(p.url)
      if (!pr || !hit?.info) return
      const commits: any[] = pr.commits?.nodes ?? []
      const status: PrStatus = {
        headOid: pr.headRefOid,
        readyAt: pr.timelineItems?.nodes?.[0]?.createdAt ?? pr.createdAt,
        checks: CHECKS[commits.at(-1)?.commit?.statusCheckRollup?.state] ?? 'none',
        review: pr.reviewDecision ? (pr.reviewDecision.toLowerCase() as PrStatus['review']) : null,
        unresolvedThreads: (pr.reviewThreads?.nodes ?? []).filter((t: any) => !t.isResolved).length,
        greptile: greptileStatus(
          (pr.comments?.nodes ?? []).map((c: any) => ({ author: c.author?.login ?? null, body: c.body ?? '', updatedAt: c.updatedAt })),
          pr.headRefOid,
          commits.map((n) => n.commit.oid)
        )
      }
      hit.info = { ...hit.info, status }
    })
  }
}

/** Posts `@greptileai review` on an open PR, then refreshes its status. */
export async function requestGreptileReview(url: string): Promise<void> {
  const pr = parsePrUrl(url)
  const info = pr && cache.get(pr.url)?.info
  if (!pr || !info) throw new Error('Unknown PR; refresh first')
  if (info.state !== 'OPEN') throw new Error('The PR is not open')
  const [owner, name] = pr.repo.split('/')
  if (!NAME_RE.test(owner ?? '') || !NAME_RE.test(name ?? '')) throw new Error('Unexpected repository name')
  const env = { ...process.env, PATH: await loginPath() }
  // The body goes in as JSON on stdin: no shell, and no gh field parsing
  // (gh treats a leading "@" in -F values as a file to read).
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      'gh',
      ['api', '--method', 'POST', `repos/${owner}/${name}/issues/${pr.number}/comments`, '--input', '-'],
      { env, timeout: 30_000 },
      (err, _out, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve())
    )
    child.stdin?.end(JSON.stringify({ body: '@greptileai review' }))
  })
  cache.delete(pr.url)
  await refreshPrInfo([pr])
}

/**
 * Fetches GitHub state for any PRs not cached (or open and stale).
 * `force` re-reads them all now, whatever their age (a manual refresh).
 * Resolves true if anything new was learned.
 */
export async function refreshPrInfo(prs: PrLink[], force = false): Promise<boolean> {
  const todo = [...new Map(prs.map((p) => [p.url, p])).values()].filter(
    (p) => (force || stale(p.url)) && !inFlight.has(p.url)
  )
  if (todo.length === 0) return false
  todo.forEach((p) => inFlight.add(p.url))
  let changed = false
  try {
    for (let i = 0; i < todo.length; i += BATCH) {
      const chunk = todo.slice(i, i + BATCH).filter((p) => {
        const [owner, name] = p.repo.split('/')
        return NAME_RE.test(owner ?? '') && NAME_RE.test(name ?? '') && Number.isInteger(p.number)
      })
      if (chunk.length === 0) continue
      const query = `query{${chunk
        .map((p, j) => {
          const [owner, name] = p.repo.split('/')
          return `p${j}:repository(owner:"${owner}",name:"${name}"){pullRequest(number:${p.number}){title body state isDraft headRefName mergedAt mergeCommit{oid}}}`
        })
        .join(' ')}}`
      const res = await gh(query)
      chunk.forEach((p, j) => {
        const pr = res?.data?.[`p${j}`]?.pullRequest
        const info: PrInfo | null = pr
          ? {
              title: pr.title,
              state: pr.state,
              draft: pr.isDraft,
              headRef: pr.headRefName,
              mentions: [...new Set(ticketsIn(`${pr.headRefName}\n${pr.title}\n${pr.body ?? ''}`))],
              ...(pr.mergeCommit?.oid ? { mergeOid: pr.mergeCommit.oid, mergedAt: pr.mergedAt } : {})
            }
          : null
        cache.set(p.url, { info, at: Date.now() })
        changed = true
      })
    }
    await fetchStatuses(todo.filter((p) => cache.get(p.url)?.info?.state === 'OPEN'))
  } catch {
    // gh missing or not logged in: PRs simply show without status.
  } finally {
    todo.forEach((p) => inFlight.delete(p.url))
  }
  return changed
}
