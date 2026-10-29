export interface PrLink {
  repo: string
  number: number
  url: string
  /** Filled in from GitHub once fetched; absent until then or if `gh` is unavailable. */
  info?: PrInfo
  /** The local checkout of an open PR's branch, compared with the PR on GitHub. */
  local?: LocalSync
  /** Where a recently merged PR is live. */
  deploy?: DeployInfo
}

export interface LocalSync {
  /** Worktree (or main checkout) on the PR's branch, relative to the workspace. */
  worktree: string
  /** Local commits not on the PR: work that was never pushed. Null when the PR head isn't fetched locally. */
  ahead: number | null
  /** PR commits not in the worktree. Null as above. */
  behind: number | null
}

export interface PrInfo {
  title: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  draft: boolean
  headRef: string
  /** Ticket IDs its branch, title or description names (upper-case). */
  mentions?: string[]
  /** Checks, reviews and Greptile; fetched for open PRs only. */
  status?: PrStatus
  /** Merged PRs: the commit that landed on the base branch, and when. */
  mergeOid?: string
  mergedAt?: string
}

/**
 * Whether a merged PR is live in an environment. live/pending: the release tag
 * the environment pins does / doesn't contain the merge commit. untracked:
 * nothing reliable to read (a manual deploy, say).
 */
export type DeployState =
  | { state: 'live' | 'pending'; tag: string }
  | { state: 'untracked'; why?: string }
  | { state: 'unknown'; tag?: string }

export interface PrStatus {
  headOid: string
  /** When it became reviewable: opened as ready, or marked ready after starting as a draft. */
  readyAt: string
  checks: 'passing' | 'failing' | 'running' | 'none'
  review: 'approved' | 'changes_requested' | 'review_required' | null
  /** Review threads not marked resolved (an unanswered one reads as open in GitHub). */
  unresolvedThreads: number
  greptile: GreptileStatus
}

/**
 * Greptile's auto-review is off on these repos, so it reviews only when asked
 * (`@greptileai review`), and its summary goes stale as commits land.
 * none: Greptile is on the repo (it has posted, e.g. a status notice) but
 * hasn't reviewed. requested: asked after its last summary.
 * current: last reviewed commit is the PR head. behind: commits since.
 */
export type GreptileStatus =
  /** Greptile has never posted on the PR: it isn't on this repo, so say nothing. */
  | { state: 'absent' }
  | { state: 'none' }
  | { state: 'requested'; at: string }
  | { state: 'current'; confidence: number | null }
  | { state: 'behind'; behindBy: number | null; confidence: number | null }

export interface SessionSummary {
  id: string
  /** The session's .jsonl under ~/.claude/projects. */
  transcriptPath: string
  /** Directory the session was started in; `claude --resume` must run from here. */
  startCwd: string
  title: string
  /** Where the title came from, so the UI can show auto-titles more quietly. */
  titleSource: 'custom' | 'ai' | 'prompt' | 'id'
  /** Ticket identifiers (e.g. ENG-123), strongest link first. */
  tickets: string[]
  /** How tickets[0] was decided: set by hand, from a PR's branch, or inferred from the transcript. */
  ticketSource: 'manual' | 'pr' | 'transcript' | null
  prs: PrLink[]
  entrypoint: string
  lastActivity: number
  /** Set when another Claude process (CLI or desktop app) currently has this session open. */
  liveElsewhere: { pid: number; entrypoint: string } | null
  /** Hidden from the main list (app-side only; Claude Code is unaware). */
  archived: boolean
  /** The sidebar group the session is filed under, or null for its project folder. */
  groupId: string | null
  /** Shown in the Pinned section. Pinning keeps the group, as in the desktop app. */
  pinned: boolean
  /**
   * What Claude is doing, from the Claude Code hooks: working on a turn, or
   * waiting for you (turn finished, question asked, permission needed). Null
   * when no process has the session open or the hooks aren't installed.
   */
  activity: { state: 'working' | 'waiting'; at: number; event: string } | null
  /**
   * Plan mode in this session: never used, a plan shown but not approved
   * (rejected, or the session ended at the prompt), or a plan approved.
   */
  plan: 'none' | 'proposed' | 'approved'
  /** It has edited files or opened a PR: the work has started. */
  worked: boolean
  /** When its last turn ended (ms), from the transcript; 0 if none recorded. */
  turnEndedAt: number
  /** The model and effort of Claude's latest reply (e.g. claude-opus-5-5, high); null before the first. */
  model: string | null
  effort: string | null
  /** Tokens in context at Claude's latest reply (input plus cache), from the transcript; null before the first. */
  contextTokens: number | null
  /** Model and effort chosen for this session in the app (applied whenever the app starts it); null if none. */
  launch: SessionLaunch | null
}

