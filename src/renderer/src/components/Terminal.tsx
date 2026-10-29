import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { Kickoff, PrBranch } from '../../../shared/types'
import { dropText, hasFiles } from '../dropPaths'
import { benchTerminal } from '../bench'
import { onSessionOutput } from '../ptyBus'

interface Props {
  sessionId: string
  resume: boolean
  cwd: string
  /** Ticket the new session is for. */
  ticket?: string
  /** Opening turn for the ticket's work (with `ticket`). */
  kickoff?: Kickoff
  prBranch?: PrBranch
  visible: boolean
  fontSize: number
  /** Its process has exited: the terminal is redrawn from its last output and nothing is started. */
  exited: boolean
  exitCode?: number
}

/** How long the cursor blinks after the last keystroke before it holds steady. */
const CURSOR_BLINK_MS = 10_000

export function themeFromCss(): Record<string, string> {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string) => css.getPropertyValue(name).trim()
  return {
    background: v('--term-bg'),
    foreground: v('--term-fg'),
    cursor: v('--term-fg'),
    selectionBackground: v('--term-selection')
  }
}

const exitLine = (code: number | undefined) => `\r\n\x1b[2m[claude exited${code === undefined ? '' : ` with code ${code}`}]\x1b[0m\r\n`

/**
 * One live `claude` process's terminal. Hidden when not active; App unloads
 * ones not viewed for a while and mounts them again later. Mounting attaches
 * to the running process (or starts it), and never restarts one: an exited
 * session is only redrawn.
 */
export function Terminal({ sessionId, resume, cwd, ticket, kickoff, prBranch, visible, fontSize, exited, exitCode }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const fit = useRef<FitAddon | null>(null)
  const term = useRef<XTerm | null>(null)
  const [dropping, setDropping] = useState(false)

  useEffect(() => {
    const xterm = new XTerm({
      fontFamily: '"SF Mono", Menlo, monospace',
      fontSize,
      lineHeight: 1.15,
      cursorBlink: true,
      allowProposedApi: true,
      macOptionIsMeta: true,
      scrollback: 10000,
      theme: themeFromCss()
    })
    const fitAddon = new FitAddon()
    xterm.loadAddon(fitAddon)
    xterm.open(host.current!)
    term.current = xterm
    fit.current = fitAddon
    const offBench = window.desk.bench ? benchTerminal(xterm, host.current!) : () => {}
    try {
      fitAddon.fit()
    } catch {
      // Hidden on mount; fitted when shown.
    }

    const offData = onSessionOutput(sessionId, (data) => xterm.write(data))
    const offExit = window.desk.onPtyExit((id, code) => id === sessionId && xterm.write(exitLine(code)))
    // A replay holds the program's old queries (cursor position, colours…);
    // the terminal answers them as it redraws. Those answers must not reach
    // the program as typed input.
    let replaying = false
    let disposed = false
    const replay = (text: string, after = '') => {
      if (disposed || (!text && !after)) return
      replaying = true
      xterm.write(text + after, () => (replaying = false))
    }
    const input = xterm.onData((d) => {
      if (replaying) return
      window.desk.ptyWrite(sessionId, d)
      blinkAwhile()
    })
    // The cursor blinks by an endless CSS animation, which has Chromium paint
    // the window at the display's full rate (about 10% CPU at 120 Hz) for as
    // long as the terminal has focus. Blink after typing, then hold it steady.
    let blinkTimer: ReturnType<typeof setTimeout> | undefined
    const blinkAwhile = () => {
      if (!xterm.options.cursorBlink) xterm.options.cursorBlink = true
      clearTimeout(blinkTimer)
      blinkTimer = setTimeout(() => (xterm.options.cursorBlink = false), CURSOR_BLINK_MS)
    }
    blinkAwhile()
    const resize = xterm.onResize(({ cols, rows }) => window.desk.ptyResize(sessionId, cols, rows))

    if (exited) {
      void window.desk.ptyReplay(sessionId).then((text) => replay(text, exitLine(exitCode)))
    } else {
      window.desk
        .ptyStart({ sessionId, resume, cwd, ticket, kickoff, prBranch, cols: xterm.cols, rows: xterm.rows })
        .then((text) => replay(text))
        .catch((err) => !disposed && xterm.write(`\x1b[31mFailed to start claude: ${String(err)}\x1b[0m\r\n`))
    }

    const scheme = window.matchMedia('(prefers-color-scheme: dark)')
    const retheme = () => (xterm.options.theme = themeFromCss())
    scheme.addEventListener('change', retheme)

    const ro = new ResizeObserver(() => {
      if (host.current && host.current.offsetParent !== null) {
        try {
          fitAddon.fit()
        } catch {
          // Zero-size during layout; next observation fits.
        }
      }
    })
    ro.observe(host.current!)

    return () => {
      disposed = true
      clearTimeout(blinkTimer)
      offBench()
      ro.disconnect()
      scheme.removeEventListener('change', retheme)
      offData()
      offExit()
      input.dispose()
      resize.dispose()
      xterm.dispose()
    }
    // A terminal is bound to one session for its lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // A new size changes how many rows and columns fit; refitting tells claude.
  useEffect(() => {
    const xterm = term.current
    if (!xterm || xterm.options.fontSize === fontSize) return
    xterm.options.fontSize = fontSize
    if (host.current?.offsetParent !== null) {
      try {
        fit.current?.fit()
      } catch {
        // Not laid out; fitted when shown.
      }
    }
  }, [fontSize])

  useEffect(() => {
    if (!visible) return
    const focus = () => term.current?.focus()
    window.addEventListener('desk:focus-terminal', focus)
    return () => window.removeEventListener('desk:focus-terminal', focus)
  }, [visible])

  useEffect(() => {
    if (!visible) return
    requestAnimationFrame(() => {
      try {
        fit.current?.fit()
      } catch {
        // Not laid out yet.
      }
      term.current?.focus()
    })
  }, [visible])

  // Files dropped from Finder are typed into the prompt as escaped paths, as
  // Terminal.app does; Claude Code attaches the images among them. `paste`
  // wraps them in bracketed paste when Claude Code has it on.
  const onDragOver = (e: React.DragEvent) => {
    if (!hasFiles(e.dataTransfer)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDropping(true)
  }
  const onDragLeave = (e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false)
  }
  const onDrop = (e: React.DragEvent) => {
    if (!hasFiles(e.dataTransfer)) return
    e.preventDefault()
    setDropping(false)
    const text = dropText(Array.from(e.dataTransfer.files, (f) => window.desk.pathForFile(f)))
    if (!text || !term.current) return
    term.current.paste(text)
    term.current.focus()
  }

  return (
    <div
      className={`term-host${dropping ? ' drop-target' : ''}`}
      ref={host}
      style={{ display: visible ? 'block' : 'none' }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    />
  )
}
