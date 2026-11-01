import { useMemo, useState } from 'react'
import type { LinearStatus, MemoryReport, NerfguardAction, PrFocus, SessionGroup, SessionSummary } from '../../../shared/types'
import { formatBytes } from '../../../shared/memory'
import { memoryTone } from './MemoryButton'
import { errorMessage, timeAgo } from '../format'
import { coreSessionEntries, type SessionActionHandlers } from '../sessionActions'
import { ArtifactIcon, BoardIcon, BranchIcon, WorktreeIcon, ChevronIcon, FolderPlusIcon, LinkIcon, MoreIcon, PlusIcon, SearchIcon } from './icons'
import { NerfguardButton } from './NerfguardButton'
import { PopupMenu, type MenuEntry } from './PopupMenu'
import { RenameField } from './SessionMenu'

export type Nav =
  | { kind: 'new' }
  /** focus: opened from a board card through another ticket's session; its PRs are shown and marked. */
  | { kind: 'session'; id: string; focus?: PrFocus }
  | { kind: 'workflow' }
  | { kind: 'worktrees' }
  | { kind: 'branches' }
  | { kind: 'artifacts' }

interface Props {
  sessions: SessionSummary[]
  groups: SessionGroup[]
  nav: Nav
  running: Set<string>
  /** Memory per session open here; a row shows it only once it's over the warning line. */
  memory?: MemoryReport | null
  onNav: (nav: Nav) => void
  /** Starts a new session, in `cwd` when given (a project header's +). */
  onNewSession: (cwd?: string) => void
  /** Labelled "~" when it is a project folder. */
  homeDir: string
  collapsedProjects: string[]
  onRename: (s: SessionSummary, name: string) => Promise<void>
  requestDelete: SessionActionHandlers['requestDelete']
  notify: SessionActionHandlers['notify']
  linear: LinearStatus | null
  onOpenLinear: () => void
  /** ⌘K: jump anywhere / search conversations. */
  onOpenPalette: () => void
  onNerfguard: (action: NerfguardAction) => void
}

const DRAG_TYPE = 'application/x-session-id'

