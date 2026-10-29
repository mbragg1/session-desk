import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BoardCard, Kickoff, LinearIssue, LinearStatus, NerfguardAction, PermissionMode, PrBranch, SessionGroup, SessionLaunch, SessionSummary, TicketBranch } from '../../shared/types'
import { Board } from './components/Board'
import { LinearSettings } from './components/LinearSettings'
import { SessionHeader } from './components/SessionHeader'
import { SessionMenu } from './components/SessionMenu'
import { Sidebar, type Nav } from './components/Sidebar'
import { SidebarResizer, useSidebarWidth } from './components/SidebarResizer'
import { clampFont, loadFontSize, saveFontSize } from './termFont'
import { TextSizeButton } from './components/TextSizeButton'
import { Terminal } from './components/Terminal'
import { Worktrees } from './components/Worktrees'
import { Branches } from './components/Branches'
import { CommandPalette } from './components/CommandPalette'
import { SettingsDialog } from './components/SettingsDialog'
import { Artifacts } from './components/Artifacts'
import { errorMessage, folderName, setLinearWorkspaceKey } from './format'
import { FolderChip } from './components/FolderChip'
import { ModelPicker } from './components/ModelPicker'
import { UsageButton } from './components/UsageButton'
import { NerfguardPanel } from './components/NerfguardPanel'
import { ModeButton, modeLabel } from './components/ModeButton'
import { busyReason, readiness, startWork, startWorkNotice } from './startWork'

interface OpenTerm {
  id: string
  resume: boolean
  cwd: string
  ticket?: string
  /** Opening turn, sent once: a restart clears it. */
  kickoff?: Kickoff
  prBranch?: PrBranch
  /** Bumped to remount (restart) a terminal after its process exits. */
  gen: number
  exited: boolean
}

