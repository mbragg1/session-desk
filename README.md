# Session Desk

Desktop app that groups Claude Code sessions with their Linear tickets and PRs, and runs the real `claude` CLI for each one in an embedded terminal.

## Run

```bash
npm install
npm run dev
```

If `npm run dev` fails with `Electron uninstall`, the Electron binary didn't download: run `node node_modules/electron/install.js`.

### Tests

```bash
npm test
```

About 150 tests in a few seconds, no network and no access to your real `~/.claude` or settings: the scanner reads fixture transcripts, the store and hook installer use temp folders, and the worktree tests build real git repos with a local bare remote. Covered: ticket linking and its rule order, board columns and Waiting Response, the Greptile parser, worktree verdicts and removal guards, the status hook's event mapping and silence, and the installer's idempotence and clean uninstall.

### Install as an app

```bash
npm run install-app
```

Builds `Session Desk.app` (Apple Silicon, ad-hoc signed; no developer certificate needed to run it on this Mac) and copies it to `~/Applications`, removing an older copy of yours from `/Applications` (another user's copy there is left alone). Quit the installed copy first; the script refuses to replace a running app. The menu bar's Session Desk menu has **Open at Login** (installed app only) and the notification settings.

**Signing.** `install-app` re-signs the build with a stable identity when the keychain has one: `SESSION_DESK_SIGNING_IDENTITY` if set, else any "Developer ID Application" identity, else any "Apple Development" identity (the free certificate Xcode creates when you sign in with your Apple ID), else a self-signed "Session Desk Local Signing" certificate. A stable identity keeps the app's designated requirement the same across builds, so macOS keeps its grants: Keychain access to the saved Linear key, and access to the Documents folder. With none, the build stays ad-hoc signed and every rebuild looks like a new app: macOS re-asks for the Linear key (the app waits until you answer), and sessions whose folder is under `~/Documents` fail to start (`brew` says the working directory isn't readable, `claude` says "An unknown error occurred") until you allow Documents access again in System Settings → Privacy & Security → Files & Folders. The first signed build asks once to let `codesign` use the key.

Only one copy runs at a time: launching a second (say, the installed app while `npm run dev` is up) just focuses the first. Dev and the installed app share their state folder, `~/Library/Application Support/session-desk`. The exception is the Linear key, which macOS ties to the app's identity, so each copy asks for it once.

To try a change without quitting the installed app, give the dev copy its own state folder: `SESSION_DESK_DATA_DIR=/tmp/sd-test npm run dev`. It runs beside the app with fresh settings (it asks for a projects folder and a Linear key); don't open a session in both at once.

### Versioning

The version lives in `package.json` and follows [semver](https://semver.org): each rebuild that's installed gets a new one, bumped before `npm run install-app`. While it's 0.x: a new feature or a change in behaviour bumps the minor version (0.1.0 → 0.2.0), a fix or other small change bumps the patch (0.2.0 → 0.2.1). `npm version minor --no-git-tag-version` (or `patch`) edits `package.json` and the lockfile. Settings and Session Desk → About show the running version; `install-app` prints the version it installed and warns when it's the one already installed.

### Badge and notifications

The Dock badge counts open sessions waiting on you. When one starts waiting, a notification says why (finished its turn, needs an answer or permission, stopped with an error); clicking it opens that session. You're not notified about the session on screen in a focused window. By default you're also not notified for sessions open in Claude desktop or a terminal, which notify on their own; "Include Sessions Open in Other Apps" turns those on. macOS asks once whether Session Desk may send notifications.

### Settings (⌘,)

Per user, so each account on a Mac has its own:

- **Projects folder**: new sessions start here (so they keep its CLAUDE.md and auto-memory), and its repos, worktrees, context folder and `.session-desk.json` are read from here. The folder can hold several repos side by side, or be a single repo. Taken from `SESSION_DESK_CWD` when set; otherwise the app asks on first launch.
- **Claude Code folder**: where sessions, transcripts and memory notes live. Defaults to `$CLAUDE_CONFIG_DIR` from your login shell, else `~/.claude`. A non-default folder is passed to every `claude` the app starts (as `CLAUDE_CONFIG_DIR`), so sessions and the app agree.
- **Linear** connection.
- **Draw for screen sharing**: for an account you use over Screen Sharing. Chromium normally draws a frame when the display's refresh timer says so; after the Screen Sharing connection changes, that timer can stop for Session Desk's window, which then stops updating while typing still reaches it and other apps keep working. This setting has Chromium time frames itself (`--disable-gpu-vsync`), at a small idle cost, so it's off by default and applies only to the account that turns it on, from the next launch. (`--disable-frame-rate-limit` also fixes it but redraws constantly, close to a full CPU core when idle, so it isn't used.)