/** A session's own model and effort, passed as --model/--effort, so your defaults never change. */
export interface SessionLaunch {
  /** A model ID from MODEL_CHOICES, e.g. claude-opus-5-5 (the 1M context is added at launch when your default uses it). */
  model?: string
  /** Only bypassPermissions is chosen at launch; the other modes switch live with Shift+Tab. */
  permissionMode?: 'bypassPermissions'
  effort?: string
  /** When it was chosen (ms): replies after this reflect it. */
  at: number
}

/** Claude Code's permission modes (`--permission-mode`); the first four cycle with Shift+Tab. */
export type PermissionMode = 'auto' | 'manual' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'dontAsk'

export interface UsageLimit {
  usedPercent: number
  /** When it resets (ms); null if not given. */
  resetsAt: number | null
}

/**
 * A session's context use and the plan's usage limits. status-line: exact,
 * from the status line of a session this app started; transcript: just the
 * tokens from its last reply (window size unknown); none: nothing yet.
 */
export interface SessionUsage {
  source: 'status-line' | 'transcript' | 'none'
  context: { used: number; size: number | null; autoCompactAt: number | null } | null
  /** Account-wide: the 5-hour session limit and the weekly limit for all models. */
  limits: { fiveHour: UsageLimit | null; sevenDay: UsageLimit | null; at: number } | null
  at: number | null
}

/** A model as Claude Code's catalog describes it (see src/main/modelCatalog.ts). */
export interface CatalogModel {
  id: string
  name: string
  /** main: the short list; overflow: under More models. */
  section: 'main' | 'overflow'
  /** Its effort levels, nearest the top first; null when it has none. */
  efforts: { id: string; name: string; badge?: string }[] | null
  /** A warning to show with it (e.g. usage). */
  notice?: string
  /** The oldest Claude Code that runs it. */
  minVersion?: string
}

export interface ModelCatalog {
  /** claude-code: Claude Code's own cached catalog; built-in: this app's fallback list. */
  source: 'claude-code' | 'built-in'
  fetchedAt: number | null
  models: CatalogModel[]
}

/**
 * The fallback list (used when Claude Code's catalog can't be read), as the Claude desktop app lists them: current ones
 * first, older ones under More models. Every ID was checked against the CLI
 * (`claude -p --model <id>`) on 2.1.29x.
 */
export const MODEL_CHOICES = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' }
] as const
export const MORE_MODEL_CHOICES = [
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-fable-5', label: 'Fable 5' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' }
] as const
export const EFFORT_CHOICES = [
  { level: 'low', label: 'Low' },
  { level: 'medium', label: 'Medium' },
  { level: 'high', label: 'High' },
  { level: 'xhigh', label: 'Extra high' },
  { level: 'max', label: 'Max' }
] as const

/** A user-made sidebar section, like a custom group in the Claude desktop app. */
export interface SessionGroup {
  id: string
  name: string
  collapsed: boolean
}

/**
 * How a rename was applied. `applied`: Claude Code recorded the new title.
 * `prefilled`: the session is running here, so `/rename …` was typed into its
 * prompt for you to send with Enter.
 */
export type RenameResult = 'applied' | 'prefilled'

export interface PtyStartRequest {
  /** Terminal key: an existing session id to resume, or a fresh uuid for a new session. */
  sessionId: string
  resume: boolean
  cwd: string
  cols: number
  rows: number
  /** Ticket a new session was started for; the main process briefs Claude on it. */
  ticket?: string
  /** Start (or resume) the ticket's session with this opening turn; needs `ticket`. */
  kickoff?: Kickoff
  /** For an open-pr kickoff. */
  prBranch?: PrBranch
  /** Set by the main process from the session's saved choice; ignored from the renderer. */
  launch?: SessionLaunch
}

/**
 * The opening turn when a card moves into In Progress. plan: a first plan.
 * replan: plan in a session that already talked but never planned or edited.
 * represent: show an unapproved plan again. continue: pick the work back up.
 * open-pr: open a PR for a branch, written as Claude normally writes them.
 * The plan kinds run in Claude Code's plan mode, which can't edit until you approve.
 */