export function Sidebar(props: Props) {
  const { sessions, groups, nav, running, onNav, onNewSession, notify, linear, onOpenLinear, homeDir } = props
  const [showArchived, setShowArchived] = useState(false)
  const [renamingSession, setRenamingSession] = useState<string | null>(null)
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ anchor: HTMLElement; entries: MenuEntry[] } | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const visible = sessions

  const active = visible.filter((s) => !s.archived)
  const archived = visible.filter((s) => s.archived)
  const pinned = active.filter((s) => s.pinned)
  // A pinned session shows only under Pinned; unpinning returns it to its group.
  const inGroup = (id: string | null) => active.filter((s) => !s.pinned && s.groupId === id)

  // Ungrouped sessions, one section per working folder, most recently used first.
  const projects = useMemo(() => {
    const byPath = new Map<string, SessionSummary[]>()
    for (const s of active) {
      if (s.pinned || s.groupId) continue
      byPath.set(s.startCwd, [...(byPath.get(s.startCwd) ?? []), s])
    }
    const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p
    const counts = new Map<string, number>()
    for (const p of byPath.keys()) counts.set(base(p), (counts.get(base(p)) ?? 0) + 1)
    const label = (p: string) => {
      if (p === homeDir) return '~'
      // Two folders with one name: add the parent so they can be told apart.
      return counts.get(base(p))! > 1 ? p.split('/').slice(-2).join('/') : base(p)
    }
    return [...byPath.entries()]
      .map(([path, items]) => ({ path, label: label(path), items, last: Math.max(...items.map((i) => i.lastActivity)) }))
      .sort((a, b) => b.last - a.last)
  }, [active, homeDir])

  const run = (fn: () => Promise<unknown>, done?: string) =>
    fn().then(
      () => {
        if (done) notify(done)
      },
      (e) => notify(errorMessage(e), 'error')
    )

  const newGroup = async () => {
    try {
      const g = await window.desk.createGroup('New group')
      setRenamingGroup(g.id)
    } catch (e) {
      notify(errorMessage(e), 'error')
    }
  }

  // Section headers accept a dragged session row: Pinned pins it, a group files
  // it there, a project folder takes it out of groups and pins.
  const dropProps = (key: string, apply: (s: SessionSummary) => Promise<unknown> | null, done: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
      e.preventDefault()
      setDropTarget(key)
    },
    onDragLeave: () => setDropTarget((t) => (t === key ? null : t)),
    onDrop: (e: React.DragEvent) => {
      setDropTarget(null)
      const s = sessions.find((x) => x.id === e.dataTransfer.getData(DRAG_TYPE))
      const work = s && apply(s)
      if (!work) return
      e.preventDefault()
      run(() => work, done)
    },
    'data-drop': dropTarget === key ? 'over' : undefined
  })

  const toGroup = (g: SessionGroup) =>
    dropProps(
      `group:${g.id}`,
      (s) =>
        s.groupId === g.id && !s.pinned
          ? null
          : Promise.all([window.desk.moveSession(s.id, g.id), s.pinned && window.desk.pinSession(s.id, false)]),
      `Moved to ${g.name}`
    )
  const toPinned = dropProps('pinned', (s) => (s.pinned ? null : window.desk.pinSession(s.id, true)), 'Pinned')
  const toProject = (path: string) =>
    dropProps(
      `project:${path}`,
      (s) =>
        !s.groupId && !s.pinned
          ? null
          : Promise.all([s.groupId && window.desk.moveSession(s.id, null), s.pinned && window.desk.pinSession(s.id, false)]),
      'Removed from group'
    )

  const row = (s: SessionSummary) => {
    const isActive = nav.kind === 'session' && nav.id === s.id
    // Activity from the hooks wins; otherwise where the session is open.
    const status =
      s.activity?.state ?? (running.has(s.id) ? 'running' : s.liveElsewhere ? 'elsewhere' : 'idle')
    const mem = props.memory?.sessions[s.id]
    const memTone = memoryTone(mem, props.memory?.thresholds)
    const where = running.has(s.id) ? 'here' : s.liveElsewhere ? `in ${s.liveElsewhere.entrypoint}` : ''
    const tooltip = [
      s.title,
      s.tickets[0],
      s.prs.length ? `${s.prs.length} PR${s.prs.length > 1 ? 's' : ''}` : '',
      status === 'working'
        ? `working (${where})`
        : status === 'waiting'
          ? `waiting for you (${where})`
          : status === 'running'
            ? 'open here'
            : status === 'elsewhere'
              ? `open ${where}`
              : '',
      mem ? `using ${formatBytes(mem.bytes)} of memory` : '',
      timeAgo(s.lastActivity)
    ]
      .filter(Boolean)
      .join(' · ')

    if (renamingSession === s.id) {
      return (
        <li key={s.id}>
          <div className="session-row active">
            <span className={`status status-${status}`} />
            <RenameField
              className="row-rename"
              initial={s.titleSource === 'custom' || s.titleSource === 'ai' ? s.title : ''}
              onCancel={() => setRenamingSession(null)}
              onSubmit={async (name) => {
                await props.onRename(s, name)
                setRenamingSession(null)
              }}
            />
          </div>
        </li>
      )
    }

    const openMenu = (anchor: HTMLElement) => {
      const core = coreSessionEntries(s, groups, running.has(s.id), {
        startRename: () => setRenamingSession(s.id),
        requestDelete: props.requestDelete,
        notify
      })
      setMenu({ anchor, entries: [core.pin, core.rename, core.move, 'divider', core.archive, core.del] })
    }

    return (
      <li key={s.id}>
        <div
          className={`session-row ${isActive ? 'active' : ''} ${s.archived ? 'archived' : ''} ${menu?.anchor.dataset.sid === s.id ? 'menu-open' : ''}`}
          role="button"
          tabIndex={0}
          title={tooltip}
          draggable={!s.archived}
          onDragStart={(e) => {
            e.dataTransfer.setData(DRAG_TYPE, s.id)
            e.dataTransfer.effectAllowed = 'move'
          }}
          onClick={() => onNav({ kind: 'session', id: s.id })}
          onKeyDown={(e) => e.key === 'Enter' && onNav({ kind: 'session', id: s.id })}
          onContextMenu={(e) => {
            e.preventDefault()
            openMenu(e.currentTarget.querySelector<HTMLElement>('.row-more')!)
          }}
        >
          <span className={`status status-${status}`} />
          <span className="session-name">{s.title}</span>
          {memTone && mem && <span className={`session-memory ${memTone}`}>{formatBytes(mem.bytes)}</span>}
          {s.tickets[0] && <span className="session-ticket">{s.tickets[0].replace(/^[A-Z][A-Z0-9]*-/, '')}</span>}
          <button
            className="row-more icon-button"
            data-sid={s.id}
            aria-label={`Actions for ${s.title}`}
            title="More"
            onClick={(e) => {
              e.stopPropagation()
              if (menu?.anchor === e.currentTarget) setMenu(null)
              else openMenu(e.currentTarget)
            }}
          >
            <MoreIcon />
          </button>
        </div>
      </li>
    )
  }

  const groupSection = (g: SessionGroup) => {
    const items = inGroup(g.id)
    const expanded = !g.collapsed
    return (
      <section key={g.id} className="group">
        <div className="section-header group-header" {...toGroup(g)}>
          {renamingGroup === g.id ? (
            <RenameField
              className="row-rename group-rename"
              initial={g.name}
              onCancel={() => setRenamingGroup(null)}
              onSubmit={async (name) => {
                await run(() => window.desk.renameGroup(g.id, name))
                setRenamingGroup(null)
              }}
            />
          ) : (
            <button
              className="group-toggle"
              aria-expanded={expanded}
              onClick={() => run(() => window.desk.setGroupCollapsed(g.id, !g.collapsed))}
            >
              <span className={`disclosure ${expanded ? 'open' : ''}`}>
                <ChevronIcon />
              </span>
              <span className="group-name">{g.name}</span>
              <span className="count">{items.length}</span>
            </button>
          )}
          <span className="section-actions">
            <button
              className="icon-button row-more"
              aria-label={`Actions for group ${g.name}`}
              onClick={(e) =>
                setMenu({
                  anchor: e.currentTarget,
                  entries: [
                    { label: 'Rename group…', onSelect: () => setRenamingGroup(g.id) },
                    {
                      label: 'Delete group',
                      danger: true,
                      onSelect: () =>
                        run(
                          () => window.desk.deleteGroup(g.id),
                          items.length ? `Deleted ${g.name}; its sessions moved to Sessions` : `Deleted ${g.name}`
                        )
                    }
                  ]
                })
              }
            >
              <MoreIcon />
            </button>
          </span>
        </div>
        {expanded && (
          <ul className="session-list-group">
            {items.map(row)}
            {items.length === 0 && <li className="empty group-empty">Drag sessions here</li>}
          </ul>
        )}
      </section>
    )
  }


  return (
    <aside className="sidebar">
      {/* Shares the traffic-light row, like the native title bar. */}
      <div className="sidebar-toolbar">
        <button className="icon-button" data-tip="Jump to… (⌘K)" aria-label="Jump to" onClick={props.onOpenPalette}>
          <SearchIcon />
        </button>
        <button className="icon-button" data-tip="New group" aria-label="New group" onClick={newGroup}>
          <FolderPlusIcon />
        </button>
        <NerfguardButton notify={notify} onRun={props.onNerfguard} />
      </div>

      <nav className="sidebar-nav">
        <button className={`nav-row ${nav.kind === 'new' ? 'active' : ''}`} onClick={() => onNewSession()}>
          <PlusIcon />
          New session
        </button>
        <button
          className={`nav-row ${nav.kind === 'workflow' ? 'active' : ''}`}
          onClick={() => onNav({ kind: 'workflow' })}
        >
          <BoardIcon />
          Workflow
        </button>
        <button
          className={`nav-row ${nav.kind === 'worktrees' ? 'active' : ''}`}
          onClick={() => onNav({ kind: 'worktrees' })}
        >
          <WorktreeIcon />
          Worktrees
        </button>
        <button
          className={`nav-row ${nav.kind === 'branches' ? 'active' : ''}`}
          onClick={() => onNav({ kind: 'branches' })}
        >
          <BranchIcon />
          Branches
        </button>
        <button
          className={`nav-row ${nav.kind === 'artifacts' ? 'active' : ''}`}
          onClick={() => onNav({ kind: 'artifacts' })}
        >
          <ArtifactIcon />
          Artifacts
        </button>
      </nav>

      <div className="session-scroll">
        {pinned.length > 0 && (
          <section className="group">
            <div className="section-header" {...toPinned}>
              <span>Pinned</span>
            </div>
            <ul className="session-list-group">{pinned.map(row)}</ul>
          </section>
        )}

        {groups.map(groupSection)}

        {projects.map(({ path, label, items }) => {
          const expanded = !props.collapsedProjects.includes(path)
          return (
            <section key={path} className="group">
              <div className="section-header group-header" {...toProject(path)}>
                <button
                  className="group-toggle"
                  title={path}
                  aria-expanded={expanded}
                  onClick={() => run(() => window.desk.setProjectCollapsed(path, expanded))}
                >
                  <span className={`disclosure ${expanded ? 'open' : ''}`}>
                    <ChevronIcon />
                  </span>
                  <span className="group-name">{label}</span>
                  <span className="count">{items.length}</span>
                </button>
                <span className="section-actions">
                  <button
                    className="icon-button row-more"
                    title={`New session in ${label}`}
                    aria-label={`New session in ${label}`}
                    onClick={() => onNewSession(path)}
                  >
                    <PlusIcon />
                  </button>
                </span>
              </div>
              {expanded && <ul className="session-list-group">{items.map(row)}</ul>}
            </section>
          )
        })}

        {archived.length > 0 && (
          <section className="group">
            <button className="archived-toggle" onClick={() => setShowArchived((v) => !v)} aria-expanded={showArchived}>
              <span className={`disclosure ${showArchived ? 'open' : ''}`}>
                <ChevronIcon />
              </span>
              Archived <span className="count">{archived.length}</span>
            </button>
            {showArchived && <ul className="session-list-group">{archived.map(row)}</ul>}
          </section>
        )}
      </div>

      {menu && <PopupMenu anchor={menu.anchor} entries={menu.entries} onClose={() => setMenu(null)} align="right" />}

      <button className="account-row" onClick={onOpenLinear}>
        {linear?.connected ? (
          <>
            <span className="avatar">{linear.viewer.trim().charAt(0).toUpperCase()}</span>
            <span className="account-name">
              {linear.viewer.split(' ')[0]}
              <span className="account-org"> · Linear</span>
            </span>
            <ChevronIcon />
          </>
        ) : (
          <>
            <span className="avatar avatar-empty">
              <LinkIcon />
            </span>
            <span className="account-name">{linear === null ? 'Linear…' : 'Connect Linear'}</span>
          </>
        )}
      </button>
    </aside>
  )
}
