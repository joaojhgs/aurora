import { hiddenLifecycle, visibleLifecycle } from './runtime.js'
import type { AuroraVoiceLifecycleEligibility } from './types.js'

export type AuroraBrowserPageLifecycleListener = (eligibility: AuroraVoiceLifecycleEligibility) => void

export interface AuroraBrowserPageLifecyclePort {
  current(): AuroraVoiceLifecycleEligibility
  subscribe(listener: AuroraBrowserPageLifecycleListener): () => void
}

export interface AuroraBrowserPageLifecycleDocument {
  readonly visibilityState: DocumentVisibilityState
  readonly wasDiscarded?: boolean
  addEventListener(type: string, listener: EventListener): void
  removeEventListener(type: string, listener: EventListener): void
}

export interface AuroraBrowserPageLifecycleWindow {
  addEventListener(type: string, listener: EventListener): void
  removeEventListener(type: string, listener: EventListener): void
}

export interface AuroraBrowserPageLifecycleOptions {
  readonly document?: AuroraBrowserPageLifecycleDocument | null
  readonly window?: AuroraBrowserPageLifecycleWindow | null
}

export function createAuroraBrowserPageLifecycle(
  options: AuroraBrowserPageLifecycleOptions = {}
): AuroraBrowserPageLifecyclePort | null {
  const pageDocument = options.document === undefined ? globalDocument() : options.document
  const pageWindow = options.window === undefined ? globalWindow() : options.window
  if (pageDocument === null) return null

  const listeners = new Set<AuroraBrowserPageLifecycleListener>()
  let attached = false
  let pageHidden = false
  let frozen = false
  let discarded = pageDocument.wasDiscarded === true

  const current = (): AuroraVoiceLifecycleEligibility => {
    if (discarded) return hiddenLifecycle('discarded')
    if (pageHidden) return hiddenLifecycle('pagehide')
    if (frozen) return hiddenLifecycle('frozen')
    if (pageDocument.visibilityState !== 'visible') return hiddenLifecycle('hidden')
    return visibleLifecycle()
  }

  const notify = () => {
    const eligibility = current()
    for (const listener of listeners) listener(eligibility)
  }
  const onVisibilityChange: EventListener = () => notify()
  const onPageHide: EventListener = () => {
    pageHidden = true
    notify()
  }
  const onPageShow: EventListener = () => {
    pageHidden = false
    discarded = false
    notify()
  }
  const onFreeze: EventListener = () => {
    frozen = true
    notify()
  }
  const onResume: EventListener = () => {
    frozen = false
    notify()
  }

  const attach = () => {
    if (attached) return
    attached = true
    pageDocument.addEventListener('visibilitychange', onVisibilityChange)
    pageDocument.addEventListener('freeze', onFreeze)
    pageDocument.addEventListener('resume', onResume)
    pageWindow?.addEventListener('pagehide', onPageHide)
    pageWindow?.addEventListener('pageshow', onPageShow)
  }
  const detach = () => {
    if (!attached) return
    attached = false
    pageDocument.removeEventListener('visibilitychange', onVisibilityChange)
    pageDocument.removeEventListener('freeze', onFreeze)
    pageDocument.removeEventListener('resume', onResume)
    pageWindow?.removeEventListener('pagehide', onPageHide)
    pageWindow?.removeEventListener('pageshow', onPageShow)
  }

  return Object.freeze({
    current,
    subscribe(listener: AuroraBrowserPageLifecycleListener): () => void {
      listeners.add(listener)
      if (listeners.size === 1) attach()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) detach()
      }
    }
  })
}

function globalDocument(): AuroraBrowserPageLifecycleDocument | null {
  if (typeof document === 'undefined') return null
  return document as unknown as AuroraBrowserPageLifecycleDocument
}

function globalWindow(): AuroraBrowserPageLifecycleWindow | null {
  if (typeof window === 'undefined') return null
  return window as unknown as AuroraBrowserPageLifecycleWindow
}
