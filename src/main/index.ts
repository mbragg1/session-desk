import { execFile } from 'node:child_process'
import { promises as fs, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { CONFIG_NAME, loadProjectConfig, projectConfig, projectConfigStatus, starterConfig, watchProjectConfig } from './projectConfig'
import { defaultModel, withDefaultContext } from './modelChoice'
import { findNerfguard, forgetNerfguardStatus, NERFGUARD_ACTIONS, nerfguardStatus } from './nerfguard'
import { ToolTerminal } from './toolTerminal'
import { readModelCatalog } from './modelCatalog'
import { installStatusLine, readUsage } from './usage'
import type { Column, Kickoff, LinearStatus, PermissionMode, PtyStartRequest, RenameResult, SessionSummary, Settings, TicketBranch } from '../shared/types'
import { COLUMNS, EFFORT_CHOICES, NERFGUARD_INSTALL_COMMAND } from '../shared/types'
import { refreshPrInfo, requestGreptileReview, withInfo } from './github'
import { Indicators } from './indicators'
import { fetchBoard, fetchIssue, invalidate, linearStatus, moveIssue, refreshPrTickets, resetLinear } from './linear'
import { applyLinks, buildBoard } from './link'
import { cleanName, MODE_CYCLE, PtyManager } from './pty'
import { hookApply, hookPreview, hookStatus } from './hookInstaller'
import { installMenu, setProjectActions } from './menu'
import { claudeDir, defaultClaudeDir, describeClaudeDir, loadShellClaudeDir, workspace } from './paths'
import { listSessions, restoreScanCache, serializeScanCache, setTicketKeys, watchSessions } from './sessions'
import { PtyBatcher } from './ptyBatch'
import { activityOf, STATUS_DIR, watchActivity, withTurnEnd } from './status'
import { refreshLocalSync } from './sync'
import { refreshDeploys, resetDeploys } from './deploys'
import { linearHandlesReview, linearOwnRules, loadLinearRules, resetLinearRules, runAutoMoves } from './autoRunner'
import { runAutoPins } from './autoPin'
import { store } from './store'
import { openablePath, ticketContext } from './context'
import { searchTranscripts } from './search'
import { listArtifacts } from './artifacts'
import { KICKOFFS, kickoffPrompt, ticketBrief, validPrBranch } from './ticketBrief'
import { listWorktreesCached, pruneWorktrees, removeWorktree, ticketBranches } from './worktrees'
import { listBranches, removeBranch } from './branches'
import { deleteRemoteBranch, listRemoteLeftovers } from './remoteBranches'

// One state folder for dev and the installed app (whose name differs), so
// groups, pins and links carry over. Set before the single-instance lock,
// which is keyed on it. SESSION_DESK_DATA_DIR gives a test copy its own
// folder, and so its own lock: it runs beside the app instead of focusing it.
app.setPath('userData', process.env.SESSION_DESK_DATA_DIR || join(app.getPath('appData'), 'session-desk'))

// Two instances would each drive the same sessions; a second launch just
// brings the first one forward.
if (!app.requestSingleInstanceLock()) {
  app.exit(0)
}

// Chromium draws a frame when the display's refresh timer says so. Viewed
// over Screen Sharing after the connection changes, that timer can stop for
// the window, which then never redraws (input still works). Chromium's own
// timer keeps it drawing, at a small idle cost, so it's a per-account setting.
// Switches only apply before the app is ready: a change needs a restart.
const drawForScreenSharingAtLaunch = store.prefs().drawForScreenSharing
if (drawForScreenSharingAtLaunch) app.commandLine.appendSwitch('disable-gpu-vsync')


// Links we hand to the OS browser. Anything else is ignored.
const EXTERNAL_HOSTS = new Set(['github.com', 'linear.app', 'claude.ai', 'nerfguard.com'])

let win: BrowserWindow | null = null
// The session on screen, as the renderer reports it; null for other views.
let activeSessionId: string | null = null
// The terminal on screen (a session's, or the new-session one); its output isn't batched.
let visibleTerminalId: string | null = null

const ptyOutput = new PtyBatcher(
  (batch) => win?.webContents.send('pty:data', batch),
  () => visibleTerminalId
)

const ptys = new PtyManager(
  (id, data) => ptyOutput.push(id, data),
  (id, code, declinedBypass) => {
    // The exit notice follows the session's last output.
    ptyOutput.flush()
    win?.webContents.send('pty:exit', id, code)
    // "No, exit" on Claude's Bypass warning: forget the choice, or every restart would ask again.
    if (declinedBypass) void store.setSessionLaunch(id, { permissionMode: undefined }).then(notifySessions)
  },
  (id, mode) => win?.webContents.send('pty:mode', id, mode)
)

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    // Centred in the 52px toolbar row the sidebar draws beside them.
    trafficLightPosition: { x: 18, y: 20 },
    backgroundColor: '#f7f7f5',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  // Never let the renderer navigate away or open windows; route links out.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
  // On macOS closing the window leaves the app (and its sessions) running.
  win.on('closed', () => {
    win = null
    activeSessionId = null
  })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

function showWindow(): BrowserWindow {
  if (!win) createWindow()
  if (win!.isMinimized()) win!.restore()
  win!.show()
  win!.focus()
  return win!
}

/** Brings the window forward on a session (from a notification click). */
function openSession(id: string): void {
  const w = showWindow()
  const send = () => w.webContents.send('nav:session', id)
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send)
  else send()
}

