// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThinPeerPairingDialog } from '../src/mesh-peers-pairing'
import type { BrowserWebRtcSnapshot } from '../src/web-thin-runtime'

const roots: Root[] = []
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount()
  })
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('thin pairing approval concurrency', () => {
  it('does not close an unmounted dialog when deferred approval settles', async () => {
    const approval = deferred<void>()
    const onConfirm = vi.fn(() => approval.promise)
    const onOpenChange = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(
        <StrictMode>
          <ThinPeerPairingDialog
            snapshot={pairingSnapshot('session-a')}
            open
            onOpenChange={onOpenChange}
            localFeatureSharing={undefined}
            onConfirm={onConfirm}
            onReject={() => undefined}
          />
        </StrictMode>,
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    await clickApprove()
    expect(onConfirm).toHaveBeenCalledTimes(1)

    await act(async () => { root.unmount() })
    const rootIndex = roots.indexOf(root)
    if (rootIndex >= 0) roots.splice(rootIndex, 1)

    await act(async () => {
      approval.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it('keeps the active approval open and reports its failure after switching A→B→A', async () => {
    const firstA = deferred<void>()
    const pendingB = deferred<void>()
    const resourceInFlight = new Set<string>()
    let aRequests = 0
    const onConfirm = vi.fn((sessionId: string) => {
      if (resourceInFlight.has(sessionId)) return
      resourceInFlight.add(sessionId)
      if (sessionId === 'session-a' && aRequests++ === 0) {
        return firstA.promise.finally(() => resourceInFlight.delete(sessionId))
      }
      if (sessionId === 'session-b') {
        return pendingB.promise.finally(() => resourceInFlight.delete(sessionId))
      }
      resourceInFlight.delete(sessionId)
      return Promise.resolve()
    })
    const onOpenChange = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    const renderDialog = (sessionId: string) => {
      root.render(
        <ThinPeerPairingDialog
          snapshot={pairingSnapshot(sessionId)}
          open
          onOpenChange={onOpenChange}
          localFeatureSharing={undefined}
          onConfirm={onConfirm}
          onReject={() => undefined}
        />,
      )
    }
    const flush = async () => {
      await Promise.resolve()
      await Promise.resolve()
    }

    try {
      await act(async () => { renderDialog('session-a'); await flush() })
      await clickApprove()
      expect(onConfirm.mock.calls.map(([sessionId]) => sessionId)).toEqual(['session-a'])

      await act(async () => { renderDialog('session-b'); await flush() })
      await clickApprove()
      expect(onConfirm.mock.calls.map(([sessionId]) => sessionId)).toEqual(['session-a', 'session-b'])

      await act(async () => { renderDialog('session-a'); await flush() })
      expect(findApprove(document.body).disabled).toBe(true)

      expect(onOpenChange).not.toHaveBeenCalledWith(false)
      expect(onConfirm.mock.calls.map(([sessionId]) => sessionId)).toEqual(['session-a', 'session-b'])

      await act(async () => {
        firstA.reject(new Error('connection interrupted'))
        await flush()
      })
      expect(document.body.textContent).toContain('Could not approve this device')
      expect(findApprove(document.body).disabled).toBe(false)

      await clickApprove()
      expect(onConfirm.mock.calls.map(([sessionId]) => sessionId)).toEqual([
        'session-a',
        'session-b',
        'session-a',
      ])
      expect(onOpenChange).toHaveBeenCalledWith(false)
    } finally {
      firstA.resolve()
      pendingB.resolve()
      await act(async () => { await flush() })
    }
  })
})

function pairingSnapshot(sessionId: string): BrowserWebRtcSnapshot {
  return {
    state: 'awaiting-sas-confirmation',
    connectionMode: 'webrtc-only',
    expectedStablePeerId: 'peer-new-device',
    nodeName: 'New Aurora',
    icePathCategory: 'host',
    protocolCapabilities: [],
    reconnectCount: 0,
    pendingCallCount: 0,
    pendingStreamCount: 0,
    pendingSubscriptionCount: 0,
    pendingFragmentCount: 0,
    bufferPressureHighWaterBytes: 0,
    sentFragmentCount: 0,
    receivedFragmentCount: 0,
    updatedAt: '2026-10-06T00:00:00.000Z',
    status: 'pairing',
    secureContext: true,
    visible: true,
    focused: true,
    hasHttpFallback: false,
    secretsPersisted: true,
    pairingSessionId: sessionId,
    pairingVerificationCode: '87654321',
  }
}

async function clickApprove(): Promise<void> {
  await act(async () => {
    findApprove(document.body).click()
    await Promise.resolve()
  })
}

function findApprove(container: ParentNode): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.includes('Approve & pair') || candidate.textContent?.includes('Waiting for other device…'))
  if (!button) throw new Error('Pairing approval button not found')
  return button
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
