'use client'

type Listener = () => void

// Streaming text is intentionally rendered at a bounded cadence. The message
// scroller observes content size and keeps the active conversation anchored;
// notifying for every token makes it measure the entire history for every
// delta, which is particularly expensive on Android when a long conversation
// is already mounted.
export const ASSISTANT_STREAM_RENDER_INTERVAL_MS = 50

interface StreamEntry {
  messageId: string
  text: string
  revision: number
  listeners: Set<Listener>
  pendingNotification: ReturnType<typeof setTimeout> | null
}

/**
 * Keeps high-frequency token updates outside the assistant session object.
 * The session remains authoritative for terminal/tool/persistence state while
 * the active bubble subscribes to only its own text entry.
 */
export class AssistantStreamTextStore {
  private readonly entries = new Map<string, StreamEntry>()

  begin(messageId: string, text = ''): void {
    const entry = this.entries.get(messageId)
    if (entry) {
      this.cancelPendingNotification(entry)
      entry.text = text
      entry.revision = 0
      this.notify(entry)
      return
    }
    this.entries.set(messageId, {
      messageId,
      text,
      revision: 0,
      listeners: new Set(),
      pendingNotification: null
    })
  }

  append(messageId: string, delta: string): void {
    const entry = this.entries.get(messageId)
    if (!entry || !delta) return
    entry.text += delta
    entry.revision += 1
    this.scheduleNotification(entry)
  }

  getSnapshot(messageId: string): string | null {
    const text = this.entries.get(messageId)?.text
    return text ? text : null
  }

  getRevision(messageId: string): number {
    return this.entries.get(messageId)?.revision ?? 0
  }

  subscribe(messageId: string, listener: Listener): () => void {
    const entry = this.entries.get(messageId)
    if (!entry) return () => undefined
    entry.listeners.add(listener)
    return () => entry.listeners.delete(listener)
  }

  clear(messageId: string): void {
    const entry = this.entries.get(messageId)
    if (!entry) return
    this.entries.delete(messageId)
    this.cancelPendingNotification(entry)
    this.notify(entry)
  }

  private scheduleNotification(entry: StreamEntry): void {
    if (entry.pendingNotification !== null) return
    entry.pendingNotification = setTimeout(() => {
      entry.pendingNotification = null
      if (this.entries.get(entry.messageId) !== entry) return
      this.notify(entry)
    }, ASSISTANT_STREAM_RENDER_INTERVAL_MS)
  }

  private cancelPendingNotification(entry: StreamEntry): void {
    if (entry.pendingNotification === null) return
    clearTimeout(entry.pendingNotification)
    entry.pendingNotification = null
  }

  private notify(entry: StreamEntry): void {
    for (const listener of entry.listeners) listener()
  }
}

export const assistantStreamTextStore = new AssistantStreamTextStore()