export type Kickoff = 'plan' | 'replan' | 'represent' | 'continue' | 'open-pr'

/** The branch an open-pr turn is about. */
export type PrBranch = Pick<TicketBranch, 'repo' | 'branch' | 'label'>

/**
 * safe: nothing would be lost (PR merged or closed, or no commits of its own).
 * active: everything is pushed, but it's still in use upstream (open PR, or a pushed branch without one).
 * blocked: removing it would lose work, or something is running in it.
 * missing: the folder is gone; git just still lists it.
 */
export type WorktreeVerdict = 'safe' | 'active' | 'blocked' | 'missing'

/**
 * A local branch, for the Branches view. safe: nothing would be lost (its PR
 * is merged or closed and has every commit, or it's all in the default
 * branch). active: still in use (an open PR, or pushed with no PR yet).
 * blocked: deleting it would lose work, or it's checked out. protected: the
 * default branch.
 */
export type BranchVerdict = 'safe' | 'active' | 'blocked' | 'protected'

/**
 * A branch of one of your merged PRs that's still on GitHub. eligible: it
 * can go without losing anything (it still points at the PR's final commit,
 * no open PR builds on it, it isn't the default or protected); otherwise
 * `reason` says why not. GitHub's Restore branch button on the PR brings it back.
 */
export interface RemoteLeftover {
  repo: string
  slug: string
  branch: string
  sha: string
  pr: { number: number; url: string; mergedAt: string }
  /** You still have it on this Mac too. */
  local: boolean
  eligible: boolean
  reason: string
}

export interface BranchInfo {
  /** Repo folder name, as in the Worktrees view. */
  repo: string
  repoPath: string
  branch: string
  /** Its tip; removal refuses if it has moved since. */
  sha: string
  ticket: string | null
  /** The branch on origin it tracks, without "origin/"; null if none. */
  upstream: string | null
  /** It tracked a branch that's been deleted on GitHub. */
  upstreamGone: boolean
  /** The worktree (or main checkout) it's checked out in. */
  checkedOutAt: string | null
  pr: { number: number; state: 'OPEN' | 'MERGED' | 'CLOSED'; draft: boolean; url: string } | null
  /** Commits that exist only here: not in its PR, its upstream, or the default branch. Null when that can't be told. */
  unpushed: number | null
  lastCommitAt: number
  /** Sessions about its ticket, or that opened its PR. */
  sessionIds: string[]
  verdict: BranchVerdict
  reason: string
}

/** A checkout whose branch (or worktree folder) names the ticket: where its work is happening. */
export interface TicketBranch {
  /** Repo folder name under the workspace, e.g. api. */
  repo: string
  branch: string
  /** The checkout, relative to the workspace when inside it. */
  label: string
  /** owner/name on GitHub, when origin is there. */
  slug: string | null
  /** The repo's default branch, e.g. main. */
  defaultBranch: string
  /** origin has its upstream (or a branch of the same name). */
  pushed: boolean
  /** The branch on origin it tracks, when that's named differently (e.g. a PR taken over under a local name). */
  remoteBranch: string | null
  /** Local commits origin doesn't have yet (all of `ahead` when never pushed); null if it couldn't be told. */
  unpushed: number | null
  /** Commits on the branch that the default branch doesn't have. */
  ahead: number | null
  /** Uncommitted and untracked entries. */
  changes: number
}

export interface WorktreeInfo {
  /** Repo folder name under the workspace, e.g. api. */
  repo: string
  repoPath: string
  path: string
  /** Path relative to the workspace when inside it. */
  label: string
  /** The commit checked out when it was listed. */
  head: string
  branch: string | null
  ticket: string | null
  missing: boolean
  locked: boolean
  /** Command name of a process whose working directory is inside it. */
  inUseBy: string | null
  /** Uncommitted and untracked (not ignored) entries. */
  changes: number
  /** Ignored files that aren't regenerable build output (.env, local settings); removal deletes them. */
  notableIgnored: string[]
  /** Local commits not in the PR / remote branch / default branch; null when it couldn't be told. */
  unpushed: number | null
  /** What `unpushed` was counted against. */
  pushState: 'pr' | 'branch' | 'never'
  pr: { number: number; state: 'OPEN' | 'MERGED' | 'CLOSED'; draft: boolean; url: string } | null
  lastCommitAt: number
  /** When the worktree was added (its .git file's birth time). */
  createdAt: number
  verdict: WorktreeVerdict
  reason: string
}