const indicators = new Indicators({
  sessions: () => sessions(),
  runningHere: (id) => ptys.has(id),
  viewing: (id) => !!win?.isFocused() && activeSessionId === id,
  prefs: () => store.prefs(),
  openSession
})

function openExternal(url: string): void {
  try {
    const u = new URL(url)
    if (u.protocol === 'https:' && EXTERNAL_HOSTS.has(u.hostname)) shell.openExternal(u.toString())
  } catch {
    // Not a URL; ignore.
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TICKET_RE = /^[A-Z][A-Z0-9]*-\d+$/

// Every change that could alter a session's state also refreshes the Dock
// badge and notifications, whether or not the window is open.
const notifySessions = () => {
  win?.webContents.send('sessions:changed')
  sessionsChecked()
}

/** Everything a change notifies except the window: the Dock badge, notifications, Linear rules. */
const sessionsChecked = () => {
  void indicators.refresh()
  // Automatic Linear moves (only when the user enabled a rule).
  void runAutoMoves(sessions, (text) => win?.webContents.send('notice', text)).then((moved) => moved && notifySessions())
  // Pin the sessions of tickets under way; unpin them at Done.
  void runAutoPins(sessions).then((changed) => changed && notifySessions())
}

// What the window was last told about, from background re-checks.
let lastListed = ''

/**
 * For background triggers (file events, the liveness tick): re-scans, and
 * tells the window only if the list changed. Every transcript append and
 * every 10s tick used to make the window re-fetch and re-render the whole
 * list (and the board re-fetch Linear) even when nothing it shows had moved.
 */
const recheckSessions = () => {
  sessions()
    .then((list) => {
      const key = JSON.stringify(list)
      if (key !== lastListed) {
        lastListed = key
        notifySessions()
      } else sessionsChecked()
    })
    .catch(notifySessions)
}

/** Learns PR state and branches in the background, then tells the renderer to re-read. */
function refreshPrsLater(prs: SessionSummary['prs']): void {
  refreshPrInfo(prs).then((changed) => changed && notifySessions())
}

// The renderer and the Dock badge both ask on every change; let calls that
// land together share one scan. Never two at once: a scan re-reads every
// changed transcript, and with several sessions working, overlapping scans
// each re-read the same files (three at once measured 3 GB of a 4 GB heap).
// A call during a scan waits for one more, which sees whatever changed since.
let recentScan: { at: number; result: Promise<SessionSummary[]> } | null = null
let scanning: Promise<SessionSummary[]> | null = null
let queuedScan: Promise<SessionSummary[]> | null = null

function sessions(): Promise<SessionSummary[]> {
  if (scanning) {
    queuedScan ??= scanning
      .catch(() => undefined)
      .then(() => {
        queuedScan = null
        return startScan()
      })
    return queuedScan
  }
  if (recentScan && Date.now() - recentScan.at < 300) return recentScan.result
  return startScan()
}

function startScan(): Promise<SessionSummary[]> {
  const result = scanSessions()
  recentScan = { at: Date.now(), result }
  const done: Promise<SessionSummary[]> = result.finally(() => {
    if (scanning === done) scanning = null
  })
  // Callers handle a failed scan; this copy only tracks that one is running.
  done.catch(() => undefined)
  scanning = done
  return result
}

async function scanSessions(): Promise<SessionSummary[]> {
  const raw = await listSessions({ ownPids: ptys.pids(), includeSdk: false })
  refreshPrsLater(raw.flatMap((s) => s.prs))
  refreshPrTickets(raw.flatMap((s) => s.prs)).then((changed) => changed && notifySessions())
  const linked = applyLinks(raw)
  // Compare open PRs with their local checkouts; re-read once anything changes.
  const ws = workspace()
  if (ws) refreshLocalSync(ws, linked.flatMap((s) => s.prs)).then((changed) => changed && notifySessions())
  refreshDeploys(linked.flatMap((s) => s.prs)).then((changed) => changed && notifySessions())
  return linked.map((s) => ({
    ...s,
    archived: store.isArchived(s.id),
    groupId: store.groupOf(s.id),
    pinned: store.isPinned(s.id),
    // A status file outlives a crashed process; only trust it while one has the session open.
    activity: ptys.has(s.id) || s.liveElsewhere ? pickActivity(withTurnEnd(activityOf(s.id), s.turnEndedAt)) : null,
    launch: store.sessionLaunch(s.id)
  }))
}

const pickActivity = (a: ReturnType<typeof activityOf>) => (a ? { state: a.state, at: a.at, event: a.event } : null)

async function findSession(id: string): Promise<SessionSummary> {
  if (!UUID_RE.test(id)) throw new Error('not a session id')
  const s = (await listSessions({ ownPids: ptys.pids(), includeSdk: true })).find((x) => x.id === id)
  if (!s) throw new Error('Session not found')
  return s
}

/** True once `needle` appears in the file past byte offset `from`. */
async function appearedAfter(file: string, from: number, needle: string): Promise<boolean> {
  const fh = await fs.open(file, 'r')
  try {
    const { size } = await fh.stat()
    if (size <= from) return false
    const buf = Buffer.alloc(size - from)
    await fh.read(buf, 0, buf.length, from)
    return buf.toString('utf8').includes(needle)
  } finally {
    await fh.close()
  }
}

/** Single-quotes a string for a POSIX shell. */
const shq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`

const renaming = new Set<string>()

ipcMain.handle('sessions:list', () => sessions())
ipcMain.handle('sessions:link', async (_e, id: string, ticket: string | null) => {
  if (!UUID_RE.test(id)) throw new Error('not a session id')
  const t = ticket?.trim().toUpperCase() || null
  if (t && !TICKET_RE.test(t)) throw new Error(`"${ticket}" is not a ticket identifier like ENG-123`)
  await store.setLink(id, t)
  notifySessions()
})

ipcMain.handle('sessions:rename', async (_e, id: string, rawName: string): Promise<RenameResult> => {
  const name = cleanName(String(rawName ?? ''))
  if (!name) throw new Error('The name cannot be empty')
  if (!UUID_RE.test(id)) throw new Error('not a session id')
  // Running here: type Claude Code's own command into the prompt and leave
  // sending it to the user. Pressing Enter blindly could interrupt a turn or
  // merge with something half-typed.
  if (ptys.has(id)) {
    ptys.write(id, `/rename ${name}`)
    return 'prefilled'
  }
  const s = await findSession(id)
  if (s.liveElsewhere) {
    throw new Error(`It's open in ${s.liveElsewhere.entrypoint}. Rename it there, or close it there first.`)
  }
  if (renaming.has(id)) throw new Error('A rename is already in progress')
  renaming.add(id)
  try {
    // `--resume <id> --name <n>` makes Claude Code record the title itself
    // (custom-title + agent-name entries) without sending a turn.
    const from = (await fs.stat(s.transcriptPath)).size
    const needle = `"customTitle":${JSON.stringify(name)}`
    const ok = await ptys.runHeadless(id, s.startCwd, ['--name', name], () =>
      appearedAfter(s.transcriptPath, from, needle)
    )
    if (!ok) {
      throw new Error("Claude Code didn't record the new name in time. Open the session and run /rename there.")
    }
  } finally {
    renaming.delete(id)
  }
  notifySessions()
  return 'applied'
})
ipcMain.handle('sessions:archive', async (_e, id: string, archived: boolean) => {
  if (!UUID_RE.test(id)) throw new Error('not a session id')
  await store.setArchived(id, !!archived)
  notifySessions()
})
ipcMain.handle('sessions:delete', async (_e, id: string) => {
  const s = await findSession(id)
  if (ptys.has(id)) throw new Error('It is running here. Stop it first.')
  if (s.liveElsewhere) throw new Error(`It's open in ${s.liveElsewhere.entrypoint}. Close it there first.`)
  // Everything Claude Code keys by this session id: the transcript, the
  // same-named folder beside it, rewind checkpoints and the session's env.
  // Moved to the Trash, not erased, so a mis-click can be undone in Finder.
  const base = claudeDir()
  const paths = [
    s.transcriptPath,
    s.transcriptPath.replace(/\.jsonl$/, ''),
    join(base, 'file-history', id),
    join(base, 'session-env', id)
  ]
  for (const p of paths) {
    if (!p.startsWith(base + '/')) continue
    const exists = await fs.stat(p).then(() => true, () => false)
    if (exists) await shell.trashItem(p)
  }
  await store.forgetSession(id)
  // The hook's status file is ours; nothing else would ever clean it up.
  await fs.rm(join(STATUS_DIR, id), { force: true })
  notifySessions()
})
ipcMain.handle('sessions:move', async (_e, id: string, groupId: string | null) => {
  if (!UUID_RE.test(id)) throw new Error('not a session id')
  await store.moveSession(id, groupId || null)
  notifySessions()
})

