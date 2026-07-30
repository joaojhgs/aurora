// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  LocalFeatureSharingPanel,
  type LocalFeatureSharingPort,
  type LocalFeatureSharingSnapshot,
} from '../src/local-feature-sharing'
import { findForbiddenProductionCopyTerms } from '../src/product-copy-forbidden-terms'

describe('LocalFeatureSharingPanel', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('renders only detected features with product-safe default-off and local-confirmation copy', () => {
    const text = visibleText(renderToStaticMarkup(
      <LocalFeatureSharingPanel port={port(snapshot())} initialSnapshot={snapshot()} />,
    ))

    expect(text).toContain('Features on this device')
    expect(text).toContain('Document access')
    expect(text).toContain('Off')
    expect(text).toContain('Aurora must stay open')
    expect(text).toContain('Asks before sensitive actions')
    expect(text).toContain('No approved devices yet')
    expect(text).not.toContain('Unavailable camera adapter')
    expect(findForbiddenProductionCopyTerms(text).map((term) => term.id)).toEqual([])
  })

  it('uses authority-backed peer ids for feature enablement, sharing expiry, and revoke', async () => {
    const current = snapshot({
      features: [
        feature({ id: 'documents', enabled: false }),
        feature({ id: 'assistant', label: 'Assistant on this device', enabled: true }),
      ],
      approvedDevices: [{
        peerId: 'peer-authority-1',
        peerLabel: 'Kitchen display',
        featureIds: ['assistant'],
        expiresAtMs: null,
      }],
    })
    const controller = port(current)
    const { container, root } = mountedRoot()

    await act(async () => {
      root.render(<LocalFeatureSharingPanel port={controller} />)
      await flush()
    })

    const documentSwitch = container.querySelector<HTMLElement>('[aria-label="Turn Document access on"]')
    expect(documentSwitch).not.toBeNull()
    await act(async () => {
      documentSwitch?.click()
      await flush()
    })
    expect(controller.setFeatureEnabled).toHaveBeenCalledWith('documents', true)

    await act(async () => {
      buttonByText(container, 'Choose features').click()
    })
    expect(document.body.textContent).toContain('Choose features for Kitchen display')
    const assistantCheckbox = Array.from(document.body.querySelectorAll<HTMLElement>('[role="checkbox"]'))
      .find((checkbox) => checkbox.parentElement?.textContent?.includes('Assistant on this device'))
    expect(assistantCheckbox?.getAttribute('aria-checked')).toBe('true')

    await act(async () => {
      buttonByText(document.body, 'Stop sharing').click()
      await flush()
    })
    expect(controller.revokePeerSharing).toHaveBeenCalledWith('peer-authority-1')
    root.unmount()
  })

  it('keeps sharing choices open when a revoke cannot be saved', async () => {
    const current = snapshot({
      features: [feature({ enabled: true })],
      approvedDevices: [{
        peerId: 'peer-authority-2',
        peerLabel: 'Hallway display',
        featureIds: ['documents'],
        expiresAtMs: null,
      }],
    })
    const controller = port(current)
    controller.revokePeerSharing = vi.fn().mockRejectedValue(new Error('raw authority failure'))
    const { container, root } = mountedRoot()

    await act(async () => {
      root.render(<LocalFeatureSharingPanel port={controller} />)
      await flush()
    })
    await act(async () => {
      buttonByText(container, 'Choose features').click()
    })
    await act(async () => {
      buttonByText(document.body, 'Stop sharing').click()
      await flush()
    })

    expect(controller.revokePeerSharing).toHaveBeenCalledWith('peer-authority-2')
    expect(document.body.textContent).toContain('Choose features for Hallway display')
    expect(container.textContent).toContain('Aurora could not save this change. Try again.')
    expect(container.textContent).not.toContain('raw authority failure')
    root.unmount()
  })

  it('never renders hostile feature, peer, or error details', async () => {
    const poisoned = snapshot({
      features: [feature({
        label: 'Provider runtime manifest',
        description: 'SQLite migration fallback failed',
      })],
      approvedDevices: [{
        peerId: 'peer-1',
        peerLabel: 'WebRTC transport peer',
        featureIds: [],
        expiresAtMs: null,
      }],
    })
    const controller = port(poisoned)
    controller.load = vi.fn().mockRejectedValue(new Error('schema migration fallback IndexedDB'))
    const { container, root } = mountedRoot()

    await act(async () => {
      root.render(<LocalFeatureSharingPanel port={controller} />)
      await flush()
    })

    expect(container.textContent).toContain('Aurora could not load sharing choices. Try again.')
    expect(container.textContent).not.toContain('schema migration fallback IndexedDB')

    const staticText = visibleText(renderToStaticMarkup(
      <LocalFeatureSharingPanel port={port(poisoned)} initialSnapshot={poisoned} />,
    ))
    expect(staticText).toContain('Device feature')
    expect(staticText).toContain('Approved device')
    expect(staticText).not.toContain('Provider runtime manifest')
    expect(staticText).not.toContain('WebRTC transport peer')
    expect(findForbiddenProductionCopyTerms(staticText).map((term) => term.id)).toEqual([])
    root.unmount()
  })
})