/** What else exists about a ticket: its evidence folders and Claude Code memory notes. */
export interface TicketContext {
  /** evidence/<TICKET> (any case) and evidence/PR-<n> for the session's PRs. */
  evidence: { path: string; label: string; files: number; modifiedAt: number }[]
  /** Memory notes mentioning the ticket, ones named for it first. */
  notes: { path: string; name: string; description: string; project: string; mentions: number }[]
}

/** A session whose conversation matched a transcript search. */
export interface SearchHit {
  sessionId: string
  /** Messages containing every query word. */
  matches: number
  lastMatchAt: number
  /** Up to three matching excerpts, newest first. */
  snippets: { role: 'you' | 'claude'; text: string; at: number }[]
}

/** A claude.ai artifact a session published or opened. */
export interface ArtifactRecord {
  url: string
  title: string
  /** The one-line description given when it was (last) published. */
  description: string
  /** False when sessions only opened it. */
  published: boolean
  firstAt: number
  lastAt: number
  sessions: { id: string; kind: 'publish' | 'open' }[]
  /** Tickets named in it, then its sessions' tickets. */
  tickets: string[]
  /** Removed from the list by the user; still on claude.ai. */
  hidden: boolean
}

/**
 * Per-project settings from `.session-desk.json` in the project folder, so
 * the file can be committed and shared. Everything is optional.
 */
export interface ProjectConfig {
  /** Where a ticket's worktree goes, relative to the project folder. Default `{repo}-wt/{ticket}`. */
  worktrees: string
  /** Folder of per-ticket notes and evidence (`<folder>/<TICKET>`); null for none. Default `evidence`. */
  contextFolder: string | null
  /** Deploy environments in order, the first being production. Default: prod and staging. */
  environments: { id: string; label: string }[]
  /** owner/repo -> its services and how to find what each environment runs. */
  deploy: Record<string, { services: DeployService[] }>
}

/**
 * Something deployed on its own. A repo that ships as one is a single service
 * with no name and no paths; a monorepo lists its services, each with the
 * paths it's built from, so a PR counts only for the services it touched.
 */
export interface DeployService {
  name: string | null
  /** Globs (`**`, `*`, `?`); a pattern without any is a folder prefix. Null: the whole repo. */
  paths: string[] | null
  /** Environment id -> how to find what it runs. */
  envs: Record<string, DeploySource>
}

/**
 * Where a merged PR is live, per service it touched: every environment in the
 * project's order, the first being production. Empty when nothing is tracked.
 */
export type DeployInfo = { service: string | null; envs: { id: string; label: string; state: DeployState }[] }[]

/**
 * How to find what an environment runs. pin: a GitOps file pins a release tag
 * (an image entry in a kustomization); branch: it deploys a branch; githubDeployment:
 * GitHub's Deployments API for that environment; latestTag: the newest tag matching a pattern;
 * workflowRun: the newest successful run of a GitHub Actions workflow (optionally on a branch);
 * untracked: nothing reliable to read (the reason is shown, e.g. "deployed by hand").
 */
export type DeploySource =
  | { pin: { repo: string; path: string; image: string } }
  | { branch: string }
  | { githubDeployment: string }
  | { latestTag: string }
  | { workflowRun: { workflow: string; branch?: string } }
  | { untracked: string }

/** What the app made of the project folder's config file. */
export interface ProjectConfigStatus {
  /** The file's path, whether or not it exists. */
  file: string
  state: 'none' | 'loaded' | 'invalid'
  /** Why the file was rejected (the app then uses defaults). */
  error?: string
  /** One line per setting, for Settings. */
  summary: string[]
}

export interface Settings {
  /** Projects folder; null until chosen (first run for a new user). */
  workspace: string | null
  /** Chosen in Settings, rather than found automatically. */
  workspaceChosen: boolean
  claudeDir: string
  /** True when it's the default (~/.claude or the shell's CLAUDE_CONFIG_DIR). */
  claudeDirIsDefault: boolean
  /** Session transcripts found there; 0 suggests the wrong folder. */
  claudeDirSessions: number
  /** The project folder's .session-desk.json; null without a project folder. */
  project: ProjectConfigStatus | null
  /** Hide the NerfGuard button while NerfGuard isn't installed (shown by default). */
  hideNerfguardWhenMissing: boolean
  /** Saved choice: draw on Chromium's own clock, for an account used over Screen Sharing. */
  drawForScreenSharing: boolean
  /** What this run started with; differs from the choice until a restart. */
  drawForScreenSharingActive: boolean
}

