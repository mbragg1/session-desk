import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { namesTicket } from '../../../shared/prs'
import type { LinearIssue, PrFocus, PrLink, SessionSummary, TicketBranch, TicketContext } from '../../../shared/types'
import { errorMessage, timeAgo } from '../format'
import { FolderIcon, NoteIcon } from './icons'
import { DeployLine, ExternalLink, PrBadge, PrStatusLine, TicketLink } from './links'

const SOURCE_HINT: Record<NonNullable<SessionSummary['ticketSource']>, string> = {
  manual: 'linked by hand',
  pr: 'from PR branch',
  transcript: 'detected'
}

// Open PRs need attention; merged and closed ones are history.
const PR_ORDER = { OPEN: 0, MERGED: 2, CLOSED: 3 } as const
const prRank = (pr: PrLink) => (pr.info ? PR_ORDER[pr.info.state] + (pr.info.draft ? 1 : 0) : 1)

/** ticketOnly: attached to that ticket in Linear, not opened here. related: and it doesn't name the ticket either. */
type ShownPr = PrLink & { ticketOnly?: string; related?: boolean }

/**
 * The session's own PRs, plus any attached to its ticket in Linear that it
 * didn't open (the board card shows both, so the session view should too).
 */
export function sessionPrs(own: PrLink[], ticket: LinearIssue | null): ShownPr[] {
  const byUrl = new Map<string, ShownPr>(own.map((p) => [p.url, p]))
  for (const p of ticket?.prs ?? []) {
    if (!byUrl.has(p.url)) byUrl.set(p.url, { ...p, ticketOnly: ticket!.identifier, related: !namesTicket(p, ticket!.identifier) })
  }
  return [...byUrl.values()]
}

function PrRow({ pr, focus }: { pr: ShownPr; focus?: PrFocus }) {
  if (pr.related) return <RelatedRow pr={pr} />
  const marked = !!focus?.prUrls.includes(pr.url)
  return (
    <li className={marked ? 'pr-focus' : undefined}>
      <div className="pr-line">
        <ExternalLink href={pr.url} title={pr.info?.title}>
          {pr.repo.split('/').pop()}#{pr.number}
        </ExternalLink>
        <PrBadge pr={pr} />
        {pr.info && <span className="pr-title">{pr.info.title}</span>}
        {pr.ticketOnly && (
          <span className="hint pr-origin" title={`Attached to ${pr.ticketOnly} in Linear; not opened from this session`}>
            via ticket
          </span>
        )}
        {marked && <span className="hint pr-origin">{focus!.ticket}</span>}
      </div>
      <PrStatusLine pr={pr} />
      <DeployLine pr={pr} />
    </li>
  )
}

/** Attached for context (e.g. the PR that caused a bug): no state chip or CI, so it can't read as this ticket's fix. */
function RelatedRow({ pr }: { pr: ShownPr }) {
  return (
    <li className="pr-related">
      <div className="pr-line">
        <ExternalLink href={pr.url} title={pr.info?.title}>
          {pr.repo.split('/').pop()}#{pr.number}
        </ExternalLink>
        {pr.info && <span className="pr-title">{pr.info.title}</span>}
        <span
          className="hint pr-origin"
          title={`Attached to ${pr.ticketOnly} in Linear, but the PR doesn't name it: context, not this ticket's work`}
        >
          related{pr.info ? `, ${pr.info.state.toLowerCase()}` : ''}
        </span>
      </div>
    </li>
  )
}

export function PrPanel({ prs, sessionId, focus }: { prs: ShownPr[]; sessionId: string; focus?: PrFocus }) {
  const [showDone, setShowDone] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  useEffect(() => setShowDone(false), [sessionId])
  // Background refreshes only re-read a PR every few minutes; this re-reads them now.
  const refresh = () => {
    setRefreshing(true)
    window.desk.refreshPrs(prs.map((p) => p.url)).finally(() => setRefreshing(false))
  }
  const sorted = [...prs].sort((a, b) => prRank(a) - prRank(b))
  // The card's PRs go first, whatever their state: rows grow as CI and deploy
  // state load, so anywhere lower they'd drift out of view.
  const focused = sorted.filter((p) => focus?.prUrls.includes(p.url))
  // Context only, so last; never folded away, as they're the ticket's only links.
  const related = sorted.filter((p) => p.related && !focused.includes(p))
  const rest = sorted.filter((p) => !focused.includes(p) && !related.includes(p))
  const live = rest.filter((p) => !p.info || p.info.state === 'OPEN')
  const done = rest.filter((p) => p.info && p.info.state !== 'OPEN')
  return (
    <section className="panel pr-panel">
      <div className="pr-panel-head">
        <h2>Pull requests</h2>
        {prs.length > 0 && (
          <button className="link-button pr-refresh" disabled={refreshing} title="Re-read these PRs from GitHub now" onClick={refresh}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        )}
      </div>
      {prs.length === 0 ? (
        <p className="empty">No PRs from this session or its ticket.</p>
      ) : (
        <ul className="pr-list">
          {[...focused, ...live].map((pr) => (
            <PrRow key={pr.url} pr={pr} focus={focus} />
          ))}
          {done.length > 0 &&
            (showDone || focused.length + live.length === 0 ? (
              done.map((pr) => <PrRow key={pr.url} pr={pr} focus={focus} />)
            ) : (
              <li>
                <button className="link-button pr-more" onClick={() => setShowDone(true)}>
                  Show {done.length} merged and closed
                </button>
              </li>
            ))}
          {related.map((pr) => (
            <PrRow key={pr.url} pr={pr} />
          ))}
        </ul>
      )}
    </section>
  )
}

