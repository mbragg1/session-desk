/**
 * Coalesces terminal output on its way to the window. A streaming session
 * writes many small chunks; sending each as its own IPC message cost more in
 * both processes than the text itself. Output of the session on screen goes
 * out at the end of the current event-loop turn (no added latency); the
 * others' within a frame, all sessions in one message.
 */
export const BACKGROUND_FLUSH_MS = 16

export class PtyBatcher {
  private pending = new Map<string, string>()
  private immediate: NodeJS.Immediate | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(
    private send: (batch: [string, string][]) => void,
    /** The session on screen, whose output is not held back. */
    private active: () => string | null
  ) {}

  push(id: string, data: string): void {
    this.pending.set(id, (this.pending.get(id) ?? '') + data)
    if (id === this.active()) this.immediate ??= setImmediate(() => this.flush())
    else this.timer ??= setTimeout(() => this.flush(), BACKGROUND_FLUSH_MS)
  }

  /** Sends everything held; call before anything that must follow a session's output (its exit). */
  flush(): void {
    if (this.immediate) clearImmediate(this.immediate)
    if (this.timer) clearTimeout(this.timer)
    this.immediate = this.timer = null
    if (!this.pending.size) return
    const batch = [...this.pending]
    this.pending.clear()
    this.send(batch)
  }
}