const groupName = (name: unknown) => {
  const n = String(name ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 200)
  if (!n) throw new Error('The group needs a name')
  return n
}
ipcMain.handle('sessions:pin', async (_e, id: string, pinned: boolean) => {
  if (!UUID_RE.test(id)) throw new Error('not a session id')
  await store.setPinned(id, !!pinned)
  notifySessions()
})
ipcMain.handle('projects:collapsed', () => store.collapsedProjects())
ipcMain.handle('projects:collapse', async (_e, path: string, collapsed: boolean) => {
  if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('not a folder path')
  await store.setProjectCollapsed(path, !!collapsed)
  notifySessions()
})

ipcMain.handle('groups:list', () => store.groups())
ipcMain.handle('groups:create', async (_e, name: string) => {
  const g = await store.createGroup(groupName(name))
  notifySessions()
  return g
})
ipcMain.handle('groups:rename', async (_e, id: string, name: string) => {
  await store.updateGroup(id, { name: groupName(name) })
  notifySessions()
})
ipcMain.handle('groups:collapse', async (_e, id: string, collapsed: boolean) => {
  await store.updateGroup(id, { collapsed: !!collapsed })
  notifySessions()
})
ipcMain.handle('groups:delete', async (_e, id: string) => {
  await store.deleteGroup(id)
  notifySessions()
})