Each user installs their own copy (`npm run install-app` → their `~/Applications`), so one account's install never replaces another's; app state, the Keychain-held Linear key and the status files are per user too.

## Project settings (`.session-desk.json`)

A project folder can hold a `.session-desk.json` with settings for that project. It can be committed, so teammates share it. Settings (⌘,) shows what was loaded, or why the file was rejected (the defaults then apply), and can create a starter file. Saving the file takes effect straight away. Switch projects with File → Switch Project (⇧⌘O) or File → Recent Projects.

Every key is optional:

```json
{
  "worktrees": "{repo}-wt/{ticket}",
  "contextFolder": "evidence",
  "environments": [
    { "id": "prod", "label": "prod" },
    { "id": "stag", "label": "staging" }
  ],
  "deploy": {
    "octo-org/backend": {
      "prod": { "pin": { "repo": "octo-org/gitops", "path": "clusters/prod/backend/kustomization.yaml", "image": "/backend$" } },
      "stag": { "githubDeployment": "staging" }
    },
    "octo-org/frontend": { "prod": { "branch": "release" }, "stag": { "untracked": "deployed by hand" } },
    "octo-org/sdk": { "prod": { "latestTag": "sdk-v*" } },
    "octo-org/platform": {
      "services": {
        "gateway": { "paths": ["gateway", "libs/common/**"], "prod": { "workflowRun": { "workflow": "release-gateway.yml", "branch": "main" } } },
        "jobs": { "paths": ["jobs/**"], "prod": { "githubDeployment": "jobs-production" } }
      }
    }
  }
}
```

`worktrees` is where a ticket's worktree goes, relative to the folder holding the repo (so beside it), with `{repo}` and `{ticket}` (lower-cased) filled in. `contextFolder` is the folder of per-ticket notes shown in the Ticket panel; `null` turns it off.

`deploy` maps each repo, by environment id, to how its current release is found:

| Source | Release | Fits |
|---|---|---|
| `pin` | The tag a GitOps file pins for an image (`images:` entry in a kustomization) | Argo CD / Flux syncing a deploy repo |
| `branch` | The commit the branch is at | Deploys from a branch, e.g. `production` |
| `githubDeployment` | The newest successful GitHub deployment to that environment | Vercel, GitHub Actions environments, anything reporting Deployments |
| `latestTag` | The newest tag matching a glob, by commit date | Release-on-tag |
| `workflowRun` | The commit of the newest successful run of a workflow (`{ "workflow": "deploy.yml", "branch": "main" }`) | GitHub Actions deploys without `environment:` (with it, `githubDeployment` is more exact) |
| `untracked` | Nothing; the reason is shown | Manual deploys with nothing reliable to read |

`environments` are listed nearest production first, and their labels are what the PR panels say: "✓ In prod", "On staging, not in prod yet", "Not deployed yet". Board cards flag only what isn't in production.

**Monorepos.** A repo whose parts deploy separately lists `services`, each with the `paths` it's built from (globs: `**` any depth, `*` and `?` within a folder; a plain path is a folder prefix) and its own environments. A merged PR counts only for the services its changed files touch, and shows each: "gateway: ✓ In prod · jobs: Not deployed yet". A PR touching none (docs, say) shows nothing.

## How sessions are linked

Everything is read from `~/.claude/projects/*/*.jsonl`; nothing is written there.

- **Title**: `/rename` title, else the auto title, else the first prompt.
- **PRs**: the `pr-link` entries Claude Code records when a session opens a PR. State, title and head branch come from `gh` (your existing login).
- **Primary ticket**, first match wins:
  1. A link set by hand (Ticket panel → Change), or made by starting a session from a board card.
  2. A ticket ID (`ENG-123`) named in the session's title.
  3. The ticket the session's PR branches agree on (the only one, or twice as common as the next).
  4. Transcript inference: branches the session switched to, worktree paths it worked in (`api-wt/eng-123`), the branch checked out at start, the first prompt.

