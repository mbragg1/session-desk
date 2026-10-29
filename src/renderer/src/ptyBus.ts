// One subscription to terminal output for the whole window, routed by session.
// Each Terminal subscribing on its own made every chunk visit every open
// terminal's listener.

type Handler = (data: string) => void

const handlers = new Map<string, Handler>()
let off: (() => void) | null = null

export function onSessionOutput(sessionId: string, handler: Handler): () => void {
  off ??= window.desk.onPtyData((id, data) => handlers.get(id)?.(data))
  handlers.set(sessionId, handler)
  return () => {
    if (handlers.get(sessionId) === handler) handlers.delete(sessionId)
    if (!handlers.size && off) {
      off()
      off = null
    }
  }
}