ipcMain.handle('sessions:reveal', async (_e, id: string) => {
  shell.showItemInFolder((await findSession(id)).transcriptPath)
})
ipcMain.handle('sessions:openInTerminal', async (_e, id: string) => {
  const s = await findSession(id)
  // One process per transcript: two writers corrupt it.
  if (ptys.has(id)) throw new Error('It is running here. Stop it first.')
  if (s.liveElsewhere) throw new Error(`It's already open in ${s.liveElsewhere.entrypoint}.`)
  const command = `cd ${shq(s.startCwd)} && claude --resume ${s.id}`
  const applescript = `tell application "Terminal"\n  activate\n  do script ${JSON.stringify(command)}\nend tell`
  await new Promise<void>((resolve, reject) =>
    execFile('osascript', ['-e', applescript], (err) => (err ? reject(new Error(err.message)) : resolve()))
  )
})

ipcMain.handle('artifacts:list', async () => {
  const ticketOf = new Map((await sessions()).map((s) => [s.id, s.tickets[0] ?? null]))
  return (await listArtifacts((id) => ticketOf.get(id) ?? null)).map((a) => ({ ...a, hidden: store.isArtifactHidden(a.url) }))
})
ipcMain.handle('artifacts:hide', async (_e, url: string, hidden: boolean) => {
  if (typeof url !== 'string' || !/^https:\/\/claude\.ai\/(code\/)?artifact\/[A-Za-z0-9_-]+$/.test(url)) throw new Error('not an artifact link')
  await store.setArtifactHidden(url, !!hidden)
})
ipcMain.handle('search:transcripts', (_e, query: unknown) =>
  typeof query === 'string' && query.trim().length >= 2 ? searchTranscripts(query.slice(0, 200)) : []
)
ipcMain.handle('context:get', (_e, ticket: string | null, prNumbers: unknown) => {
  const t = typeof ticket === 'string' && TICKET_RE.test(ticket) ? ticket : null
  const prs = Array.isArray(prNumbers) ? prNumbers.filter((n): n is number => Number.isInteger(n) && n > 0) : []
  return ticketContext(workspace(), t, prs)
})
ipcMain.handle('context:open', async (_e, path: string) => {
  if ((await openablePath(workspace(), String(path))) === null) throw new Error('Only ticket context folders and memory notes open from here')
  const err = await shell.openPath(String(path))
  if (err) throw new Error(err)
})
ipcMain.handle('pr:greptile', async (_e, url: string) => {
  await requestGreptileReview(String(url))
  notifySessions()
})
ipcMain.handle('worktrees:list', () => {
  const ws = workspace()
  return ws ? listWorktreesCached(ws) : []
})
ipcMain.handle('worktrees:remove', (_e, path: string, deleteBranch?: boolean) => removeWorktree(String(path), deleteBranch === true))
// The session view asks on every sessions change (often, mid-turn); a few
// seconds' reuse keeps that to a handful of local git calls.
const branchCache = new Map<string, { at: number; result: Promise<TicketBranch[]> }>()
ipcMain.handle('worktrees:forTicket', (_e, ticket: string, heads: unknown) => {
  const ws = workspace()
  if (!ws || typeof ticket !== 'string' || !TICKET_RE.test(ticket)) return []
  // PR branches only ever name refs to match against; anything odd is dropped.
  const prHeads = (Array.isArray(heads) ? heads : [])
    .filter((h) => typeof h?.repo === 'string' && typeof h?.branch === 'string' && /^[\w.-]+\/[\w.-]+$/.test(h.repo) && /^[\w.@/+-]{1,200}$/.test(h.branch))
    .slice(0, 20) as { repo: string; branch: string }[]
  const key = `${ws}|${ticket}|${prHeads.map((h) => `${h.repo}:${h.branch}`).join(',')}`
  const hit = branchCache.get(key)
  if (hit && Date.now() - hit.at < BRANCH_CACHE_MS) return hit.result
  const result = ticketBranches(ws, ticket, prHeads).catch(() => [])
  branchCache.set(key, { at: Date.now(), result })
  return result
})
const BRANCH_CACHE_MS = 3000
ipcMain.handle('worktrees:prune', (_e, repoPath: string) => pruneWorktrees(String(repoPath)))
ipcMain.handle('branches:list', async () => {
  const ws = workspace()
  if (!ws) return []
  const [list, ss] = await Promise.all([listBranches(ws), sessions()])
  // Its sessions: about its ticket, or the one that opened its PR.
  return list.map((b) => ({
    ...b,
    sessionIds: ss.filter((s) => (b.ticket && s.tickets[0] === b.ticket) || (b.pr && s.prs.some((p) => p.url === b.pr!.url))).map((s) => s.id)
  }))
})
ipcMain.handle('branches:remove', (_e, repoPath: string, branch: string) => removeBranch(String(repoPath), String(branch)))
ipcMain.handle('branches:remoteLeftovers', () => {
  const ws = workspace()
  return ws ? listRemoteLeftovers(ws) : []
})
ipcMain.handle('branches:deleteRemote', (_e, slug: string, branch: string) => deleteRemoteBranch(String(slug), String(branch)))