export function App() {
  const [scanned, setScanned] = useState<SessionSummary[]>([])
  // Sessions started from a board card that have no transcript yet (nothing sent).
  const [pending, setPending] = useState<Record<string, SessionSummary>>({})
  // Opens on the Workflow board; a new chat is still what's shown when you deselect a session.
  const [nav, setNav] = useState<Nav>({ kind: 'workflow' })
  const [terms, setTerms] = useState<OpenTerm[]>([])
  // The unused new-session terminal, and the folder it starts in.
  const [draft, setDraft] = useState<{ id: string; cwd: string } | null>(null)
  const [collapsedProjects, setCollapsedProjects] = useState<string[]>([])
  const [defaultCwd, setDefaultCwd] = useState('')
  // Distinguishes "not loaded yet" from "no projects folder chosen" (a new user).
  const [cwdLoaded, setCwdLoaded] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [linear, setLinearState] = useState<LinearStatus | null>(null)
  // Ticket links follow the connected (or last-known) Linear workspace.
  const setLinear = useCallback((s: LinearStatus) => {
    setLinearWorkspaceKey(s.workspace?.urlKey ?? null)
    setLinearState(s)
  }, [])
  const [showLinear, setShowLinear] = useState(false)
  const [notice, setNotice] = useState<{ text: string; kind: 'info' | 'error'; at: number } | null>(null)
  const [groups, setGroups] = useState<SessionGroup[]>([])
  const [confirmDelete, setConfirmDelete] = useState<SessionSummary | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)

  const notify = useCallback(
    (text: string, kind: 'info' | 'error' = 'info') => setNotice({ text, kind, at: Date.now() }),
    []
  )

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), notice.kind === 'error' ? 7000 : 3500)
    return () => clearTimeout(t)
  }, [notice])

  const refresh = useCallback(() => {
    window.desk.listSessions().then(setScanned)
    window.desk.listGroups().then(setGroups)
    window.desk.listCollapsedProjects().then(setCollapsedProjects)
  }, [])

  useEffect(() => {
    refresh()
    const loadCwd = () =>
      window.desk.defaultCwd().then((cwd) => {
        setDefaultCwd(cwd)
        setCwdLoaded(true)
      })
    loadCwd()
    window.desk.linearStatus().then((s) => {
      setLinear(s)
      // Without Linear the board is only a Connect button: start on a new chat instead.
      if (!s.connected) setNav((n) => (n.kind === 'workflow' ? { kind: 'new' } : n))
    })
    return window.desk.onSessionsChanged(refresh)
  }, [refresh])

  const sessions = useMemo(() => {
    const known = new Set(scanned.map((s) => s.id))
    return [...Object.values(pending).filter((p) => !known.has(p.id)), ...scanned]
  }, [scanned, pending])

  // A pending session becomes a real one once its transcript exists.
  useEffect(() => {
    const known = new Set(scanned.map((s) => s.id))
    if (Object.keys(pending).some((id) => known.has(id))) {
      setPending((p) => Object.fromEntries(Object.entries(p).filter(([id]) => !known.has(id))))
    }
  }, [scanned, pending])

  const openTerm = useCallback((t: Omit<OpenTerm, 'gen' | 'exited'>) => {
    setTerms((ts) => (ts.some((x) => x.id === t.id) ? ts : [...ts, { ...t, gen: 0, exited: false }]))
  }, [])

  // An unused draft has no transcript and so no sidebar entry. Reuse it rather
  // than orphaning its process behind a second one; replace it only when a
  // different folder is asked for.
  const startDraft = useCallback(
    (cwd?: string) => {
      const target = cwd ?? defaultCwd
      setNav({ kind: 'new' })
      setDraft((d) => {
        if (d && d.cwd === target) return d
        if (d) {
          window.desk.ptyKill(d.id)
          setTerms((ts) => ts.filter((t) => t.id !== d.id))
        }
        return { id: crypto.randomUUID(), cwd: target }
      })
    },
    [defaultCwd]
  )

  // The default screen is always a fresh chat: make sure one exists.
  useEffect(() => {
    if (nav.kind === 'new' && defaultCwd) setDraft((d) => d ?? { id: crypto.randomUUID(), cwd: defaultCwd })
  }, [nav, defaultCwd])

  useEffect(() => {
    if (draft) openTerm({ id: draft.id, resume: false, cwd: draft.cwd })
  }, [draft, openTerm])

  // Once the draft has a transcript it is a real session: select it in the
  // sidebar so its PR/ticket panels show, and prepare a new draft for next time.
  useEffect(() => {
    if (draft && scanned.some((s) => s.id === draft.id)) {
      if (nav.kind === 'new') setNav({ kind: 'session', id: draft.id })
      setDraft(null)
    }
  }, [scanned, draft, nav])

  const selected = nav.kind === 'session' ? sessions.find((s) => s.id === nav.id) : undefined

  useEffect(() => window.desk.setActiveSession(nav.kind === 'session' ? nav.id : null), [nav])
  useEffect(() => window.desk.onNavigateToSession((id) => setNav({ kind: 'session', id })), [])
  useEffect(() => window.desk.onNotice((text) => notify(text)), [notify])
  useEffect(() => window.desk.onOpenSettings(() => setShowSettings(true)), [])
  // Text size of every session terminal, from the footer's Aa control.
  const [fontSize, setFontSizeState] = useState(loadFontSize)
  const setFontSize = (size: number) => {
    const next = clampFont(size)
    setFontSizeState(next)
    saveFontSize(next)
  }

  // Folders changed in Settings: re-read the projects folder, and replace an
  // unused new-session terminal so it starts in the new one.
  useEffect(
    () =>
      window.desk.onSettingsChanged(async () => {
        // A different project may have its own Linear connection (or none).
        void window.desk.linearStatus().then(setLinear)
        const cwd = await window.desk.defaultCwd()
        setDefaultCwd(cwd)
        setCwdLoaded(true)
        setDraft((d) => {
          if (!d || d.cwd === cwd) return d
          window.desk.ptyKill(d.id)
          setTerms((ts) => ts.filter((t) => t.id !== d.id))
          return cwd ? { id: crypto.randomUUID(), cwd } : null
        })
        refresh()
      }),
    [refresh]
  )

  // ⌘K opens the palette; ⌘1–9 open pinned sessions in sidebar order. Captured
  // before the terminal sees them.
  const pinnedIds = useMemo(() => sessions.filter((s) => s.pinned && !s.archived).map((s) => s.id), [sessions])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.altKey || e.ctrlKey || e.shiftKey) return
      if (e.key.toLowerCase() === 'k') {
        e.preventDefault()
        e.stopPropagation()
        setPaletteOpen((o) => !o)
      } else if (/^[1-9]$/.test(e.key) && pinnedIds[Number(e.key) - 1]) {
        e.preventDefault()
        e.stopPropagation()
        setPaletteOpen(false)
        setNav({ kind: 'session', id: pinnedIds[Number(e.key) - 1] })
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [pinnedIds])
  const runningIds = useMemo(() => new Set(terms.filter((t) => !t.exited).map((t) => t.id)), [terms])

  // Opening a session resumes it, unless another process already has it open:
  // two writers on one transcript corrupt it, so that needs an explicit choice.
  useEffect(() => {
    if (selected && !selected.liveElsewhere) openTerm({ id: selected.id, resume: true, cwd: selected.startCwd })
  }, [selected, openTerm])

  /** open: switch to it (a card click); a drag into In Progress starts it in the background. */
  const startTicketSession = async (issue: LinearIssue, opts: { kickoff?: Kickoff; open?: boolean } = {}) => {
    const id = crypto.randomUUID()
    // Shown until the session's transcript exists; Claude Code then titles it.
    const name = `${issue.identifier} ${issue.title}`
    await window.desk.linkSession(id, issue.identifier)
    setPending((p) => ({
      ...p,
      [id]: {
        id,
        transcriptPath: '',
        startCwd: defaultCwd,
        title: name,
        titleSource: 'custom',
        tickets: [issue.identifier],
        ticketSource: 'manual',
        prs: [],
        entrypoint: 'cli',
        lastActivity: Date.now(),
        liveElsewhere: null,
        archived: false,
        groupId: null,
        pinned: false,
        activity: null,
        plan: 'none',
        worked: false,
        turnEndedAt: 0,
        model: null,
        effort: null,
        contextTokens: null,
        launch: null
      }
    }))
    openTerm({ id, resume: false, cwd: defaultCwd, ticket: issue.identifier, kickoff: opts.kickoff })
    if (opts.open !== false) setNav({ kind: 'session', id })
  }

  // A card moved into In Progress (by you, in this app): plan the ticket in a
  // new session, or pick its session back up where it left off. The hooks then
  // move the card to Waiting Response whenever the session needs you.
  const startWorkOn = (card: BoardCard) => {
    const ticket = card.issue.identifier
    // Started this run and not yet written to disk: it's already on it.
    if (Object.values(pending).some((p) => p.tickets[0] === ticket)) return
    const plan = startWork(card, sessions, runningIds)
    notify(startWorkNotice(ticket, plan))
    if (plan.kind === 'new') void startTicketSession(card.issue, { kickoff: 'plan', open: false })
    else if (plan.kind !== 'leave') sendTurn(plan.session, ticket, plan.kickoff, plan.kind === 'resume')
  }

  /** Sends an app-written turn: typed at an idle prompt, or as the opening turn of a resume. */
  const sendTurn = (s: SessionSummary, ticket: string, kickoff: Kickoff, resume: boolean, prBranch?: PrBranch) => {
    if (!resume) {
      void window.desk.ptyKickoff(s.id, ticket, kickoff, prBranch)
      return
    }
    const term = { id: s.id, resume: true, cwd: s.startCwd, ticket, kickoff, prBranch }
    // An exited terminal is remounted with the turn; otherwise a fresh one opens.
    setTerms((ts) =>
      ts.some((t) => t.id === s.id)
        ? ts.map((t) => (t.id === s.id ? { ...t, ...term, gen: t.gen + 1, exited: false } : t))
        : [...ts, { ...term, gen: 0, exited: false }]
    )
  }

  // Create PR asks Claude in the session, so the PR gets the title and
  // description it normally writes, rather than GitHub's blank form.
  const askOpenPr = (s: SessionSummary, b: TicketBranch) => {
    const ticket = s.tickets[0]
    const r = readiness(s, runningIds)
    if (!ticket || busyReason(r)) return
    notify(`Asking Claude to open a PR for ${b.branch}`)
    sendTurn(s, ticket, 'open-pr', r === 'closed', { repo: b.repo, branch: b.branch, label: b.label })
    window.dispatchEvent(new Event('desk:focus-terminal'))
  }

  // The ticket's own session; else one just started for it; else the session
  // that opened its PR. A new session only when the ticket has none of these.
  const openCard = (card: BoardCard) => {
    const existing =
      card.sessionIds[0] ??
      Object.values(pending).find((p) => p.tickets[0] === card.issue.identifier)?.id ??
      card.prSessionIds[0]
    // Through another ticket's session: point out the card's PRs among its own.
    const focus = existing && !card.sessionIds.length && card.prSessionIds[0] === existing
      ? { ticket: card.issue.identifier, prUrls: card.prs.map((p) => p.url) }
      : undefined
    if (existing) setNav({ kind: 'session', id: existing, focus })
    else startTicketSession(card.issue)
  }

  // Board renders its cycle chip and Refresh into the top bar through this node.
  const [topbarActions, setTopbarActions] = useState<HTMLDivElement | null>(null)
  const topbarCwd = nav.kind === 'new' ? (draft?.cwd ?? defaultCwd) : nav.kind === 'session' ? selected?.startCwd : undefined

  // One rename path for the sidebar row and the title menu.
  const renameSession = async (s: SessionSummary, name: string) => {
    try {
      const result = await window.desk.renameSession(s.id, name)
      if (result === 'prefilled') {
        // The typed /rename waits in that session's prompt: show it and focus it.
        setNav({ kind: 'session', id: s.id })
        setTimeout(() => window.dispatchEvent(new Event('desk:focus-terminal')), 50)
        notify('Press Enter in the terminal to apply the rename')
      } else {
        notify(`Renamed to “${name}”`)
      }
    } catch (e) {
      notify(errorMessage(e), 'error')
    }
  }

  const deleteSession = async (s: SessionSummary) => {
    setConfirmDelete(null)
    try {
      await window.desk.deleteSession(s.id)
      if (nav.kind === 'session' && nav.id === s.id) setNav({ kind: 'new' })
      notify(`Moved “${s.title}” to the Trash`)
    } catch (e) {
      notify(errorMessage(e), 'error')
    }
  }

  const activeTermId = nav.kind === 'session' ? nav.id : nav.kind === 'new' ? (draft?.id ?? null) : null
  const activeTerm = terms.find((t) => t.id === activeTermId)
  useEffect(() => window.desk.setVisibleTerminal(activeTermId), [activeTermId])

  // Model/effort chosen here. The scan reports it for sessions; a new chat has
  // no summary yet, so its choice is kept here (it also shows before the scan catches up).
  const [launchChoice, setLaunchChoice] = useState<Record<string, SessionLaunch>>({})

  // Each open session's permission mode, as its terminal shows it.
  const [modes, setModes] = useState<Record<string, PermissionMode>>({})
  useEffect(() => window.desk.onPtyMode((id, mode) => setModes((m) => ({ ...m, [id]: mode }))), [])
  useEffect(() => {
    if (!activeTermId) return
    void window.desk.ptyMode(activeTermId).then((mode) => mode && setModes((m) => ({ ...m, [activeTermId]: mode })))
  }, [activeTermId])

  /**
   * Switches the session's mode, for this session only. The four that Shift+Tab
   * cycles switch live; Bypass restarts it in that mode, and leaving Bypass
   * restarts it without, then switches.
   */
  const chooseMode = async (id: string, mode: PermissionMode) => {
    try {
      if (mode === 'bypassPermissions') {
        await chooseLaunch(id, { permissionMode: 'bypassPermissions' })
        return
      }
      if (modes[id] === 'bypassPermissions') {
        await chooseLaunch(id, { permissionMode: null })
        // The restarted session draws its footer, then it can switch.
        for (let i = 0; i < 40 && !(await window.desk.ptyMode(id)); i++) await new Promise((r) => setTimeout(r, 250))
      }
      const reached = await window.desk.ptySetMode(id, mode)
      if (reached !== mode) notify(`Couldn't switch to ${modeLabel(mode)}; the terminal shows ${modeLabel(reached)}`, 'error')
    } catch (e) {
      notify(errorMessage(e), 'error')
    }
  }

  /** For this session only: saved, then its Claude is restarted with --model/--effort. */
  const chooseLaunch = async (id: string, choice: { model?: string; effort?: string; permissionMode?: 'bypassPermissions' | null }) => {
    try {
      await window.desk.setSessionLaunch(id, choice)
      // The local copy only drives the model/effort display; null clears bypass.
      const { permissionMode, ...rest } = choice
      setLaunchChoice((c) => ({
        ...c,
        [id]: { ...c[id], ...rest, permissionMode: permissionMode ?? undefined, at: Date.now() }
      }))
      // Wait for the old process to exit, so the new one never overlaps it.
      if (runningIds.has(id)) await window.desk.ptyStop(id)
      const resume = scanned.some((s) => s.id === id)
      setTerms((ts) =>
        ts.map((t) => (t.id === id ? { ...t, resume, kickoff: undefined, prBranch: undefined, gen: t.gen + 1, exited: false } : t))
      )
      notify(resume ? 'Restarting this session with the new setting' : 'Applied to this new chat')
    } catch (e) {
      notify(errorMessage(e), 'error')
    }
  }

  // NerfGuard changes the route new claude processes take; idle sessions can restart onto it.
  const [nerfguardAction, setNerfguardAction] = useState<NerfguardAction | null>(null)
  const idleHere = sessions.filter((s) => readiness(s, runningIds) === 'idle').map((s) => s.id)
  const openForRoute = { idle: idleHere.length, busy: runningIds.size - idleHere.length }
  const restartIdle = async () => {
    const ids = idleHere
    await Promise.all(ids.map((id) => window.desk.ptyStop(id)))
    setTerms((ts) =>
      ts.map((t) =>
        ids.includes(t.id)
          ? { ...t, resume: scanned.some((s) => s.id === t.id), kickoff: undefined, prBranch: undefined, gen: t.gen + 1, exited: false }
          : t
      )
    )
    return ids.length
  }

  const markExited = (id: string) => setTerms((ts) => ts.map((t) => (t.id === id ? { ...t, exited: true } : t)))
  const [sidebarWidth, setSidebarWidth] = useSidebarWidth()

  // Resume only works once a transcript exists; a session that exited before
  // anything was sent starts over under the same id.
  const restart = (id: string) => {
    const resume = scanned.some((s) => s.id === id)
    setTerms((ts) => ts.map((t) => (t.id === id ? { ...t, resume, kickoff: undefined, prBranch: undefined, gen: t.gen + 1, exited: false } : t)))
  }

  return (
    <div className="app" style={{ gridTemplateColumns: `${sidebarWidth}px 1fr` }}>
      <SidebarResizer width={sidebarWidth} onChange={setSidebarWidth} />
      <Sidebar
        sessions={sessions}
        groups={groups}
        onRename={renameSession}
        requestDelete={setConfirmDelete}
        notify={notify}
        nav={nav}
        running={runningIds}
        onNav={setNav}
        onNewSession={startDraft}
        homeDir={defaultCwd.replace(/^(\/Users\/[^/]+).*$/, '$1')}
        collapsedProjects={collapsedProjects}
        linear={linear}
        onOpenLinear={() => setShowSettings(true)}
        onOpenPalette={() => setPaletteOpen(true)}
        onNerfguard={setNerfguardAction}
      />
      <main className="main">
        {/* Title row shared with the traffic lights, as in the native app. */}
        <div className="topbar">
          {nav.kind === 'session' && selected && !(selected.id in pending) ? (
            <SessionMenu
              session={selected}
              groups={groups}
              runningHere={runningIds.has(selected.id)}
              onStop={() => window.desk.ptyKill(selected.id)}
              onRename={renameSession}
              requestDelete={setConfirmDelete}
              notify={notify}
            />
          ) : (
            <h1 className="topbar-title">
              {nav.kind === 'workflow'
                ? 'Workflow'
                : nav.kind === 'branches'
                  ? 'Branches'
                : nav.kind === 'worktrees'
                  ? 'Worktrees'
                  : nav.kind === 'artifacts'
                    ? 'Artifacts'
                  : nav.kind === 'new'
                    ? 'New session'
                    : (selected?.title ?? '')}
            </h1>
          )}
          {topbarCwd && (
            <FolderChip
              path={topbarCwd}
              sessionId={nav.kind === 'session' ? (selected?.id ?? null) : null}
              notify={notify}
            />
          )}
          <div className="topbar-actions" ref={setTopbarActions} />
        </div>

        {nav.kind === 'workflow' && (
          <Board
            connected={!!linear?.connected}
            running={runningIds}
            onOpenCard={openCard}
            onStartWork={startWorkOn}
            onConnect={() => setShowLinear(true)}
            onOpenSettings={() => setShowSettings(true)}
            actionsTarget={topbarActions}
          />
        )}

        {nav.kind === 'worktrees' && <Worktrees actionsTarget={topbarActions} notify={notify} />}
        {nav.kind === 'branches' && (
          <Branches actionsTarget={topbarActions} notify={notify} onOpenSession={(id) => setNav({ kind: 'session', id })} />
        )}
        {nav.kind === 'artifacts' && (
          <Artifacts sessions={sessions} notify={notify} onOpenSession={(id) => setNav({ kind: 'session', id })} />
        )}

        {nav.kind === 'session' && selected && (
          <SessionHeader
            session={selected}
            linearConnected={!!linear?.connected}
            focus={nav.focus}
            onOpenPr={(b) => askOpenPr(selected, b)}
            openPrBlocked={busyReason(readiness(selected, runningIds))}
          />
        )}

        {nav.kind === 'session' && selected?.liveElsewhere && !activeTerm && (
          <div className="notice">
            <p>
              This session is open in <strong>{selected.liveElsewhere.entrypoint}</strong> (pid{' '}
              {selected.liveElsewhere.pid}). Resuming it here as well means two processes writing one
              transcript. Close it there first.
            </p>
            <button className="btn" onClick={() => openTerm({ id: selected.id, resume: true, cwd: selected.startCwd })}>
              Resume here anyway
            </button>
          </div>
        )}

        {nav.kind === 'new' && cwdLoaded && !defaultCwd && (
          <div className="onboarding">
            <h1>Choose your projects folder</h1>
            <p>
              New sessions start there, and Session Desk reads its repos, their worktrees and its <code>.session-desk.json</code>
              from it. You can change it later in Settings (⌘,).
            </p>
            <button className="btn btn-primary" onClick={() => window.desk.pickFolder('workspace')}>
              Choose folder…
            </button>
          </div>
        )}

        <div
          className="term-stack"
          style={{ display: nav.kind === 'session' || (nav.kind === 'new' && defaultCwd) ? 'flex' : 'none' }}
        >
          {terms.map((t) => (
            <Terminal
              key={`${t.id}:${t.gen}`}
              sessionId={t.id}
              resume={t.resume}
              cwd={t.cwd}
              ticket={t.ticket}
              kickoff={t.kickoff}
              prBranch={t.prBranch}
              visible={t.id === activeTermId}
              fontSize={fontSize}
              onExit={() => markExited(t.id)}
            />
          ))}
          {activeTerm?.exited && (
            <div className="term-overlay">
              <button className="btn btn-primary" onClick={() => restart(activeTerm.id)}>
                Resume session
              </button>
            </div>
          )}
        </div>
        {activeTermId && (nav.kind === 'session' ? !!selected : !!defaultCwd) && (
          <div className="session-footer">
            <ModeButton
              mode={modes[activeTermId] ?? null}
              blocked={
                !runningIds.has(activeTermId)
                  ? 'Starts when the session is open'
                  : nav.kind === 'session' && selected && readiness(selected, runningIds) === 'needs-you'
                    ? (busyReason('needs-you') as string)
                    : nav.kind === 'session' && selected?.liveElsewhere
                      ? (busyReason('elsewhere') as string)
                      : null
              }
              onChoose={(mode) => chooseMode(activeTermId, mode)}
            />
            <span className="footer-spacer" />
            <TextSizeButton size={fontSize} onChange={setFontSize} />
            <ModelPicker
              session={nav.kind === 'session' ? (selected ?? null) : null}
              launch={(nav.kind === 'session' ? selected?.launch : null) ?? launchChoice[activeTermId] ?? null}
              blocked={nav.kind === 'session' && selected ? busyReason(readiness(selected, runningIds)) : null}
              onChoose={(choice) => chooseLaunch(activeTermId, choice)}
            />
            <UsageButton
              sessionId={activeTermId}
              blocked={nav.kind === 'session' && selected ? busyReason(readiness(selected, runningIds)) : null}
              notify={notify}
            />
          </div>
        )}
      </main>

      {notice && (
        <div key={notice.at} className={`toast toast-${notice.kind}`} role="status">
          {notice.text}
        </div>
      )}

      {paletteOpen && (
        <CommandPalette
          sessions={sessions}
          linearConnected={!!linear?.connected}
          onNav={setNav}
          onNewSession={() => startDraft()}
          onOpenCard={openCard}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      {confirmDelete && (
        <div className="modal-backdrop" onMouseDown={() => setConfirmDelete(null)}>
          <div
            className="modal"
            role="alertdialog"
            aria-label="Delete session"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h1>Delete “{confirmDelete.title}”?</h1>
            <p>
              Its transcript and Claude Code's per-session files (rewind checkpoints, session env) move to the
              Trash. You can still put them back from Finder until the Trash is emptied.
            </p>
            <div className="modal-actions">
              <button className="btn" autoFocus onClick={() => setConfirmDelete(null)}>
                Cancel
              </button>
              <button className="btn btn-danger" onClick={() => deleteSession(confirmDelete)}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {nerfguardAction && (
        <NerfguardPanel
          action={nerfguardAction}
          open={openForRoute}
          onRestartIdle={restartIdle}
          fontSize={fontSize}
          onClose={() => setNerfguardAction(null)}
        />
      )}

      {showSettings && (
        <SettingsDialog
          linear={linear}
          notify={notify}
          onClose={() => setShowSettings(false)}
          onManageLinear={() => {
            setShowSettings(false)
            setShowLinear(true)
          }}
        />
      )}

      {showLinear && linear && (
        <LinearSettings status={linear} project={defaultCwd ? folderName(defaultCwd) : null} onChange={setLinear} onClose={() => setShowLinear(false)} />
      )}
    </div>
  )
}
