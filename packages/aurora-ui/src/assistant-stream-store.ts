'use client'

type Listener = () => void

interface StreamEntry {
  text: string
  listeners: Set<Listener>
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
      entry.text = text
      this.notify(entry)
      return
    }
    this.entries.set(messageId, { text, listeners: new Set() })
  }

  append(messageId: string, delta: string): void {
    const entry = this.entries.get(messageId)
    if (!entry || !delta) return
    entry.text += delta
    this.notify(entry)
  }

  getSnapshot(messageId: string): string | null {
    const text = this.entries.get(messageId)?.text
    return text ? text : null
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
    this.notify(entry)
  }

  private notify(entry: StreamEntry): void {
    for (const listener of entry.listeners) listener()
  }
}

export const assistantStreamTextStore = new AssistantStreamTextStore()
