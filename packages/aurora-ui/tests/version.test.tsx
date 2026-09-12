// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { AuroraClient as Aurora, MockAuroraTransport } from '@aurora/client'
import { AppShell } from '../src/shell'
import { buildShellSnapshot } from '../src/shell-data'
import {
  AURORA_FALLBACK_VERSION,
  auroraBuildVersionLabel,
  auroraRuntimeVersionLabel,
} from '../src/version'

describe('unified Aurora version label', () => {
  it('injects the repo-root VERSION value into UI tests', () => {
    expect(auroraBuildVersionLabel()).toBe(AURORA_FALLBACK_VERSION)
    expect(AURORA_FALLBACK_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('prefers a connected server version over the UI build label', () => {
    expect(auroraRuntimeVersionLabel(null)).toBe(AURORA_FALLBACK_VERSION)
    expect(auroraRuntimeVersionLabel('  ')).toBe(AURORA_FALLBACK_VERSION)
    expect(auroraRuntimeVersionLabel(' 2.3.4 ')).toBe('2.3.4')
  })

  it('renders the chip with the build version and connected suffix', async () => {
    const snapshot = await buildShellSnapshot(new Aurora({ transport: new MockAuroraTransport() }))
    expect(snapshot.serverVersion).toBeNull()

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () => {
        root.render(
          <AppShell snapshot={snapshot}>
            <div>Current page</div>
          </AppShell>,
        )
      })
      const chip = host.querySelector('.aui-runtime-chip')
      expect(chip?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
        `v${AURORA_FALLBACK_VERSION} · connected`,
      )
    } finally {
      await act(async () => root.unmount())
      host.remove()
    }
  })

  it('renders the connected server version on the chip when the catalog reports one', async () => {
    const snapshot = await buildShellSnapshot(new Aurora({ transport: new MockAuroraTransport() }))
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () => {
        root.render(
          <AppShell snapshot={{ ...snapshot, serverVersion: '9.8.7' }}>
            <div>Current page</div>
          </AppShell>,
        )
      })
      const chip = host.querySelector('.aui-runtime-chip')
      expect(chip?.textContent?.replace(/\s+/g, ' ').trim()).toBe('v9.8.7 · connected')
    } finally {
      await act(async () => root.unmount())
      host.remove()
    }
  })
})