Sessions run by the SDK (`entrypoint: sdk-cli`) are hidden.

Ticket IDs are recognised by the connected Linear workspace's team keys (all teams the account can see, e.g. `ENG`, `OPS`), saved per project for offline use; until a project connects Linear, nothing is treated as a ticket. Ticket links use the workspace's own URL key, and stay plain text until it's known.

## Workflow board

Connect Linear from the sidebar footer with a personal API key. Each project folder has its own connection, so projects in different Linear workspaces each show their own board, ticket prefixes and links; switching project switches them (a project not yet connected shows the Connect button). Keys are kept by the app, never in `.session-desk.json`, encrypted with Electron `safeStorage` (a Keychain-held key) and only sent to api.linear.app. A connection made before this was per project belongs to the project folder that was open when the app was updated.

The board shows your issues in the active cycle, excluding canceled and duplicate ones. If none of your teams has an active cycle (you don't use cycles, or are between them), it shows the issues assigned to you instead: everything open, backlog and triage included, plus what you finished in the last 14 days (up to 500, most recently updated kept). One team with an active cycle is enough to keep the board to the cycle. The automatic moves below act on whatever the board holds, so without cycles they can move any ticket assigned to you, not only this cycle's. Columns map from Linear states: unstarted/backlog/triage → To Do, started → In Progress (or In Review when the state's name says review), completed → Done. Dragging a card sets the matching Linear state.

Waiting Response is local to this app; Linear keeps the issue In Progress. A ticket that is In Progress in Linear shows there while any of its sessions is waiting on you (turn finished, permission prompt, AskUserQuestion), and returns to In Progress when you answer. Dragging a card there by hand holds it until one of its sessions next starts working. Tickets in other Linear states stay where Linear has them.

### Moving a card into In Progress

Dragging a card into In Progress here (never a move made in Linear, by you, a teammate or Linear's own automation) also starts or picks up the ticket's work, once Linear has accepted the move:

| The ticket's own session | What happens |
|---|---|
| None yet | A new session, linked to the ticket, starts in the background in Claude Code's plan mode, briefed on the ticket and asked to plan it from the description |
| Has talked but never planned or edited | It's resumed in plan mode and asked to plan, building on what was discussed |
| Showed a plan that was never approved | It's resumed in plan mode and asked to present the plan again |
| Has an approved plan, edits or a PR | It's resumed and asked to continue where it left off |
| Open here and idle at its prompt | The same turn is typed into it |
| Open here and working, or showing a question or permission prompt | Left alone: typing would answer the dialog |
| Open in another app | Left alone, with a note to continue it there |

Plan mode can read but not edit until you approve. When the plan is ready, or Claude asks something, the card moves to Waiting Response; once you answer it moves back to In Progress. Only the ticket's own sessions count, not one that merely opened its PR.

One gap the hooks can't see: dismissing a question or permission prompt with Esc ends the turn without running any hook. The app reads that from the transcript instead (a turn that ended after the hook's last waiting event means idle at the prompt).

### Status hook

Activity comes from a user-level Claude Code hook, so it covers sessions in the CLI and in the Claude desktop app, not just ones run here.

Install it from **Settings → Waiting status hook → Install…**, which shows the exact `settings.json` change first and backs the file up. Each user on a Mac installs it for themselves, into their own Claude Code folder's `settings.json`. The Workflow view says so when it's missing. From a terminal instead:

```bash
npm run hooks -- --dry-run    # show the settings.json diff
npm run hooks                 # install (backs settings.json up first)
npm run hooks -- --uninstall  # remove only our entries
```

The app and the script share the same rules (`src/main/hookSettings.ts`), and the app ships its own copy of the hook script.

`hooks/status-hook.sh` (copied to `~/.session-desk/hook.sh`; Settings shows *outdated* when that copy differs from the app's) writes `~/.session-desk/status/<session-id>` with `working` or `waiting`. It prints nothing and always exits 0. It runs synchronously, because async hooks can finish out of order. Event mapping, measured on Claude Code 2.1.29x:

| State | Events |
|---|---|
| working | `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure` |
| waiting | `PermissionRequest` (permission prompts and AskUserQuestion, immediately), `Stop`, `StopFailure`, `Notification` |
| cleared | `SessionEnd` |

A killed process sends no `SessionEnd`, so a status only counts while a process has the session open (here, or per `~/.claude/sessions/`).

Clicking a card opens its most recent linked session, or starts a new one linked to the ticket. New sessions aren't named up front: the title comes from Claude Code (its own title, or your first prompt), and **Rename** sets one.

## Worktrees for ticket sessions

A session started from a card is briefed through `--append-system-prompt` (`src/main/ticketBrief.ts`) with the ticket's title, link and description. The brief tells Claude to work out which repos the change belongs in, then for each one create or reuse a worktree at the project's `worktrees` layout (default `<repo>-wt/<ticket>`, beside each repo) on Linear's suggested branch (e.g. `me/eng-123`), cut from a freshly fetched default branch. When the project folder is itself a single repo, there's no choosing: its worktree goes beside it (`api-wt/eng-123` next to `api`). Every edit, build and test happens there; main checkouts are left alone. Nothing is created until Claude starts on the work, and repos it only reads get no worktree.

The brief applies only to new sessions started from the board; resuming a session doesn't repeat it. Without Linear it still gets the ticket id.

### Automatic moves (opt-in)

Session Desk menu → **Linear Automation**. Off by default, because they change tickets on the team's board:

- **To Do → In Progress when a session starts working** on the ticket.
- **In Progress → In Review when a PR opens** (a PR becomes reviewable). Disabled when the team already has Linear's own GitHub rule for this (`review → In Review`); then only the first rule is available.

Moves go forward only, never touch In Review, Done or Canceled tickets, happen at most once per ticket per rule (a ticket you move back stays where you put it), and only react to sessions or PRs that started after the rule was turned on. Each move posts a notification. The Workflow top bar shows which rules are on and what Linear does by itself.

App state (links, Waiting overlay, encrypted key) is in `~/Library/Application Support/session-desk/session-desk.json`.

## Text size

**Aa** in a session's footer opens a slider for the terminal text size, from 8 to 24pt (default 11pt). It applies to every session, and to the NerfGuard panel, and changes as you drag; **Reset** goes back to the default. The size is remembered. ⌘+ and ⌘− zoom the whole window, as in other apps.

## Dropping files into a session

Drag files or images from Finder onto a session's terminal: their paths are typed into the prompt, escaped as Terminal.app does, followed by a space so you can keep typing. Claude Code attaches the images among them (they show as `[Image #1]`) and reads other files by path when you send the message. Several files at once are fine. Something dragged from a web page has no file on disk, so nothing is typed; save it first. File drops anywhere else in the window are ignored.

## Model and effort

Under the terminal, two buttons show the session's model and effort (from Claude's latest reply) and change them for that session only: the app saves the choice and restarts its Claude with `--model`/`--effort`, so your defaults for new sessions never change (typing `/model` or `/effort` would change them). If your default model has the 1M context (`opus[1m]`), picking another version of that family keeps it. The buttons are disabled, with the reason, while Claude is working, a question or permission prompt is open, or the session is open in another app.

The list comes from the model catalog Claude Code caches for your account (`~/.claude/cache/model-catalog`, refreshed about hourly), so new models appear without an app update: main models first, older ones under More models, each with its own effort levels and badges. Models newer than your installed Claude Code are left out. If the catalog can't be read, a built-in list is used.

## Mode

The button at the left of the footer shows the session's permission mode (read from the mode line Claude Code draws under its prompt) and changes it, as in the Claude desktop app. Auto, Manual, Accept edits and Plan switch live by pressing Shift+Tab for you, the same as cycling it yourself, so nothing restarts and no setting changes. Bypass permissions can only be chosen when Claude starts: after you confirm, the app restarts the session with `--permission-mode bypassPermissions` for that session only. Claude Code then shows its own warning; **No, exit** ends the session and the app forgets the choice. Leaving Bypass restarts the session normally, then switches to the mode you picked.

## Context and usage limits

The ring at the right of the footer shows how full the session's context window is; click it for the details, as in the Claude desktop app: tokens used of the window, about how far until auto-compact (documented for 1M-context models, ~967K), and your plan's limits: the 5-hour session limit and the weekly limit for all models, each with its reset time. **Compact session** and **See detailed breakdown** send `/compact` and `/usage` to the session when it's idle; neither changes any setting.

The numbers come from Claude Code's status line input. Sessions this app starts get a status line of the app's own, passed with `--settings` for that session only (your settings never change), which saves that input to `~/.session-desk/usage/` and then runs your own status line, if you have one, so what you see in the terminal stays the same. A session started elsewhere shows only the tokens in its last reply, from its transcript. Claude Code doesn't report the per-model weekly limit, so that one isn't shown.

## Memory

macOS counts every process a session starts as Session Desk: its `claude`, and everything that starts in turn (test runners, dev servers, headless browsers). So when a test run grows to several GB, Activity Monitor and the out-of-memory dialog blame Session Desk. The footer of a session open here shows the memory that session and everything it started are using; click it to see the largest programs, with same-named processes added up ("node vitest × 4"). In the sidebar, a session's row shows the number once it passes 1/6 of the Mac's memory (amber, 4 GB on a 24 GB Mac), and in red past 1/3 (8 GB). Past 1/3 the app also shows a notice and a macOS notification naming the session and its largest program. That happens once each time the session crosses the line; it can happen again after the session drops back below the amber line.

It's read every 5 seconds with one `ps` of every process (about 20–40 ms), only while a session is open here. A process belongs to the session whose `claude` it descends from. A server started in the background whose shell then exited is kept too, by what an earlier read saw of it or by its process group. The figure is resident memory, so memory macOS has compressed or swapped out isn't counted, and under memory pressure it reads low. The app's own processes aren't included; they normally stay under a few hundred MB.

## NerfGuard

[NerfGuard](https://nerfguard.com) routes Claude Code through a local gateway: `nerfguard enable` sets `ANTHROPIC_BASE_URL` in `~/.claude/settings.json`, and every `claude` reads that, so sessions started here go through it just as terminal ones do. Sessions already running keep their route until they restart.

The shield next to Search at the top left shows its state: grey when off, green with a check when on and its gateway answers, amber when it's on but the gateway isn't running or you're signed out, crossed out when it isn't installed. Click it for the version, the routing and who's signed in. The app finds `nerfguard` on your login shell's PATH and reads `nerfguard status` (which checks the sign-in with NerfGuard's server) when it opens, every few minutes, when its window comes to the front and when you click the shield; it never changes anything on its own. **Settings → NerfGuard** hides the shield while NerfGuard isn't installed.

When NerfGuard isn't installed, the menu offers **Install…**: after you confirm, it runs NerfGuard's installer (`curl -fsSL https://nerfguard.com/install.sh | bash`, as nerfguard.com gives it) in a terminal panel. The installer puts NerfGuard in `~/.nerfguard` with its commands in `~/.local/bin`, adds that to your PATH in your shell profile if needed, then runs its setup (sign-in and turning it on) in the same terminal.

The shield's menu runs NerfGuard's own commands for you: **Turn on** (`nerfguard enable`; **Turn on again** restarts a gateway that stopped), **Turn off** (`nerfguard disable`), **Sign in** / **Sign out**, **Dashboard** and **Live logs**. Each runs in a terminal panel you can type into, since sign-in asks for your email, a code and a password, and enable can ask questions too; nothing is answered for you. **Stop** sends Ctrl-C (and ends the command if it doesn't stop). After turning on or off, sessions already open keep their old route, so the panel offers to restart the idle ones, once NerfGuard's gateway answers (a session restarted before that couldn't connect); busy ones are left alone.

## Sidebar

Drag the sidebar's right edge to make it wider or narrower (200–560px); double-click the edge for the default width, or focus it with Tab and use the arrow keys. The width is remembered. When the window is too narrow for it, the sidebar gives way so the main pane keeps some room, and goes back to your width when the window widens again.

Each session row has a `…` menu on hover (or right-click): Rename, Move to group, Archive, Delete. The title-bar menu has the same items plus Stop, Open in Terminal, copy commands and Show transcript.

- **Rename** goes through Claude Code, so the name shows everywhere `claude --resume` and the desktop app list sessions. A session running here gets `/rename <name>` typed into its prompt for you to send; one that isn't running is renamed with a brief headless `claude --resume <id> --name <name>`, which records the title without sending a turn.
- **Layout** follows the desktop app: Pinned, then custom groups, then one section per project folder (the session's starting directory, most recent first), then Archived. A folder header's `+` starts a new session in that folder.
- **Pin** puts a session in Pinned; it keeps its group and returns there when unpinned. Drop a row on Pinned to pin it, or on a folder header to take it out of its group and pins.
- **Groups** are sidebar sections like the desktop app's custom groups. Create one from the folder icon in the toolbar or from Move to group → New group, then drag sessions onto a group header or use the menu. Deleting a group returns its sessions to their folders. Pins, groups and archive state are app-side only.
- **Delete** moves the transcript, its sibling folder, `file-history/<id>` and `session-env/<id>` to the macOS Trash. It is refused while the session is open here or in another app.

## Jump to anything (⌘K)

⌘K (or the sidebar's search icon) opens a palette over everything: views, sessions (by title, ticket or folder), sprint tickets (opens the ticket's session or starts one), and **conversations**: every word you type must appear in one of your prompts or Claude's replies, in any session. ⌘1–9 open pinned sessions in sidebar order.

Conversation search covers prompts and replies only, not tool output: about 7 MB of text across ~100 transcripts (≈300 MB on disk). The index builds on first search (~1 s) and then updates per changed transcript; each search takes a few milliseconds, so results update as you type.

## Artifacts

The Artifacts view lists every claude.ai artifact a session published (the `Artifact` tool, or a connector such as Claude Docs creating one) or opened, newest first and merged by link: title (the published file's name or the doc's name), the one-line description from the latest publish, the tickets it relates to (named in it, or its sessions' tickets), the sessions it came from (click to open), and **Open ↗**. Links only *mentioned* in tool output (a grep, say) don't count. Each artifact's menu can **remove it from the list** (restore from "Show removed") or **delete it on claude.ai**: the app can't delete artifacts itself, so that opens it on claude.ai to delete there, and removes it from the list. Built from transcripts on first view (~1 s), then cached per transcript.

## Ticket context

Under the ticket, the session view lists what else exists about it:

- **Evidence**: folders in the project's context folder (`contextFolder`, `evidence/` by default) named for the ticket (any case: `ENG-123`, `eng-456`) or for one of the session's PRs (`PR-9107`), with file count and last change. Click to open in Finder.
- **Memory notes**: Claude Code memory notes (`~/.claude/projects/*/memory/*.md`) that mention the ticket. Notes named for it come first, then by number of mentions, with each note's one-line description. Click to open in your default editor. The `MEMORY.md` index and temp-folder projects are skipped.

Only those two kinds of path can be opened from here: folders inside the context folder, and `.md` files inside a memory folder (symlinks are judged by their target), so a click can never launch a program.

## PR status

Open PRs show checks, review decision, unresolved review threads and Greptile's standing, in the session's PR panel and (only what needs attention) on board cards. Where Greptile's automatic reviews are off, it reviews only when asked, and its summary goes stale as commits land:

| Greptile | Meaning |
|---|---|
| up to date | its summary's *Last reviewed commit* is the PR head |
| N commits behind / reviewed an older version | commits landed since; "older version" when the branch was rebased and the reviewed commit is gone |
| review requested | an `@greptileai review` comment is newer than its last summary |
| not reviewed | no summary; a `<!-- greptile-status -->` notice alone is not a review |

**Unpushed commits.** Each open PR is compared with the local worktree (or main checkout) on its branch. Local commits the PR on GitHub doesn't have show as "N local commits not pushed" (and "N unpushed" on board cards); commits on GitHub missing locally show quietly as "N newer on GitHub". If the PR's head was never fetched here, it says "Local branch differs from the PR" instead of guessing. Comparisons are cached by commit pair and re-run at most every 15 seconds.

**Merged vs. deployed.** For PRs merged in the last 30 days, the panel says where they are live: "In prod", "On staging, not in prod yet", or "Not deployed yet" (board cards show only "Not in prod"). What each environment runs comes from the project's `.session-desk.json` (`deploy`, see [Project settings](#project-settings-session-deskjson)); a PR is live there when that release contains its merge commit (GitHub's compare API; nothing is fetched locally). Repos the file doesn't list show nothing. Releases are re-read every 5 minutes; a "live" answer is final.

Greptile shows only on PRs where it has posted something (a review, or a "reviews are disabled" notice), i.e. repos it's installed on; elsewhere the PR line says nothing about it. **Ask Greptile to review** posts exactly `@greptileai review` as you, after a confirmation, and only on open PRs. Statuses refresh every 5 minutes, and immediately after asking.

## Worktrees

The Worktrees view lists every extra worktree of every repo directly under the workspace, in all layouts (`<repo>-wt-NNNN`, `<repo>-wt/eng-123`, `.claude/worktrees/…`). For each it shows the branch, ticket, PR, and what removing it would lose:

| Verdict | Meaning | Action |
|---|---|---|
| Safe | PR merged or closed (or no commits of its own, if older than 14 days), nothing uncommitted or unpushed, nothing running in it | Remove, also in bulk |
| Active | Everything pushed, but the PR is open, the branch is pushed without a PR, or it's new | Remove one at a time |
| Has work | Uncommitted changes, unpushed commits, unverifiable, or a process has its working directory inside | none |
| Missing | Folder gone; git still lists it | Clear stale entries (`git worktree prune`) |

Because PRs are squash-merged, "pushed" means no local commits beyond the PR's last head commit (or the remote branch, or the default branch if never pushed). Removal re-checks the worktree first, then runs `git worktree remove` without `--force`. Git itself refuses anything with changes. Branches are kept unless you tick the option to delete those whose PR is merged or closed (see Branches). The confirmation names any ignored files that aren't build output (`.env`, local settings), since removing the folder deletes them. A full check of ~60 worktrees takes about 20 seconds.

## Branches

The Branches view lists every local branch of every repo in the project, with its ticket, PR, sessions, where it's checked out, and whether it's still on GitHub. Each gets a verdict:

- **Safe**: its PR is merged or closed and has every one of its commits (squash merges leave merged branches looking unmerged to git, so the PR is what tells), or, without a PR, all its commits are already in the default branch.
- **Active**: an open PR, or pushed with no PR yet.
- **Has work**: commits that exist only on this Mac or aren't in its PR, or it's checked out in a worktree.
- **Default**: the repo's default branch; never deleted.

**Delete N safe…** deletes those local branches after a confirmation listing them. Each is re-checked first (its tip must not have moved, and it must not be checked out now). Only branches on this Mac are deleted; GitHub's are untouched. git keeps the commits for about 90 days, so a deleted branch can be restored with `git branch <name> <commit>`.

Removing a worktree can also delete its branch (a checkbox in the confirmation, off by default), only when the branch's PR is merged or closed and it still points where the worktree was.

**Left on GitHub.** GitHub's "automatically delete head branches" doesn't always fire, so the second tab lists the branches of your merged PRs that are still on GitHub (most of them can go; your local copy may be long gone). A branch can be deleted there only when all of these hold: its PR is merged and was opened by you (closed-unmerged work, forks and other people's branches are never listed), it still points at the PR's final commit (nothing was pushed after the merge), no open PR uses it as its base or comes from it, and it isn't the default or a protected branch. **Delete N from GitHub…** asks first, re-checks each on GitHub right before deleting, and reports any GitHub refuses. When deleting local branches, a checkbox (off by default) also deletes their GitHub branches under the same rules. **Restore branch** on a PR brings one back.

## Concurrency

Each session is its own `claude` process. Switching sessions hides a terminal; it never restarts it. A session already open in another process (the CLI or the desktop app, per `~/.claude/sessions/`) is not resumed automatically, because two processes writing one transcript corrupt it.

Spawned processes get a clean environment: `CLAUDE*`, `ANTHROPIC_*` and `MCP_*` variables are stripped, then an interactive login shell re-applies your own rc files. Without this, launching the app from inside a Claude session silently disables transcript saving in every child.