/** NerfGuard's own installer, as nerfguard.com gives it; it then runs setup (`nerfguard enable`) in the same terminal. */
export const NERFGUARD_INSTALL_COMMAND = 'curl -fsSL https://nerfguard.com/install.sh | bash'

/** NerfGuard commands the app runs in its terminal panel. */
export type NerfguardAction = 'install' | 'enable' | 'disable' | 'login' | 'logout' | 'dash' | 'logs'

/** NerfGuard (nerfguard.com), as `nerfguard status` reports it. */
export interface NerfguardStatus {
  installed: boolean
  version: string | null
  /** Claude Code is routed through its gateway: ANTHROPIC_BASE_URL is set in Claude's settings. */
  enabled: boolean
  baseUrl: string | null
  /** Whether the local gateway answers; null when unknown. */
  gateway: 'running' | 'down' | null
  signIn: 'signed-in' | 'expired' | 'signed-out' | 'unknown'
  email: string | null
  /** Why the status couldn't be read, when it's installed. */
  error?: string
  checkedAt: number
}

/**
 * The Claude Code status hook for this user. outdated: entries are in place
 * but ~/.session-desk/hook.sh differs from the app's copy.
 */
export interface HookStatus {
  settingsPath: string
  state: 'installed' | 'outdated' | 'partial' | 'missing'
}

export type Column = 'todo' | 'in_progress' | 'waiting' | 'in_review' | 'done'

export const COLUMNS: { id: Column; label: string }[] = [
  { id: 'todo', label: 'To Do' },
  { id: 'in_progress', label: 'In Progress' },
  { id: 'waiting', label: 'Waiting Response' },
  { id: 'in_review', label: 'In Review' },
  { id: 'done', label: 'Done' }
]

export interface LinearIssue {
  id: string
  identifier: string
  title: string
  url: string
  priorityLabel: string
  /** The git branch Linear suggests for the issue, e.g. me/eng-123. */
  branchName: string
  /** Markdown; may be empty. */
  description: string
  state: { id: string; name: string; type: string; color: string }
  /** PRs Linear's GitHub integration attached to the issue. */
  prs: PrLink[]
}

/** A board card's PRs, to show and mark in a session that is about another ticket. */
export interface PrFocus {
  ticket: string
  prUrls: string[]
}

export interface BoardCard {
  issue: LinearIssue
  column: Column
  /** Sessions whose primary ticket is this issue, most recent first. */
  sessionIds: string[]
  /**
   * Sessions about another ticket that opened one of this card's PRs, most
   * recent first: where a ticket without a session of its own was worked on.
   */
  prSessionIds: string[]
  /** The ticket's own PRs: Linear-attached ones that name it, plus linked sessions' PRs on a branch naming it. */
  prs: PrLink[]
  /**
   * Attached in Linear but naming another ticket, e.g. the PR that caused a bug:
   * context, not this ticket's work, so no state chip and no automatic moves.
   */
  relatedPrs: PrLink[]
}

export interface Board {
  cycle: { number: number; endsAt: string } | null
  /** None of my teams has an active cycle, so the cards are my assigned issues instead. */
  noCycles?: boolean
  cards: BoardCard[]
  /** Automatic moves: which of the app's rules are on, and Linear's own GitHub rules for the team. */
  automation?: { start: boolean; review: boolean; linear: { event: string; state: string }[] }
}

/** The connected Linear workspace: its URL key (linear.app/<key>) and every team's ticket prefix. */
export interface LinearWorkspace {
  urlKey: string
  teamKeys: string[]
}

/** `workspace` is the last one seen, kept for offline use and for links while disconnected. */
export type LinearStatus =
  | { connected: true; viewer: string; workspace: LinearWorkspace }
  | { connected: false; error?: string; workspace?: LinearWorkspace }