/**
 * Remembers the connected workspace (links, offline use) and detects tickets
 * by its team keys; re-reads sessions when those change.
 */
async function learnWorkspace(status: LinearStatus): Promise<LinearStatus> {
  if (status.connected) {
    await store.setLinearWorkspace(workspace(), status.workspace)
    if (setTicketKeys(status.workspace.teamKeys)) notifySessions()
  }
  return status
}

ipcMain.handle('linear:status', async () => learnWorkspace(await linearStatus()))
ipcMain.handle('linear:setKey', async (_e, key: string | null) => {
  invalidate()
  if (!key?.trim()) {
    await store.setLinearKey(workspace(), null)
    return { connected: false }
  }
  // Only keep a key Linear accepts.
  const status = await learnWorkspace(await linearStatus(key.trim()))
  if (status.connected) {
    await store.setLinearKey(workspace(), key.trim())
    void loadLinearRules()
      .then(installMenu)
      .catch(() => {})
  }
  return status
})
ipcMain.handle('linear:board', async () => {
  const [raw, ss] = await Promise.all([fetchBoard(), sessions()])
  refreshPrsLater(raw.issues.flatMap((i) => i.prs))
  const boardPrs = raw.issues.flatMap((i) => i.prs.map(withInfo))
  const ws = workspace()
  if (ws) refreshLocalSync(ws, boardPrs).then((changed) => changed && notifySessions())
  refreshDeploys(boardPrs).then((changed) => changed && notifySessions())
  // The board polls: moves made in Linear get their pins here too.
  void runAutoPins(sessions).then((changed) => changed && notifySessions())
  const auto = store.autoSince()
  return {
    ...buildBoard(raw, ss),
    automation: { start: !!auto.start, review: !!auto.review && !linearHandlesReview(), linear: linearOwnRules() }
  }
})
ipcMain.handle('linear:issue', async (_e, identifier: string) => {
  if (!TICKET_RE.test(identifier)) return null
  const issue = await fetchIssue(identifier)
  if (!issue) return null
  refreshPrsLater(issue.prs)
  return { ...issue, prs: issue.prs.map(withInfo) }
})
ipcMain.handle('linear:move', async (_e, identifier: string, column: Column) => {
  if (!COLUMNS.some((c) => c.id === column)) throw new Error(`unknown column ${column}`)
  const issue = (await fetchBoard()).issues.find((i) => i.identifier === identifier)
  if (!issue) throw new Error(`${identifier} is not on the board`)
  await moveIssue(issue, column)
  void runAutoPins(sessions, true).then((changed) => changed && notifySessions())
  const [raw, ss] = await Promise.all([fetchBoard(), sessions()])
  return buildBoard(raw, ss)
})
ipcMain.handle('sessions:defaultCwd', () => workspace() ?? '')

function settingsView(): Settings {
  const dir = claudeDir()
  return {
    workspace: workspace(),
    workspaceChosen: !!store.paths().workspace,
    claudeDir: dir,
    claudeDirIsDefault: dir === defaultClaudeDir(),
    claudeDirSessions: describeClaudeDir(dir).sessions,
    project: projectConfigStatus(),
    hideNerfguardWhenMissing: store.prefs().hideNerfguardWhenMissing,
    drawForScreenSharing: store.prefs().drawForScreenSharing,
    drawForScreenSharingActive: drawForScreenSharingAtLaunch
  }
}

// The project folder's .session-desk.json, re-read when it changes.
let stopConfigWatch: () => void = () => {}
async function reloadProjectConfig(): Promise<void> {
  stopConfigWatch()
  await loadProjectConfig(workspace())
  // Deploy tracking is per project: start over from its config.
  resetDeploys()
  stopConfigWatch = watchProjectConfig(workspace(), () => {
    resetDeploys()
    win?.webContents.send('settings:changed')
    notifySessions()
  })
}

// The scanner's file watchers follow the Claude folder.
let stopWatching: () => void = () => {}
function startWatching(): void {
  stopWatching()
  stopWatching = watchSessions(recheckSessions)
}

function pathsChanged(): void {
  startWatching()
  // Each project has its own Linear connection: drop what the last one taught us.
  resetLinear()
  resetLinearRules()
  setTicketKeys(store.linearWorkspace(workspace())?.teamKeys ?? [])
  installMenu()
  void loadLinearRules()
    .then(installMenu)
    .catch(() => {})
  void reloadProjectConfig().then(() => {
    win?.webContents.send('settings:changed')
    notifySessions()
  })
}

