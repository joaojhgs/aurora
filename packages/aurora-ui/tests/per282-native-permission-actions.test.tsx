// @vitest-environment jsdom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  androidNativeCapabilityManifestFixture,
  buildCapabilityGraph,
  capabilityGraphCatalogFixture,
  gatewayRegistryFixture,
} from '@aurora/client'
import {
  SettingsPermissionsView,
  snapshotFromGraph,
} from '../src/index'
import type { AuroraShellSnapshot } from '../src/shell-data'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount()
  document.body.innerHTML = ''
})

describe('native permission request actions', () => {
  it('suppresses duplicate requests, shows pending state, and releases the guard with success feedback', async () => {
    const snapshot = androidSnapshot()
    let resolveRequest: (() => void) | undefined
    const requestAccess = vi.fn(() => new Promise<void>((resolve) => {
      resolveRequest = resolve
    }))
    const { container } = mount(
      <SettingsPermissionsView
        snapshot={snapshot}
        surface="native"
        onRequestNativeAccess={requestAccess}
      />,
    )

    const requestButton = permissionButton(container, 'Default assistant')
    await act(async () => {
      requestButton.click()
      await Promise.resolve()
    })

    expect(requestAccess).toHaveBeenCalledTimes(1)
    expect(requestButton.disabled).toBe(true)
    expect(requestButton.textContent).toContain('Opening')

    await act(async () => {
      requestButton.click()
      await Promise.resolve()
    })
    expect(requestAccess).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveRequest?.()
      await Promise.resolve()
    })
    expect(requestButton.disabled).toBe(false)
    expect(requestButton.textContent).toContain('Request access')
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('releases the pending guard and surfaces a user-facing error after a rejected request', async () => {
    const snapshot = androidSnapshot()
    let rejectRequest: ((error: unknown) => void) | undefined
    const requestAccess = vi.fn(() => new Promise<void>((_resolve, reject) => {
      rejectRequest = reject
    }))
    const { container } = mount(
      <SettingsPermissionsView
        snapshot={snapshot}
        surface="native"
        onRequestNativeAccess={requestAccess}
      />,
    )

    const requestButton = permissionButton(container, 'Default assistant')
    await act(async () => {
      requestButton.click()
      await Promise.resolve()
    })
    expect(requestButton.disabled).toBe(true)

    await act(async () => {
      rejectRequest?.({ code: 'permission_denied' })
      await Promise.resolve()
    })
    expect(requestButton.disabled).toBe(false)
    expect(requestButton.textContent).toContain('Request access')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Permission is needed to use this feature',
    )
  })
})

function androidSnapshot(): AuroraShellSnapshot {
  const graph = buildCapabilityGraph({
    catalog: capabilityGraphCatalogFixture,
    registry: gatewayRegistryFixture,
    nativeManifest: androidNativeCapabilityManifestFixture,
    transportKind: 'native-mobile',
  })
  return snapshotFromGraph('native-mobile', graph, androidNativeCapabilityManifestFixture)
}

function mount(element: ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(element))
  return { container, root }
}

function permissionButton(container: HTMLElement, rowLabel: string): HTMLButtonElement {
  const row = [...container.querySelectorAll('tr')]
    .find((candidate) => candidate.textContent?.includes(rowLabel))
  const button = row?.querySelector('button')
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Permission button not found: ${rowLabel}`)
  return button
}