export interface DeskApi {
  listSessions(): Promise<SessionSummary[]>
  defaultCwd(): Promise<string>
  /** The file's path on disk, for a file dropped from Finder; '' when it has none (e.g. dragged from a web page). */
  pathForFile(file: File): string
  /** Benchmark instrumentation is on (SESSION_DESK_BENCH=1); see bench/. */
  bench: boolean
  /** Starts (or re-attaches to) a terminal; resolves with output to replay when re-attaching. */
  ptyStart(req: PtyStartRequest): Promise<string>
  ptyWrite(sessionId: string, data: string): void
  ptyResize(sessionId: string, cols: number, rows: number): void
  ptyKill(sessionId: string): Promise<void>
  /** What a running or recently exited session's terminal shows, to redraw it; starts nothing. */
  ptyReplay(sessionId: string): Promise<string>
  /**
   * Checkouts working on a ticket (local git only): a branch or folder naming
   * it, or a checkout of one of its PRs (`prHeads`: their repo and branch).
   */
  ticketBranches(ticket: string, prHeads?: { repo: string; branch: string }[]): Promise<TicketBranch[]>
  /** Saves a model and/or effort for this session only (applied the next time it starts). */
  setSessionLaunch(sessionId: string, choice: { model?: string; effort?: string; permissionMode?: 'bypassPermissions' | null }): Promise<void>
  /** Stops a session's process and resolves once it has exited. */
  ptyStop(sessionId: string): Promise<void>
  /** Opens the session's folder (or the project folder for a new chat) in Finder, Terminal or an editor. */
  openFolder(sessionId: string | null, how: 'finder' | 'terminal' | string): Promise<void>
  /** The models (and their efforts) Claude Code offers this account. */
  modelCatalog(): Promise<ModelCatalog>
  /** Every local branch of every repo in the project, with its PR, sessions and a verdict. */
  listBranches(): Promise<BranchInfo[]>
  /** Deletes a listed local branch after re-checking it; resolves with its last commit, for restoring. */
  removeBranch(repoPath: string, branch: string): Promise<string>
  /** Branches of your merged PRs still on GitHub, per repo in the project, each with whether deleting it loses nothing. */
  listRemoteLeftovers(): Promise<RemoteLeftover[]>
  /** Deletes a listed branch on GitHub after re-checking it; resolves with the commit it pointed at. */
  deleteRemoteBranch(slug: string, branch: string): Promise<string>
  /** The session's context window use and the plan's usage limits. */
  sessionUsage(sessionId: string): Promise<SessionUsage>
  /** The session's permission mode as its terminal shows it; null until it has drawn one. */
  ptyMode(sessionId: string): Promise<PermissionMode | null>
  /** Switches mode live (Shift+Tab until the terminal shows it); resolves with the mode reached. */
  ptySetMode(sessionId: string, mode: PermissionMode): Promise<PermissionMode | null>
  /** Fires when a session's terminal shows a different mode (Shift+Tab pressed there too). */
  onPtyMode(cb: (sessionId: string, mode: PermissionMode) => void): () => void
  /** Types /compact or /usage into a session open here and idle at its prompt. */
  sessionCommand(sessionId: string, command: '/compact' | '/usage'): Promise<boolean>
  /** Code editors installed in /Applications that can open a folder. */
  folderApps(): Promise<string[]>
  /** Sends a kickoff turn to a session open here and idle at its prompt; false if it isn't open. */
  ptyKickoff(sessionId: string, ticket: string, kind: Kickoff, prBranch?: PrBranch): Promise<boolean>
  onPtyData(cb: (sessionId: string, data: string) => void): () => void
  onPtyExit(cb: (sessionId: string, code: number) => void): () => void
  onSessionsChanged(cb: () => void): () => void
  /** Pin a session to a ticket, overriding detection; null returns it to detection. */
  linkSession(sessionId: string, ticket: string | null): Promise<void>
  renameSession(sessionId: string, name: string): Promise<RenameResult>
  archiveSession(sessionId: string, archived: boolean): Promise<void>
  revealTranscript(sessionId: string): Promise<void>
  /** Moves the session's transcript and its per-session Claude Code files to the macOS Trash. */
  deleteSession(sessionId: string): Promise<void>
  /** Files a session under a group; null returns it to the main Sessions list. */
  moveSession(sessionId: string, groupId: string | null): Promise<void>

