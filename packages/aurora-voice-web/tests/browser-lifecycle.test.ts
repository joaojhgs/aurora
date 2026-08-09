import { describe, expect, it } from 'vitest'

import {
  createAuroraBrowserPageLifecycle,
  type AuroraBrowserPageLifecycleDocument,
  type AuroraBrowserPageLifecycleWindow
} from '../src/browser-lifecycle.js'

describe('createAuroraBrowserPageLifecycle', () => {
  it('tracks hidden, frozen, page-hidden, and discarded states and removes browser listeners', () => {
    const pageDocument = new FakePageDocument('visible', true)
    const pageWindow = new FakePageWindow()
    const lifecycle = createAuroraBrowserPageLifecycle({ document: pageDocument, window: pageWindow })
    if (lifecycle === null) throw new Error('expected browser lifecycle')
    const reasons: string[] = []
    const unsubscribe = lifecycle.subscribe((eligibility) => reasons.push(eligibility.reason))

    expect(lifecycle.current()).toMatchObject({ eligible: false, visible: false, reason: 'discarded' })

    pageWindow.dispatch('pageshow')
    expect(lifecycle.current()).toMatchObject({ eligible: true, visible: true, reason: 'visible' })

    pageDocument.visibilityState = 'hidden'
    pageDocument.dispatch('visibilitychange')
    expect(lifecycle.current()).toMatchObject({ eligible: false, reason: 'hidden' })

    pageDocument.visibilityState = 'visible'
    pageDocument.dispatch('visibilitychange')
    pageDocument.dispatch('freeze')
    expect(lifecycle.current()).toMatchObject({ eligible: false, frozen: true, reason: 'frozen' })

    pageDocument.dispatch('resume')
    expect(lifecycle.current()).toMatchObject({ eligible: true, frozen: false, reason: 'visible' })

    pageWindow.dispatch('pagehide')
    expect(lifecycle.current()).toMatchObject({ eligible: false, reason: 'pagehide' })
    pageWindow.dispatch('pageshow')
    expect(lifecycle.current()).toMatchObject({ eligible: true, reason: 'visible' })
    expect(reasons).toEqual(['visible', 'hidden', 'visible', 'frozen', 'visible', 'pagehide', 'visible'])

    expect(pageDocument.listenerCount()).toBe(3)
    expect(pageWindow.listenerCount()).toBe(2)
    unsubscribe()
    expect(pageDocument.listenerCount()).toBe(0)
    expect(pageWindow.listenerCount()).toBe(0)
  })

  it('returns null without a browser document', () => {
    expect(createAuroraBrowserPageLifecycle({ document: null, window: null })).toBeNull()
  })
})

class FakeEventTarget {
  private readonly listeners = new Map<string, Set<EventListener>>()

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener)
  }

  dispatch(type: string): void {
    const event = { type } as Event
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event)
    }
  }

  listenerCount(): number {
    let count = 0
    for (const listeners of this.listeners.values()) count += listeners.size
    return count
  }
}

class FakePageDocument extends FakeEventTarget implements AuroraBrowserPageLifecycleDocument {
  constructor(
    public visibilityState: DocumentVisibilityState,
    public readonly wasDiscarded: boolean
  ) {
    super()
  }
}

class FakePageWindow extends FakeEventTarget implements AuroraBrowserPageLifecycleWindow {}