async function chooseProject(): Promise<boolean> {
  const r = await dialog.showOpenDialog(win!, {
    title: 'Choose a project folder',
    message: 'New sessions start here; its repos, worktrees and .session-desk.json are read from here.',
    defaultPath: workspace() ?? undefined,
    properties: ['openDirectory', 'createDirectory', 'showHiddenFiles']
  })
  if (r.canceled || !r.filePaths[0]) return false
  await openProject(r.filePaths[0])
  return true
}

async function openProject(path: string): Promise<void> {
  if (!(await fs.stat(path).catch(() => null))?.isDirectory()) {
    win?.webContents.send('notice', `${path} no longer exists`)
    return
  }
  await store.setPath('workspace', path)
  pathsChanged()
}
setProjectActions({ choose: () => void chooseProject(), open: (p) => void openProject(p) })

ipcMain.handle('project:createConfig', async () => {
  const ws = workspace()
  if (!ws) throw new Error('Choose a project folder first')
  // 'wx': never overwrite a file that appeared meanwhile.
  await fs.writeFile(join(ws, CONFIG_NAME), starterConfig(), { flag: 'wx' }).catch((e) => {
    if (e.code !== 'EEXIST') throw e
  })
  await reloadProjectConfig()
  return settingsView()
})
ipcMain.handle('project:openConfig', async () => {
  const file = projectConfigStatus()?.file
  if (file && (await fs.stat(file).catch(() => null))) await shell.openPath(file)
})