/** The PR and ticket panels above a session's terminal (the title lives in the top bar). */
export function SessionHeader({
  session,
  linearConnected,
  focus,
  onOpenPr,
  openPrBlocked
}: {
  session: SessionSummary
  linearConnected: boolean
  focus?: PrFocus
  /** Asks Claude in this session to open a PR for the branch. */
  onOpenPr?: (b: TicketBranch) => void
  /** Why it can't be asked right now (busy, a dialog open, open elsewhere). */
  openPrBlocked?: string | null
}) {
  const primary = session.tickets[0]
  const issue = useIssue(primary, linearConnected)
  const prs = sessionPrs(session.prs, issue)
  const [height, setHeight] = useState<number | null>(savedHeight)
  const ref = useRef<HTMLElement>(null)
  return (
    <>
      <header ref={ref} className={height ? 'session-header sized' : 'session-header'} style={height ? { height } : undefined}>
        <div className="panels">
          <TicketPanel session={session} issue={issue} prs={prs} onOpenPr={onOpenPr} openPrBlocked={openPrBlocked ?? null} />
          <PrPanel prs={prs} sessionId={session.id} focus={focus} />
        </div>
      </header>
      <RowResizer target={ref} onResize={setHeight} />
    </>
  )
}

const HEIGHT_KEY = 'session-header-height'
const MIN_HEADER = 64
// Leave the terminal enough rows to be usable.
const MIN_TERMINAL = 160

function savedHeight(): number | null {
  try {
    const n = Number(localStorage.getItem(HEIGHT_KEY))
    return n >= MIN_HEADER ? n : null
  } catch {
    return null
  }
}

function saveHeight(h: number | null): void {
  try {
    if (h) localStorage.setItem(HEIGHT_KEY, String(Math.round(h)))
    else localStorage.removeItem(HEIGHT_KEY)
  } catch {
    // Only a convenience: the next launch starts at the default height.
  }
}

/**
 * The bar between the panels and the terminal: drag it to trade height
 * between them (the panels scroll), double-click to go back to fitting the
 * panels' content.
 */
function RowResizer({ target, onResize }: { target: RefObject<HTMLElement | null>; onResize: (h: number | null) => void }) {
  const start = (e: ReactPointerEvent<HTMLDivElement>) => {
    const header = target.current
    const pane = header?.parentElement
    if (!header || !pane || e.button !== 0) return
    e.preventDefault()
    const bar = e.currentTarget
    bar.setPointerCapture(e.pointerId)
    const y0 = e.clientY
    const h0 = header.getBoundingClientRect().height
    // The terminal gives up height down to MIN_TERMINAL, and no further.
    const term = pane.querySelector('.term-stack')?.getBoundingClientRect().height ?? MIN_TERMINAL
    const max = h0 + Math.max(0, term - MIN_TERMINAL)
    let h = h0
    const move = (ev: PointerEvent) => {
      h = Math.max(MIN_HEADER, Math.min(max, h0 + ev.clientY - y0))
      onResize(h)
    }
    // Moves are coalesced per frame, so the last one can land after the release.
    const end = (ev: PointerEvent) => {
      move(ev)
      bar.removeEventListener('pointermove', move)
      bar.removeEventListener('pointerup', end)
      bar.removeEventListener('pointercancel', end)
      saveHeight(h)
    }
    bar.addEventListener('pointermove', move)
    bar.addEventListener('pointerup', end)
    bar.addEventListener('pointercancel', end)
  }
  return (
    <div
      className="row-resizer"
      role="separator"
      aria-orientation="horizontal"
      title="Drag to resize; double-click to fit"
      onPointerDown={start}
      onDoubleClick={() => {
        onResize(null)
        saveHeight(null)
      }}
    />
  )
}

