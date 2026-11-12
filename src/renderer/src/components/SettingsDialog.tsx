import { useEffect, useState } from 'react'
import type { LinearStatus, ProjectConfigStatus, Settings } from '../../../shared/types'
import { errorMessage, shortPath } from '../format'
import { HookSection } from './HookSection'

interface Props {
  linear: LinearStatus | null
  onManageLinear: () => void
  onClose: () => void
  notify: (text: string, kind?: 'info' | 'error') => void
}

/** What the project's .session-desk.json set up, or why it was rejected. */
function ProjectConfigView({ status }: { status: ProjectConfigStatus }) {
  return (
    <div className="project-config">
      {status.state === 'loaded' ? (
        <p className="setting-hint">
          From <code>.session-desk.json</code>:
        </p>
      ) : status.state === 'none' ? (
        <p className="setting-hint">
          No <code>.session-desk.json</code> in this folder, so the defaults apply. Add one to set the worktree layout, context
          folder and deploy tracking for this project; it can be committed and shared.
        </p>
      ) : (
        <p className="setting-hint warn-text">
          <code>.session-desk.json</code> wasn't used, so the defaults apply: {status.error}
        </p>
      )}
      <ul className="project-config-summary">
        {status.summary.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  )
}

/** Per-user settings: which folders the app works from, and the Linear connection. */
export function SettingsDialog({ linear, onManageLinear, onClose, notify }: Props) {
  const [s, setS] = useState<Settings | null>(null)

  useEffect(() => {
    window.desk.getSettings().then(setS)
    // Editing .session-desk.json (or switching project from the menu) shows here straight away.
    return window.desk.onSettingsChanged(() => window.desk.getSettings().then(setS))
  }, [])

  const act = async (fn: () => Promise<Settings>) => {
    try {
      setS(await fn())
    } catch (e) {
      notify(errorMessage(e), 'error')
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal modal-wide settings" role="dialog" aria-label="Settings" onMouseDown={(e) => e.stopPropagation()}>
        <h1>Settings</h1>
        {s && (
          <div className="settings-body">
            <section className="setting">
              <div className="setting-label">Project folder</div>
              <div className="setting-value">{s.workspace ? shortPath(s.workspace) : 'Not chosen yet'}</div>
              <p className="setting-hint">
                New sessions start here, and its repos and their worktrees are read from here. Switch projects with File → Switch
                Project (⇧⌘O).
              </p>
              {s.project && <ProjectConfigView status={s.project} />}
              <div className="setting-actions">
                <button className="btn btn-small" onClick={() => act(() => window.desk.pickFolder('workspace'))}>
                  {s.workspace ? 'Change…' : 'Choose…'}
                </button>
                {s.project?.state === 'none' && (
                  <button className="btn btn-small" onClick={() => act(() => window.desk.createProjectConfig())}>
                    Create .session-desk.json
                  </button>
                )}
                {s.project && s.project.state !== 'none' && (
                  <button className="btn btn-small" onClick={() => window.desk.openProjectConfig()}>
                    Open .session-desk.json
                  </button>
                )}
                {s.workspaceChosen && (
                  <button className="btn btn-small" onClick={() => act(() => window.desk.resetFolder('workspace'))}>
                    Use default
                  </button>
                )}
              </div>
            </section>

            <section className="setting">
              <div className="setting-label">Claude Code folder</div>
              <div className="setting-value">
                {shortPath(s.claudeDir)}
                {s.claudeDirIsDefault && <span className="muted"> (default)</span>}
              </div>
              {s.claudeDirSessions === 0 ? (
                <p className="setting-hint warn-text">No Claude Code sessions found here. Is this the right folder?</p>
              ) : (
                <p className="setting-hint">
                  {s.claudeDirSessions} session transcripts. Sessions, search, artifacts and memory notes come from here, and new
                  sessions are started with it.
                </p>
              )}
              <div className="setting-actions">
                <button className="btn btn-small" onClick={() => act(() => window.desk.pickFolder('claudeDir'))}>
                  Change…
                </button>
                {!s.claudeDirIsDefault && (
                  <button className="btn btn-small" onClick={() => act(() => window.desk.resetFolder('claudeDir'))}>
                    Use default
                  </button>
                )}
              </div>
            </section>

            <HookSection notify={notify} />

            <section className="setting">
              <div className="setting-label">Screen sharing</div>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={s.drawForScreenSharing}
                  onChange={(e) => {
                    const on = e.target.checked
                    void act(() => window.desk.setDrawForScreenSharing(on))
                  }}
                />
                Draw for screen sharing
              </label>
              <p className="setting-hint">
                For an account you use over Screen Sharing: if Session Desk stops updating there while other apps keep working
                (typing still reaches it), turn this on. The window then times its drawing itself instead of following the display,
                at a small cost when idle. Only this account changes.
              </p>
              {s.drawForScreenSharing !== s.drawForScreenSharingActive && (
                <p className="setting-hint warn-text">Quit and reopen Session Desk to apply this.</p>
              )}
            </section>

            <section className="setting">
              <div className="setting-label">NerfGuard</div>
              <p className="setting-hint">
                The shield next to Search at the top left shows whether Claude Code, and so every session here, goes through NerfGuard. It shows
                while NerfGuard isn&rsquo;t installed too.
              </p>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={s.hideNerfguardWhenMissing}
                  onChange={(e) => {
                    const hide = e.target.checked
                    void act(() => window.desk.setHideNerfguard(hide))
                  }}
                />
                Hide it when NerfGuard isn&rsquo;t installed
              </label>
            </section>

            <section className="setting">
              <div className="setting-label">Linear for this project</div>
              <div className="setting-value">
                {linear?.connected ? `Connected as ${linear.viewer}` : 'Not connected'}
              </div>
              <div className="setting-actions">
                <button className="btn btn-small" onClick={onManageLinear}>
                  {linear?.connected ? 'Manage…' : 'Connect…'}
                </button>
              </div>
            </section>
          </div>
        )}
        <div className="modal-actions">
          <span className="app-version muted">Session Desk {__APP_VERSION__}</span>
          <button className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