ipcMain.handle('settings:get', () => settingsView())
ipcMain.handle('settings:hideNerfguard', async (_e, hide: unknown) => {
  await store.setPref('hideNerfguardWhenMissing', hide === true)
  win?.webContents.send('settings:changed')
  return settingsView()
})
ipcMain.handle('settings:drawForScreenSharing', async (_e, on: unknown) => {
  await store.setPref('drawForScreenSharing', on === true)
  return settingsView()
})
ipcMain.handle('nerfguard:status', (_e, force: unknown) => nerfguardStatus(force === true))
const tool = new ToolTerminal(
  (data) => win?.webContents.send('tool:data', data),
  (code) => {
    forgetNerfguardStatus()
    win?.webContents.send('tool:exit', code)
  }
)
ipcMain.handle('nerfguard:run', async (_e, action: unknown, cols: unknown, rows: unknown) => {
  const size = (n: unknown, d: number) => (typeof n === 'number' && n > 0 && n < 1000 ? Math.floor(n) : d)
  // The installer is fixed here, never taken from the page; you confirmed it in the panel.
  if (action === 'install') return tool.start('/bin/bash', ['-c', NERFGUARD_INSTALL_COMMAND], size(cols, 100), size(rows, 30))
  // Only the listed commands, never arguments from the page.
  const args = typeof action === 'string' && Object.hasOwn(NERFGUARD_ACTIONS, action) ? NERFGUARD_ACTIONS[action as keyof typeof NERFGUARD_ACTIONS] : null
  if (!args) throw new Error(`unknown NerfGuard command ${String(action)}`)
  const bin = await findNerfguard()
  if (!bin) throw new Error('NerfGuard isn\u2019t installed')
  await tool.start(bin, args, size(cols, 100), size(rows, 30))
})
ipcMain.on('tool:write', (_e, data: unknown) => typeof data === 'string' && tool.write(data))
ipcMain.on('tool:resize', (_e, cols: unknown, rows: unknown) => typeof cols === 'number' && typeof rows === 'number' && tool.resize(cols, rows))
ipcMain.on('tool:stop', () => tool.stop())
const hookAction = (a: unknown) => {
  if (a !== 'install' && a !== 'uninstall') throw new Error('unknown action')
  return a
}
ipcMain.handle('hook:status', () => hookStatus())
ipcMain.handle('hook:preview', (_e, a: unknown) => hookPreview(hookAction(a)))
ipcMain.handle('hook:apply', (_e, a: unknown) => hookApply(hookAction(a)))
ipcMain.handle('settings:pick', async (_e, key: 'workspace' | 'claudeDir') => {
  if (key !== 'workspace' && key !== 'claudeDir') throw new Error('unknown setting')
  if (key === 'workspace') {
    await chooseProject()
    return settingsView()
  }
  const r = await dialog.showOpenDialog(win!, {
    title: 'Choose your Claude Code folder',
    message: 'Usually ~/.claude: holds projects/ (session transcripts) and sessions/.',
    defaultPath: claudeDir(),
    properties: ['openDirectory', 'createDirectory', 'showHiddenFiles']
  })
  if (r.canceled || !r.filePaths[0]) return settingsView()
  await store.setPath('claudeDir', r.filePaths[0])
  pathsChanged()
  return settingsView()
})
ipcMain.handle('settings:reset', async (_e, key: 'workspace' | 'claudeDir') => {
  if (key !== 'workspace' && key !== 'claudeDir') throw new Error('unknown setting')
  await store.setPath(key, null)
  pathsChanged()
  return settingsView()
})
ipcMain.handle('pty:start', async (_e, sent: PtyStartRequest) => {
  // The session's saved model/effort comes from here, never from the renderer.
  const chosen = store.sessionLaunch(sent.sessionId)
  const req: PtyStartRequest = {
    ...sent,
    launch: chosen ? { ...chosen, model: chosen.model && withDefaultContext(chosen.model, await defaultModel()) } : undefined
  }
  const prBranch = validPrBranch(req.prBranch)
  // An open-pr turn without a usable branch is dropped rather than sent half-filled.
  const kickoff = req.kickoff && KICKOFFS.includes(req.kickoff) && (req.kickoff !== 'open-pr' || prBranch) ? req.kickoff : undefined
  const forTicket = !!req.ticket && TICKET_RE.test(req.ticket)
  if (!forTicket || ptys.has(req.sessionId) || (req.resume && !kickoff)) return ptys.start({ ...req, kickoff: undefined })
  // A session started for a ticket is told about it and to work in worktrees.
  // Without Linear (not connected, or the lookup fails) it still gets the id.
  const issue = await fetchIssue(req.ticket!).catch(() => null)
  // The project's layout, around the project folder (a resumed session may have started elsewhere in it).
  const ws = workspace() ?? req.cwd
  const singleRepo = (await fs.stat(join(ws, '.git')).catch(() => null))?.isDirectory() ?? false
  const brief = ticketBrief(issue ?? { identifier: req.ticket!, title: '', url: '', branchName: '', description: '' }, ws, {
    layout: projectConfig().worktrees,
    singleRepo
  })
  return ptys.start({ ...req, kickoff }, brief, kickoff && kickoffPrompt(kickoff, req.ticket!, prBranch))
})
/** Types a kickoff turn into a session already open here and idle at its prompt. */
ipcMain.handle('pty:kickoff', async (_e, sessionId: string, ticket: string, kind: Kickoff, branch?: unknown) => {
  const prBranch = validPrBranch(branch)
  if (!ptys.has(sessionId) || !TICKET_RE.test(ticket) || !KICKOFFS.includes(kind) || (kind === 'open-pr' && !prBranch)) return false
  // Text and Enter in one write read as a paste: Claude Code strips the Enter
  // as an invisible character and waits for review. Enter on its own submits.
  ptys.write(sessionId, kickoffPrompt(kind, ticket, prBranch))
  await new Promise((r) => setTimeout(r, KICKOFF_ENTER_DELAY_MS))
  if (!ptys.has(sessionId)) return false
  ptys.write(sessionId, '\r')
  return true
})
/** Long enough for Claude Code to take the text as one paste before Enter arrives (250ms measured). */
const KICKOFF_ENTER_DELAY_MS = 250
ipcMain.handle('pty:kill', (_e, id: string) => ptys.kill(id))
ipcMain.handle('pty:stop', (_e, id: string) => ptys.stop(String(id)))
ipcMain.handle('session:setLaunch', async (_e, id: string, choice: { model?: unknown; effort?: unknown }) => {
  if (!UUID_RE.test(String(id))) throw new Error('not a session id')
  const next: { model?: string; effort?: string } = {}
  // Only what the catalog offers this account (or the built-in list), never an arbitrary flag value.
  const { models } = await readModelCatalog()
  if (choice?.model !== undefined) {
    if (!models.some((m) => m.id === choice.model)) throw new Error(`unknown model ${String(choice.model)}`)
    next.model = choice.model as string
  }
  if ((choice as { permissionMode?: unknown })?.permissionMode !== undefined) {
    const m = (choice as { permissionMode?: unknown }).permissionMode
    // Only bypass is chosen at launch; null clears it (back to the cycle).
    if (m !== 'bypassPermissions' && m !== null) throw new Error(`unknown launch mode ${String(m)}`)
    ;(next as { permissionMode?: 'bypassPermissions' }).permissionMode = m === null ? undefined : 'bypassPermissions'
  }
  if (choice?.effort !== undefined) {
    const levels = new Set([...EFFORT_CHOICES.map((e) => e.level as string), ...models.flatMap((m) => (m.efforts ?? []).map((e) => e.id))])
    if (typeof choice.effort !== 'string' || !levels.has(choice.effort) || !/^[a-z]+$/.test(choice.effort)) {
      throw new Error(`unknown effort ${String(choice.effort)}`)
    }
    next.effort = choice.effort
  }
  await store.setSessionLaunch(id, next)
  notifySessions()
})

// Editors that open a folder with `open -a`, if installed.
const EDITORS = ['Visual Studio Code', 'Cursor', 'Zed', 'Sublime Text', 'Nova']
const installedEditors = () =>
  Promise.all(EDITORS.map(async (n) => ((await fs.stat(`/Applications/${n}.app`).catch(() => null)) ? n : null))).then((l) =>
    l.filter((n): n is string => !!n)
  )