/** The Linear issue, re-read when sessions change so its PRs pick up CI and review state. */
function useIssue(ticket: string | undefined, linearConnected: boolean): LinearIssue | null {
  const [issue, setIssue] = useState<LinearIssue | null>(null)
  useEffect(() => {
    setIssue(null)
    if (!ticket || !linearConnected) return
    let live = true
    // Main caches the issue itself; each read re-attaches the latest PR state.
    const load = () =>
      window.desk
        .getIssue(ticket)
        .then((i) => live && setIssue(i))
        .catch(() => live && setIssue(null))
    void load()
    const off = window.desk.onSessionsChanged(load)
    return () => {
      live = false
      off()
    }
  }, [ticket, linearConnected])
  // Never show the previous ticket's issue while the next one loads.
  return issue?.identifier === ticket ? issue : null
}

function TicketPanel({
  session,
  issue,
  prs,
  onOpenPr,
  openPrBlocked
}: {
  session: SessionSummary
  issue: LinearIssue | null
  prs: ShownPr[]
  onOpenPr?: (b: TicketBranch) => void
  openPrBlocked: string | null
}) {
  const primary = session.tickets[0]
  // The ticket's own PRs: their branches find a taken-over PR's checkout, whose names say nothing of the ticket.
  const branches = useTicketBranches(
    primary,
    prs.flatMap((p) => (!p.related && p.info?.headRef ? [{ repo: p.repo, branch: p.info.headRef }] : []))
  )
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setEditing(false)
    setError(null)
  }, [session.id])

  const save = async (ticket: string | null) => {
    try {
      await window.desk.linkSession(session.id, ticket)
      setEditing(false)
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <section className="panel">
      <h2>
        Ticket
        {!editing && (
          <button
            className="link-button"
            onClick={() => {
              setDraft(primary ?? '')
              setEditing(true)
            }}
          >
            {primary ? 'Change' : 'Link'}
          </button>
        )}
      </h2>

      {editing ? (
        <form
          className="link-form"
          onSubmit={(e) => {
            e.preventDefault()
            save(draft)
          }}
        >
          <input autoFocus value={draft} placeholder="ENG-1234" onChange={(e) => setDraft(e.target.value)} />
          <button className="btn btn-small btn-primary" type="submit">
            Save
          </button>
          {session.ticketSource === 'manual' && (
            <button className="btn btn-small" type="button" onClick={() => save(null)} title="Remove the manual link">
              Use detected
            </button>
          )}
          <button className="btn btn-small" type="button" onClick={() => setEditing(false)}>
            Cancel
          </button>
          {error && <div className="form-error">{error}</div>}
        </form>
      ) : !primary ? (
        <p className="empty">No ticket linked.</p>
      ) : (
        <>
          <div className="ticket-main">
            <TicketLink ticket={primary} url={issue?.url} />
            {issue && (
              <span className="state-pill">
                <span className="dot" style={{ background: issue.state.color }} />
                {issue.state.name}
              </span>
            )}
            {session.ticketSource && <span className="hint">{SOURCE_HINT[session.ticketSource]}</span>}
          </div>
          {issue && <div className="ticket-title">{issue.title}</div>}
          {branches.map((b) => (
            <BranchLine
              key={`${b.repo}:${b.branch}`}
              branch={b}
              pr={prs.find((p) => !p.related && p.info?.headRef === (b.remoteBranch ?? b.branch) && p.repo === b.slug)}
              onOpenPr={onOpenPr && (() => onOpenPr(b))}
              blocked={openPrBlocked}
            />
          ))}
          {session.tickets.length > 1 && (
            <div className="ticket-others">
              Also mentioned:{' '}
              {session.tickets.slice(1, 5).map((t) => (
                <TicketLink key={t} ticket={t} />
              ))}
            </div>
          )}
        </>
      )}
      {!editing && <TicketContextView ticket={primary ?? null} prNumbers={prs.map((p) => p.number)} />}
    </section>
  )
}