  listGroups(): Promise<SessionGroup[]>
  createGroup(name: string): Promise<SessionGroup>
  renameGroup(groupId: string, name: string): Promise<void>
  /** Removes the group; its sessions return to the main list (nothing is deleted). */
  deleteGroup(groupId: string): Promise<void>
  setGroupCollapsed(groupId: string, collapsed: boolean): Promise<void>
  pinSession(sessionId: string, pinned: boolean): Promise<void>
  /** Project-folder sections (keyed by path) the user has collapsed. */
  listCollapsedProjects(): Promise<string[]>
  setProjectCollapsed(path: string, collapsed: boolean): Promise<void>
  /** Resumes the session in a new Terminal.app window. */
  openInTerminal(sessionId: string): Promise<void>

  linearStatus(): Promise<LinearStatus>
  /** Saves (encrypted via the macOS Keychain) and verifies a Linear personal API key; null forgets it. */
  linearSetKey(key: string | null): Promise<LinearStatus>
  getBoard(): Promise<Board>
  getIssue(identifier: string): Promise<LinearIssue | null>
  ticketContext(ticket: string | null, prNumbers: number[]): Promise<TicketContext>
  listArtifacts(): Promise<ArtifactRecord[]>
  /** Removes an artifact from the list (or restores it); doesn't touch claude.ai. */
  setArtifactHidden(url: string, hidden: boolean): Promise<void>
  /** Searches your prompts and Claude's replies across every session (not tool output). */
  searchTranscripts(query: string): Promise<SearchHit[]>
  /** Opens an evidence folder in Finder or a memory note in the default editor; nothing else. */
  openContextPath(path: string): Promise<void>
  /** Posts `@greptileai review` on an open PR. */
  requestGreptileReview(prUrl: string): Promise<void>
  moveCard(identifier: string, column: Column): Promise<Board>

  openExternal(url: string): void
  /** Every extra worktree of every repo in the workspace; takes several seconds. */
  listWorktrees(): Promise<WorktreeInfo[]>
  /** Removes a worktree from the last listing (keeps its branch). */
  /** Removes a listed worktree; with deleteBranch, also its branch when that loses nothing (its PR merged or closed). */
  removeWorktree(path: string, deleteBranch?: boolean): Promise<{ branchDeleted: boolean }>
  /** Clears stale entries for a repo's missing worktrees. */
  pruneWorktrees(repoPath: string): Promise<void>
  /** Tells the main process which session is on screen, so it isn't notified about it. */
  setActiveSession(sessionId: string | null): void
  /** The terminal on screen, if any: its output is delivered without batching. */
  setVisibleTerminal(sessionId: string | null): void
  getSettings(): Promise<Settings>
  hookStatus(): Promise<HookStatus>
  /** The exact settings.json change (unified diff); empty when nothing would change. */
  hookPreview(action: 'install' | 'uninstall'): Promise<string>
  hookApply(action: 'install' | 'uninstall'): Promise<HookStatus>
  /** Opens a folder picker for a setting; resolves with the settings after (unchanged if cancelled). */
  pickFolder(key: 'workspace' | 'claudeDir'): Promise<Settings>
  resetFolder(key: 'workspace' | 'claudeDir'): Promise<Settings>
  onSettingsChanged(cb: () => void): () => void
  setHideNerfguard(hide: boolean): Promise<Settings>
  /** Takes effect at the next launch. */
  setDrawForScreenSharing(on: boolean): Promise<Settings>
  /** Reused for a minute unless `force`. */
  nerfguardStatus(force?: boolean): Promise<NerfguardStatus>
  /** Runs a NerfGuard command in the panel's terminal; one at a time. */
  nerfguardRun(action: NerfguardAction, cols: number, rows: number): Promise<void>
  toolWrite(data: string): void
  toolResize(cols: number, rows: number): void
  /** Ctrl-C, then kills it if it doesn't stop. */
  toolStop(): void
  onToolData(cb: (data: string) => void): () => void
  onToolExit(cb: (code: number) => void): () => void
  /** Writes a starter .session-desk.json in the project folder (never overwrites). */
  createProjectConfig(): Promise<Settings>
  /** Opens the project's .session-desk.json in the default editor. */
  openProjectConfig(): Promise<void>
  /** The app menu's Settings… item. */
  onOpenSettings(cb: () => void): () => void
  /** A message from the main process for the in-app toast (e.g. an automatic Linear move). */
  onNotice(cb: (text: string) => void): () => void
  /** A notification was clicked: show this session. */
  onNavigateToSession(cb: (sessionId: string) => void): () => void
}