ipcMain.handle('folder:apps', () => installedEditors())
ipcMain.handle('models:catalog', () => readModelCatalog())
ipcMain.handle('usage:get', async (_e, id: string) => {
  if (!UUID_RE.test(String(id))) throw new Error('not a session id')
  const s = (await sessions()).find((x) => x.id === id)
  return readUsage(id, s?.contextTokens ?? null)
})
ipcMain.handle('pty:getMode', (_e, id: string) => ptys.mode(String(id)))
/** Shift+Tab until the mode shows, as in the terminal: session only, no settings change. Bypass needs a relaunch. */
ipcMain.handle('pty:setMode', (_e, id: string, mode: string) => {
  if (!MODE_CYCLE.includes(mode as PermissionMode)) throw new Error(`${mode} can't be switched to live`)
  return ptys.setMode(String(id), mode as PermissionMode)
})
/** Types /compact or /usage at an idle prompt (neither changes any setting, unlike /model). */
ipcMain.handle('pty:command', async (_e, id: string, command: string) => {
  if (!ptys.has(String(id)) || (command !== '/compact' && command !== '/usage')) return false
  ptys.write(id, command)
  await new Promise((r) => setTimeout(r, KICKOFF_ENTER_DELAY_MS))
  if (!ptys.has(id)) return false
  ptys.write(id, '\r')
  return true
})
/** The session's folder (or the project folder for a new chat): never a path from the renderer. */
ipcMain.handle('folder:open', async (_e, id: string | null, how: string) => {
  const dir = id ? (await findSession(String(id))).startCwd : workspace()
  if (!dir || !(await fs.stat(dir).catch(() => null))?.isDirectory()) throw new Error('That folder no longer exists')
  if (how === 'finder') {
    const err = await shell.openPath(dir)
    if (err) throw new Error(err)
    return
  }
  const app = how === 'terminal' ? 'Terminal' : (await installedEditors()).find((n) => n === how)
  if (!app) throw new Error(`unknown app ${how}`)
  await new Promise<void>((resolve, reject) => execFile('open', ['-a', app, dir], (err) => (err ? reject(new Error(err.message)) : resolve())))
})
ipcMain.on('pty:write', (_e, id: string, data: string) => ptys.write(id, data))
ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => ptys.resize(id, cols, rows))
ipcMain.on('open-external', (_e, url: string) => openExternal(url))
ipcMain.on('ui:active', (_e, id: string | null) => {
  activeSessionId = typeof id === 'string' && UUID_RE.test(id) ? id : null
})
ipcMain.on('ui:visibleTerminal', (_e, id: string | null) => {
  visibleTerminalId = typeof id === 'string' && UUID_RE.test(id) ? id : null
})

app.on('second-instance', () => showWindow())

// Tickets are detected by the last-known workspace's team keys until Linear answers.
// Linear is per project; the connection made before that becomes the current project's.
void store.adoptLegacyLinear(workspace())
setTicketKeys(store.linearWorkspace(workspace())?.teamKeys ?? [])

// What the last run read of each transcript: the first scan then reads only
// what was appended since, instead of every transcript in full.
const scanCacheFile = () => join(app.getPath('userData'), 'scan-cache.json')
try {
  restoreScanCache(readFileSync(scanCacheFile(), 'utf8'))
} catch {
  // First run, or unreadable: scan from scratch.
}
function saveScanCache(): void {
  try {
    writeFileSync(scanCacheFile(), serializeScanCache())
  } catch {
    // Only a speed-up; the next launch scans in full.
  }
}

app.whenReady().then(() => {
  // About shows "Version 0.1.0", from package.json, without a separate build number.
  app.setAboutPanelOptions({ applicationVersion: app.getVersion(), version: '' })
  installMenu()
  createWindow()
  // Learn the team's own Linear rules, so the menu can say which of ours they already cover.
  void loadLinearRules()
    .then(installMenu)
    .catch(() => {})
  startWatching()
  void installStatusLine().catch(() => {})
  void reloadProjectConfig().then(() => win?.webContents.send('settings:changed'))
  // A Dock launch doesn't inherit CLAUDE_CONFIG_DIR; ask the login shell, then
  // re-point the watchers if it names another folder.
  void loadShellClaudeDir().then(pathsChanged)
  const stopActivity = watchActivity(recheckSessions)
  // A process that dies writes nothing, so no file event reports it. Re-check
  // liveness now and then; the scanner's mtime cache keeps this cheap.
  const liveness = setInterval(recheckSessions, 10_000)
  // Saved now and then too, so a crash or force-quit still leaves a recent one.
  const saveCache = setInterval(saveScanCache, 5 * 60_000)
  setTimeout(saveScanCache, 30_000).unref()
  app.on('before-quit', () => {
    clearInterval(saveCache)
    saveScanCache()
    stopWatching()
    stopActivity.then((stop) => stop())
    clearInterval(liveness)
    stopConfigWatch()
    ptys.killAll()
    tool.kill()
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Electron ignores SIGTERM/SIGINT by default, which would orphan every claude
// process we started (dev restarts, logout, `kill`). Stop them, then exit:
// app.quit() from a signal closed the window but left the process running.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    saveScanCache()
    ptys.killAll()
    tool.kill()
    app.exit(0)
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