/** The ticket's branches, re-read when sessions change (a commit or push shows up mid-turn). */
function useTicketBranches(ticket: string | undefined, prHeads: { repo: string; branch: string }[]): TicketBranch[] {
  const [branches, setBranches] = useState<TicketBranch[]>([])
  // A new array every render: key the effect on its contents.
  const headsKey = prHeads.map((h) => `${h.repo}:${h.branch}`).join(',')
  useEffect(() => {
    setBranches([])
    if (!ticket) return
    let live = true
    const load = () =>
      window.desk
        .ticketBranches(ticket, prHeads)
        .then((b) => live && setBranches(b))
        .catch(() => {})
    void load()
    const off = window.desk.onSessionsChanged(load)
    return () => {
      live = false
      off()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket, headsKey])
  return branches
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** "pushed, 1 commit ahead of main", "2 unpushed commits", "not pushed", plus uncommitted changes. */
export function branchState(b: TicketBranch): string {
  const parts: string[] = []
  if (!b.pushed) parts.push('not pushed')
  else if (b.unpushed) parts.push(`${plural(b.unpushed, 'unpushed commit')}`)
  else parts.push('pushed')
  if (b.ahead === 0) parts.push(`no commits past ${b.defaultBranch} yet`)
  else if (b.ahead) parts.push(`${plural(b.ahead, 'commit')} ahead of ${b.defaultBranch}`)
  if (b.changes) parts.push(`${plural(b.changes, 'uncommitted change')}`)
  return parts.join(', ')
}

/**
 * One line per branch: repo, branch (linked on GitHub once pushed), state, and
 * its PR or Create PR, which asks Claude in the session to open it.
 */
export function BranchLine({
  branch: b,
  pr,
  onOpenPr,
  blocked
}: {
  branch: TicketBranch
  pr?: PrLink
  onOpenPr?: () => void
  blocked?: string | null
}) {
  const onGitHub = b.slug && b.pushed
  // Commits to open it from; Claude pushes any that aren't on GitHub yet.
  const canOpenPr = !pr && !!b.ahead && !!onOpenPr
  return (
    <div className="ticket-branch" title={b.label}>
      <span className="branch-repo">{b.repo}</span>
      {onGitHub ? (
        <ExternalLink href={`https://github.com/${b.slug}/tree/${encodeURI(b.remoteBranch ?? b.branch)}`} className="branch-name">
          {b.branch}
          {b.remoteBranch && ` → ${b.remoteBranch}`}
        </ExternalLink>
      ) : (
        <code className="branch-name">{b.branch}</code>
      )}
      <span className="branch-state">{branchState(b)}</span>
      {pr ? (
        <span className="branch-state">PR #{pr.number}</span>
      ) : (
        <span className="branch-state">
          no PR yet
          {canOpenPr && (
            <>
              {' · '}
              <button
                className="link-button branch-action"
                disabled={!!blocked}
                title={blocked ?? 'Ask Claude in this session to open the PR, with the title and description it normally writes'}
                onClick={onOpenPr}
              >
                Create PR
              </button>
            </>
          )}
        </span>
      )}
    </div>
  )
}

const NOTES_SHOWN = 4

/** Evidence folders and memory notes for the ticket (and the session's PRs). */
function TicketContextView({ ticket, prNumbers }: { ticket: string | null; prNumbers: number[] }) {
  const [ctx, setCtx] = useState<TicketContext | null>(null)
  const [allNotes, setAllNotes] = useState(false)
  const key = `${ticket}|${prNumbers.join(',')}`

  useEffect(() => {
    let live = true
    setCtx(null)
    setAllNotes(false)
    window.desk
      .ticketContext(ticket, prNumbers)
      .then((c) => live && setCtx(c))
      .catch(() => live && setCtx(null))
    return () => {
      live = false
    }
    // `key` captures both inputs; the array identity changes every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  if (!ctx || (!ctx.evidence.length && !ctx.notes.length)) return null
  const open = (path: string) => window.desk.openContextPath(path).catch(() => {})
  const notes = allNotes ? ctx.notes : ctx.notes.slice(0, NOTES_SHOWN)
  return (
    <div className="ticket-context">
      {ctx.evidence.map((e) => (
        <button key={e.path} className="context-row" onClick={() => open(e.path)} title={`Open ${e.path} in Finder`}>
          <FolderIcon />
          <span className="context-name">{e.label}</span>
          <span className="muted">
            {e.files} file{e.files === 1 ? '' : 's'}
            {e.modifiedAt ? ` · ${timeAgo(e.modifiedAt)}` : ''}
          </span>
        </button>
      ))}
      {notes.map((n) => (
        <button key={n.path} className="context-row" onClick={() => open(n.path)} title={n.description || n.path}>
          <NoteIcon />
          <span className="context-name">{n.name}</span>
          {n.description && <span className="context-desc muted">{n.description}</span>}
        </button>
      ))}
      {ctx.notes.length > NOTES_SHOWN && !allNotes && (
        <button className="link-button context-more" onClick={() => setAllNotes(true)}>
          {ctx.notes.length - NOTES_SHOWN} more memory note{ctx.notes.length - NOTES_SHOWN === 1 ? '' : 's'}
        </button>
      )}
    </div>
  )
}
