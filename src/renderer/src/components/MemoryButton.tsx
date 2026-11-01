import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { MemoryReport, SessionMemory } from '../../../shared/types'
import { formatBytes } from '../../../shared/memory'

export type MemoryTone = 'warn' | 'bad' | undefined

export function memoryTone(m: SessionMemory | undefined, t: MemoryReport['thresholds'] | undefined): MemoryTone {
  if (!m || !t) return undefined
  return m.bytes >= t.high ? 'bad' : m.bytes >= t.warn ? 'warn' : undefined
}

/** The memory report, kept current from main (one subscription for the whole window). */
export function useMemoryReport(): MemoryReport | null {
  const [report, setReport] = useState<MemoryReport | null>(null)
  useEffect(() => window.desk.onMemory(setReport), [])
  return report
}

/**
 * What the session open here uses, its claude and everything it started
 * (test runners, dev servers, browsers): macOS counts all of it as this app.
 * Click for its largest programs.
 */
export function MemoryButton({ memory, thresholds }: { memory: SessionMemory | undefined; thresholds: MemoryReport['thresholds'] | undefined }) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ bottom: number; right: number } | null>(null)

  useLayoutEffect(() => {
    if (!open || !button.current) return
    const b = button.current.getBoundingClientRect()
    setPos({ bottom: window.innerHeight - b.top + 6, right: Math.max(8, window.innerWidth - b.right) })
  }, [open])

  useEffect(() => {
    if (!open) return
    const outside = (e: MouseEvent) => {
      const t = e.target as Node
      if (!panel.current?.contains(t) && !button.current?.contains(t)) setOpen(false)
    }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', outside)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('mousedown', outside)
      window.removeEventListener('keydown', key)
    }
  }, [open])

  if (!memory) return null
  const tone = memoryTone(memory, thresholds)
  const share = thresholds ? (memory.bytes / thresholds.total) * 100 : 0

  return (
    <>
      <button
        ref={button}
        className={`model-button memory-button ${tone ?? ''}`}
        title={`This session and the ${memory.processes - 1} processes it started: ${formatBytes(memory.bytes)}`}
        onClick={() => setOpen((o) => !o)}
      >
        {formatBytes(memory.bytes)}
      </button>
      {open &&
        createPortal(
          <div ref={panel} className="usage-panel" style={pos ? { bottom: pos.bottom, right: pos.right } : { visibility: 'hidden' }}>
            <div className="usage-section">
              <div className="usage-row">
                <span className="muted">Memory</span>
                <span className="muted">
                  {formatBytes(memory.bytes)}
                  {thresholds ? ` of ${formatBytes(thresholds.total)}` : ''}
                </span>
              </div>
              <div className="usage-meter">
                <div className={`usage-meter-fill ${tone ?? ''}`} style={{ width: `${Math.min(100, share)}%` }} />
              </div>
              <span className="muted">
                Claude and the {memory.processes - 1} processes it started (tests, servers, browsers). macOS counts them all as Session Desk.
              </span>
            </div>
            <div className="usage-section">
              {memory.top.map((p) => (
                <div key={p.name} className="usage-row">
                  <span className="memory-name">
                    {p.name}
                    {p.count > 1 ? ` × ${p.count}` : ''}
                  </span>
                  <span className="muted">{formatBytes(p.bytes)}</span>
                </div>
              ))}
            </div>
            <div className="usage-section">
              <span className="muted">
                Resident memory, every 5 seconds. What macOS compressed or swapped out isn't counted, so under memory pressure this reads low.
              </span>
            </div>
          </div>,
          document.body
        )}
    </>
  )
}