function feature(
  overrides: Partial<LocalFeatureSharingSnapshot['features'][number]> = {},
): LocalFeatureSharingSnapshot['features'][number] {
  return {
    id: 'documents',
    label: 'Document access',
    description: 'Read a document only after you choose it.',
    enabled: false,
    available: true,
    requiresAuroraOpen: true,
    requiresLocalConfirmation: true,
    permissionNeeded: false,
    ...overrides,
  }
}

function snapshot(
  overrides: Partial<LocalFeatureSharingSnapshot> = {},
): LocalFeatureSharingSnapshot {
  return {
    features: [
      feature(),
      feature({
        id: 'unavailable-camera',
        label: 'Unavailable camera adapter',
        available: false,
      }),
    ],
    approvedDevices: [],
    ...overrides,
  }
}

function port(initial: LocalFeatureSharingSnapshot): LocalFeatureSharingPort & {
  setFeatureEnabled: ReturnType<typeof vi.fn>
  replacePeerSharing: ReturnType<typeof vi.fn>
  revokePeerSharing: ReturnType<typeof vi.fn>
} {
  let current = initial
  const listeners = new Set<(snapshot: LocalFeatureSharingSnapshot) => void>()
  return {
    load: vi.fn(async () => current),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setFeatureEnabled: vi.fn(async (featureId: string, enabled: boolean) => {
      current = {
        ...current,
        features: current.features.map((item) => item.id === featureId ? { ...item, enabled } : item),
      }
      for (const listener of listeners) listener(current)
    }),
    replacePeerSharing: vi.fn(async (peerId: string, featureIds: readonly string[], expiresAtMs: number | null) => {
      current = {
        ...current,
        approvedDevices: current.approvedDevices.map((peer) => peer.peerId === peerId
          ? { ...peer, featureIds: [...featureIds], expiresAtMs }
          : peer),
      }
      for (const listener of listeners) listener(current)
    }),
    revokePeerSharing: vi.fn(async (peerId: string) => {
      current = {
        ...current,
        approvedDevices: current.approvedDevices.map((peer) => peer.peerId === peerId
          ? { ...peer, featureIds: [], expiresAtMs: null }
          : peer),
      }
      for (const listener of listeners) listener(current)
    }),
  }
}

function mountedRoot() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  return { container, root: createRoot(container) }
}

function buttonByText(root: ParentNode, text: string): HTMLButtonElement {
  const button = Array.from(root.querySelectorAll<HTMLButtonElement>('button'))
    .find((candidate) => candidate.textContent?.trim() === text)
  if (!button) throw new Error(`Missing button: ${text}`)
  return button
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function visibleText(markup: string): string {
  return markup
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&amp;/gu, '&')
    .replace(/&#x27;|&apos;/gu, "'")
    .replace(/\s+/gu, ' ')
    .trim()
}
