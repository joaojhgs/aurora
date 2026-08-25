// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  AuroraClient,
  MockAuroraTransport,
  androidNativeCapabilityManifestFixture,
  buildCapabilityGraph,
  capabilityGraphCatalogFixture,
  cloneFixture,
  gatewayRegistryFixture,
  iosNativeCapabilityManifestFixture,
  nativeCapabilityManifestFixture
} from '@aurora/client'
import { auroraMobileTabs, auroraNavSections, getAuroraNavItem, visibleAuroraMobileTabs, visibleAuroraNavSections } from '../src/nav'
import { AppShell } from '../src/shell'
import { buildShellSnapshot, snapshotFromGraph, type AuroraShellSnapshot, type RouteAvailability } from '../src/shell-data'
import { getAuroraSurfaceProfile, shouldShowForSurface, type AuroraSurfaceProfileInput } from '../src/platform-surface'
import type { AuroraNodeMode, AuroraRuntimeProfileV2 } from '../src/runtime-profile'
import { SettingsNativeView } from '../src/settings-native-view'
import { SettingsView } from '../src/settings-view'
import { findForbiddenProductionCopyTerms } from '../src/product-copy-forbidden-terms'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function snapshotFor(nativeManifest: typeof nativeCapabilityManifestFixture | null, transportKind: string): AuroraShellSnapshot {
  const graph = buildCapabilityGraph({
    catalog: capabilityGraphCatalogFixture,
    registry: gatewayRegistryFixture,
    nativeManifest,
    transportKind
  })
  return snapshotFromGraph(transportKind, graph, nativeManifest)
}

function route(snapshot: AuroraShellSnapshot, id: string): RouteAvailability {
  const match = snapshot.routes.find((candidate) => candidate.item.id === id)
  if (!match) throw new Error(`Missing route: ${id}`)
  return match
}

describe('settings nav information architecture', () => {
  it('keeps local Settings in Configure and Server settings in Operate', () => {
    const configure = auroraNavSections.find((section) => section.label === 'Configure')
    const operate = auroraNavSections.find((section) => section.label === 'Operate · admin only')
    const settings = getAuroraNavItem('settings')
    const serverSettings = getAuroraNavItem('config')

    expect(configure?.items.map((item) => item.id)).toContain('settings')
    expect(operate?.items.map((item) => item.id)).not.toContain('settings')
    expect(operate?.items.map((item) => item.id)).toContain('config')
    expect(operate?.items.map((item) => item.id)).toContain('spoken-replies')
    expect(settings).toEqual(expect.objectContaining({
      id: 'settings',
      label: 'Settings',
      href: '/settings',
      adminGated: false,
      privacyClass: 'personal'
    }))
    expect(`${settings?.capabilityModule}.${settings?.capabilityMethod}`).not.toBe('Config.Get')
    expect(serverSettings).toEqual(expect.objectContaining({
      id: 'config',
      label: 'Server settings',
      href: '/admin/config',
      adminGated: true,
      capabilityModule: 'Config',
      capabilityMethod: 'Get'
    }))
    expect(getAuroraNavItem('spoken-replies')).toEqual(expect.objectContaining({
      id: 'spoken-replies',
      label: 'Spoken replies',
      href: '/admin/voice',
      adminGated: true,
      capabilityModule: 'TTS',
      capabilityMethod: 'ListVoices'
    }))
    expect(auroraMobileTabs.map((tab) => tab.id)).toEqual(['assistant', 'mesh', 'settings'])
    expect(auroraMobileTabs.every((tab) => !tab.adminGated)).toBe(true)
  })

  it('keeps /settings routeable when the connected Aurora does not advertise Config reads', async () => {
    const transport = new MockAuroraTransport()
    transport.register('Gateway.GetCapabilityCatalog', () => {
      const catalog = cloneFixture(capabilityGraphCatalogFixture)
      catalog.actions = catalog.actions.filter((action) => !['Config.Get', 'Gateway.GetRegistry', 'DB.RAGSearch'].includes(action.topic ?? ''))
      return catalog
    })

    const snapshot = await buildShellSnapshot(new AuroraClient({ transport }))

    expect(route(snapshot, 'settings')).toEqual(expect.objectContaining({
      state: 'available-local',
      routeable: true,
      disabled: false
    }))
    expect(route(snapshot, 'config')).toEqual(expect.objectContaining({
      state: 'unsupported',
      routeable: false,
      disabled: true
    }))
  })

  it('shows Settings to members in the sidebar and mobile tabs without a lock or the admin section', async () => {
    const snapshot = snapshotFor(nativeCapabilityManifestFixture, 'tauri-local')
    const { container, unmount } = await renderShell(snapshot, false, {
      runtimeMode: 'desktop-local',
      nodeMode: 'mesh-node',
    })

    const settingsLinks = Array.from(container.querySelectorAll('a[href="/settings"]'))
    expect(settingsLinks.length).toBeGreaterThan(0)
    expect(settingsLinks.some((link) => link.textContent?.includes('Settings'))).toBe(true)
    expect(settingsLinks.every((link) => link.querySelector('[aria-label="Admin gated"]') === null)).toBe(true)
    expect(container.textContent).not.toContain('Operate · admin only')
    expect(container.querySelector('a[href="/admin/config"]')).toBeNull()
    expect(container.querySelector('[data-mobile-tab="settings"]')).not.toBeNull()
    await unmount()
  })

  it('keeps the admin section admin-only while Settings stays shared on native desktop', async () => {
    const snapshot = snapshotFor(nativeCapabilityManifestFixture, 'tauri-local')
    const { container, unmount } = await renderShell(snapshot, true, {
      runtimeMode: 'desktop-local',
      nodeMode: 'mesh-node',
    })

    expect(container.textContent).toContain('Operate · admin only')
    expect(container.textContent).toContain('Admin Overview')
    expect(container.textContent).toContain('Server settings')
    expect(container.querySelector('a[href="/admin/config"]')).not.toBeNull()
    expect(container.querySelector('a[href="/settings"]')).not.toBeNull()
    await unmount()
  })
})

describe('settings local-only layout', () => {
  it('opens on This device for members even when the Config route is denied', async () => {
    const snapshot = snapshotFor(null, 'http')
    const deniedConfig = { ...route(snapshot, 'config'), disabled: true, state: 'denied' as const, routeable: false }
    const { container, unmount } = await renderSettings(snapshot, { configRoute: deniedConfig })

    expect(container.querySelector('#settings-this-device-title')?.textContent).toBe('This device')
    expect(container.textContent).not.toContain('All Aurora settings')
    expect(container.textContent).not.toMatch(/\bConfiguration\b/)
    expect(container.textContent).not.toMatch(/\bAdvanced\b/)
    expect(container.querySelector('#settings-home-title')).toBeNull()
    expect(container.querySelector('[role="tab"]')).toBeNull()
    expect(container.querySelector('[role="tablist"]')).toBeNull()
    expect(container.querySelector('[aria-label="Settings sections"]')).toBeNull()
    await unmount()
  })

  it('keeps Settings local-only for admins without a home pane or leftover schema form', async () => {
    const snapshot = snapshotFor(nativeCapabilityManifestFixture, 'tauri-local')
    const { container, unmount } = await renderSettings(snapshot, { sessionIsAdmin: true })

    expect(container.querySelector('#settings-this-device-title')?.textContent).toBe('This device')
    expect(container.querySelector('[aria-label="All Aurora settings"]')).toBeNull()
    expect(container.querySelector('#settings-home-title')).toBeNull()
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent?.startsWith('Aurora on '))).toBe(false)
    expect(container.textContent).not.toContain('Shared features')
    expect(container.textContent).not.toContain('All Aurora settings')
    expect(container.querySelector('[aria-label="Spoken replies"]')).toBeNull()
    expect(Array.from(container.querySelectorAll('a')).some((link) => link.getAttribute('href')?.startsWith('/admin'))).toBe(false)
    await unmount()
  })

  it('does not embed Mesh, Tools, Models, or Memory inside Settings', async () => {
    const snapshot = snapshotFor(nativeCapabilityManifestFixture, 'tauri-local')
    const { container, unmount } = await renderSettings(snapshot, {})

    const links = Array.from(container.querySelectorAll('a')).map((link) => link.getAttribute('href'))
    expect(links).not.toEqual(expect.arrayContaining(['/mesh', '/tools', '/models', '/memory']))
    expect(container.querySelector('[data-testid="mesh-peers"]')).toBeNull()
    await unmount()
  })

  it('keeps /settings/native on the This device surface with Android device access', () => {
    const snapshot = snapshotFor(androidNativeCapabilityManifestFixture, 'native-mobile')
    const markup = renderNativeAlias(snapshot)

    expect(markup).toContain('This device')
    expect(markup).toContain('Device access')
    expect(markup).not.toContain('>Advanced<')
    expect(markup).not.toContain('Device Features')
  })
})

describe('spoken replies stay out of local Settings', () => {
  it('does not show server Spoken replies inside Settings even when speech routes are ready', async () => {
    const ready = snapshotFor(nativeCapabilityManifestFixture, 'tauri-local')
    for (const voiceRoute of [ready.assistantVoiceRoutes.ttsSynthesize, ready.assistantVoiceRoutes.ttsStop]) {
      voiceRoute.routeable = true
      voiceRoute.disabled = false
      voiceRoute.state = 'available-remote'
    }
    const readyRender = await renderSettings(ready, { sessionIsAdmin: true })
    expect(readyRender.container.querySelector('[aria-label="Spoken replies"]')).toBeNull()
    expect(readyRender.container.querySelector('[aria-label="Spoken reply summary"]')).toBeNull()
    expect(readyRender.container.textContent).toContain('Voice on this device')
    expect(readyRender.container.textContent).not.toContain('Spoken reply voices')
    expect(readyRender.container.textContent).not.toContain('Voices available to Aurora')
    expect(hasExactTextControl(readyRender.container, 'Voice')).toBe(false)
    await readyRender.unmount()
  })
})

describe('settings surface filtering', () => {
  const matrix: Array<{
    name: string
    input: AuroraSurfaceProfileInput
    overlay: boolean
    localVoice: boolean
    android: boolean
    ios: boolean
  }> = [
    {
      name: 'desktop-local mesh-node python-full',
      input: { runtimeMode: 'desktop-local', transportKind: 'tauri-local', nativePlatform: 'tauri-desktop', nodeMode: 'mesh-node', runtimeTier: 'python-full' },
      overlay: true,
      localVoice: true,
      android: false,
      ios: false
    },
    {
      name: 'desktop-thin remote-console',
      input: { runtimeMode: 'desktop-thin', transportKind: 'tauri-thin', nativePlatform: 'tauri-desktop', nodeMode: 'remote-console', runtimeTier: 'none' },
      overlay: true,
      localVoice: true,
      android: false,
      ios: false
    },
    {
      name: 'web remote-console',
      input: { runtimeMode: 'web', transportKind: 'http', nodeMode: 'remote-console', runtimeTier: 'none' },
      overlay: false,
      localVoice: true,
      android: false,
      ios: false
    },
    {
      name: 'android remote-console',
      input: { runtimeMode: 'android', transportKind: 'native-mobile', nativePlatform: 'android', nodeMode: 'remote-console', runtimeTier: 'none' },
      overlay: false,
      localVoice: true,
      android: true,
      ios: false
    },
    {
      name: 'ios without voice capture',
      input: { runtimeMode: 'ios', transportKind: 'native-mobile', nativePlatform: 'ios', nodeMode: 'remote-console', runtimeTier: 'none' },
      overlay: false,
      localVoice: false,
      android: false,
      ios: true
    }
  ]

  for (const row of matrix) {
    it(`filters panels for ${row.name}`, () => {
      const profile = getAuroraSurfaceProfile(row.input)
      expect(shouldShowForSurface(profile, 'desktopOverlay')).toBe(row.overlay)
      expect(shouldShowForSurface(profile, 'localVoice')).toBe(row.localVoice)
      expect(shouldShowForSurface(profile, 'android')).toBe(row.android)
      expect(shouldShowForSurface(profile, 'ios')).toBe(row.ios)
    })
  }

  it('keeps Android voice setup visible while the native session still needs speech assets', () => {
    const profile = getAuroraSurfaceProfile({
      runtimeMode: 'mobile-native',
      transportKind: 'native-mobile',
      nativePlatform: 'android',
      nodeMode: 'mesh-node',
      runtimeTier: 'lightweight-ts',
      nativeVoicePresent: true,
      nativeVoiceAvailable: false,
    })

    expect(profile.voiceCapture.focusedPushToTalkOwner).toBe('unavailable')
    expect(shouldShowForSurface(profile, 'localVoice')).toBe(true)
  })

  it('shows Overlay & shortcuts on desktop Tauri and hides it on web and mobile', async () => {
    const desktop = await renderSettings(snapshotFor(nativeCapabilityManifestFixture, 'tauri-local'), {})
    expect(desktop.container.textContent).toContain('Overlay & shortcuts')
    expect(desktop.container.textContent).toContain('Show overlay')
    expect(desktop.container.textContent).toContain('Keyboard shortcut')
    expect(desktop.container.textContent).not.toContain('Overlay and shortcuts are not available to change here yet.')
    await desktop.unmount()

    const web = await renderSettings(snapshotFor(null, 'http'), {})
    expect(web.container.textContent).not.toContain('Overlay & shortcuts')
    await web.unmount()

    const android = await renderSettings(snapshotFor(androidNativeCapabilityManifestFixture, 'native-mobile'), {})
    expect(android.container.textContent).not.toContain('Overlay & shortcuts')
    expect(android.container.textContent).toContain('Device access')
    await android.unmount()

    const ios = await renderSettings(snapshotFor(iosNativeCapabilityManifestFixture, 'native-mobile'), {})
    expect(ios.container.textContent).not.toContain('Overlay & shortcuts')
    expect(ios.container.textContent).not.toContain('Voice on this device')
    await ios.unmount()
  })
})

describe('per-role settings and nav layouts', () => {
  it('hides local Settings from a hosted-web remote-console member and keeps Operate closed', async () => {
    const snapshot = snapshotFor(null, 'http')
    const { container, unmount } = await renderRoleLayout(snapshot, {
      sessionIsAdmin: false,
      runtimeMode: 'web-thin',
      nodeMode: 'remote-console',
    })

    expect(container.querySelector('a[href="/settings"]')).toBeNull()
    expect(container.querySelector('[data-mobile-tab="settings"]')).toBeNull()
    expect(container.querySelector('a[href="/admin/config"]')).toBeNull()
    expect(container.textContent).not.toContain('Operate · admin only')
    expect(container.textContent).not.toContain('Server settings')
    expect(container.querySelector('a[href="/mesh"]')).not.toBeNull()
    expect(container.textContent).toContain('Member')
    expect(container.querySelector('#settings-this-device-title')).toBeNull()
    await unmount()
  })

  it('shows Server settings in Operate for a hosted-web remote-console admin without local Settings', async () => {
    const snapshot = snapshotFor(null, 'http')
    const { container, unmount } = await renderRoleLayout(snapshot, {
      sessionIsAdmin: true,
      runtimeMode: 'web-thin',
      nodeMode: 'remote-console',
      currentPath: '/admin/config',
    })

    expect(container.textContent).toContain('Operate · admin only')
    expect(container.textContent).toContain('Admin Overview')
    expect(container.textContent).toContain('Server settings')
    expect(container.querySelector('a[href="/admin/config"]')?.textContent).toContain('Server settings')
    expect(container.querySelector('a[href="/admin/config"] [aria-label="Admin gated"]')).not.toBeNull()
    expect(container.querySelector('a[href="/settings"]')).toBeNull()
    expect(container.querySelector('[data-mobile-tab="settings"]')).toBeNull()
    expect(container.textContent).toContain('Administrator')
    expect(container.querySelector('#settings-this-device-title')).toBeNull()
    await unmount()
  })

  it('shows mesh-node local Settings without Operate for a hosted-web member node', async () => {
    const snapshot = snapshotFor(null, 'http')
    const { container, unmount } = await renderRoleLayout(snapshot, {
      sessionIsAdmin: false,
      runtimeMode: 'web-thin',
      nodeMode: 'mesh-node',
      runtimeProfile: {
        version: 2,
        id: 'ui-launch-web-node',
        label: 'This device',
        nodeMode: 'mesh-node',
        runtimeTier: 'lightweight-ts',
        localNode: {
          nodeName: 'This device',
          stablePeerId: 'web-node-peer',
          enabledCapabilityPacks: ['native-actions', 'local-tools', 'foreground-voice'],
        },
      },
    })

    expect(container.querySelector('a[href="/settings"]')).not.toBeNull()
    expect(container.querySelector('[data-mobile-tab="settings"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Operate · admin only')
    expect(container.querySelector('a[href="/admin/config"]')).toBeNull()
    expect(container.textContent).toContain('This device can share features with approved Aurora devices.')
    expect(container.querySelector('#settings-this-device-title')?.textContent).toBe('This device')
    expect(container.textContent).not.toContain('Overlay & shortcuts')
    await unmount()
  })

  it('shows Overlay & shortcuts on desktop-local python-full and keeps Settings local', async () => {
    const snapshot = snapshotFor(nativeCapabilityManifestFixture, 'tauri-local')
    const { container, unmount } = await renderRoleLayout(snapshot, {
      sessionIsAdmin: false,
      runtimeMode: 'desktop-local',
      nodeMode: 'mesh-node',
      runtimeProfile: {
        version: 2,
        id: 'ui-launch-desktop-local',
        label: 'This device',
        nodeMode: 'mesh-node',
        runtimeTier: 'python-full',
        localNode: {
          nodeName: 'This device',
          stablePeerId: 'desktop-local-peer',
          enabledCapabilityPacks: ['native-actions', 'local-tools', 'foreground-voice'],
        },
      },
    })

    expect(container.textContent).toContain('Settings')
    expect(container.textContent).not.toContain('Operate · admin only')
    expect(container.textContent).toContain('Overlay & shortcuts')
    expect(container.textContent).toContain('Show overlay')
    expect(container.textContent).toContain('Keyboard shortcut')
    expect(container.textContent).toContain('Voice on this device')
    expect(container.textContent).toContain('This device can share features with approved Aurora devices.')
    expect(container.querySelector('#settings-this-device-title')?.textContent).toBe('This device')
    expect(container.querySelector('#settings-home-title')).toBeNull()
    await unmount()
  })
})

describe('local Settings and Server settings nav gating', () => {
  const matrix: Array<{
    name: string
    input: AuroraSurfaceProfileInput
    sessionIsAdmin: boolean
    localSettings: boolean
    serverSettings: boolean
    operate: boolean
  }> = [
    {
      name: 'hosted-web remote member',
      input: { runtimeMode: 'web-thin', transportKind: 'http', nodeMode: 'remote-console', runtimeTier: 'none' },
      sessionIsAdmin: false,
      localSettings: false,
      serverSettings: false,
      operate: false,
    },
    {
      name: 'hosted-web remote admin',
      input: { runtimeMode: 'web-thin', transportKind: 'http', nodeMode: 'remote-console', runtimeTier: 'none' },
      sessionIsAdmin: true,
      localSettings: false,
      serverSettings: true,
      operate: true,
    },
    {
      name: 'hosted-web mesh-node member',
      input: { runtimeMode: 'web-thin', transportKind: 'http', nodeMode: 'mesh-node', runtimeTier: 'lightweight-ts' },
      sessionIsAdmin: false,
      localSettings: true,
      serverSettings: false,
      operate: false,
    },
    {
      name: 'hosted-web mesh-node with mock SDK transport',
      input: { runtimeMode: 'web-thin', transportKind: 'mock', nodeMode: 'mesh-node', runtimeTier: 'lightweight-ts' },
      sessionIsAdmin: false,
      localSettings: true,
      serverSettings: false,
      operate: false,
    },
    {
      name: 'hosted-web mesh-node admin',
      input: { runtimeMode: 'web-thin', transportKind: 'http', nodeMode: 'mesh-node', runtimeTier: 'lightweight-ts' },
      sessionIsAdmin: true,
      localSettings: true,
      serverSettings: true,
      operate: true,
    },
    {
      name: 'desktop-local python-full',
      input: { runtimeMode: 'desktop-local', transportKind: 'tauri-local', nativePlatform: 'linux', nodeMode: 'mesh-node', runtimeTier: 'python-full' },
      sessionIsAdmin: false,
      localSettings: true,
      serverSettings: false,
      operate: false,
    },
    {
      name: 'desktop-thin remote-console',
      input: { runtimeMode: 'desktop-thin', transportKind: 'tauri-thin', nativePlatform: 'linux', nodeMode: 'remote-console', runtimeTier: 'none' },
      sessionIsAdmin: false,
      localSettings: true,
      serverSettings: false,
      operate: false,
    },
    {
      name: 'android remote-console',
      input: { runtimeMode: 'android', transportKind: 'native-mobile', nativePlatform: 'android', nodeMode: 'remote-console', runtimeTier: 'none' },
      sessionIsAdmin: false,
      localSettings: true,
      serverSettings: false,
      operate: false,
    },
    {
      name: 'ios remote-console',
      input: { runtimeMode: 'ios', transportKind: 'native-mobile', nativePlatform: 'ios', nodeMode: 'remote-console', runtimeTier: 'none' },
      sessionIsAdmin: false,
      localSettings: true,
      serverSettings: false,
      operate: false,
    },
  ]

  for (const row of matrix) {
    it(`gates nav for ${row.name}`, () => {
      const profile = getAuroraSurfaceProfile(row.input)
      expect(shouldShowForSurface(profile, 'localSettings')).toBe(row.localSettings)
      const sections = visibleAuroraNavSections(profile, row.sessionIsAdmin)
      const ids = sections.flatMap((section) => section.items.map((item) => item.id))
      expect(ids.includes('settings')).toBe(row.localSettings)
      expect(ids.includes('config')).toBe(row.serverSettings)
      expect(sections.some((section) => section.label === 'Operate · admin only')).toBe(row.operate)
      expect(visibleAuroraMobileTabs(profile, row.sessionIsAdmin).map((tab) => tab.id).includes('settings')).toBe(row.localSettings)
    })
  }
})

describe('settings production copy', () => {
  const surfaces: Array<{ name: string; snapshot: AuroraShellSnapshot }> = [
    { name: 'web', snapshot: snapshotFor(null, 'http') },
    { name: 'desktop-tauri', snapshot: snapshotFor(nativeCapabilityManifestFixture, 'tauri-local') },
    { name: 'android', snapshot: snapshotFor(androidNativeCapabilityManifestFixture, 'native-mobile') },
    { name: 'ios', snapshot: snapshotFor(iosNativeCapabilityManifestFixture, 'native-mobile') }
  ]

  for (const surface of surfaces) {
    for (const sessionIsAdmin of [false, true]) {
      it(`keeps ${surface.name} settings copy product-safe for ${sessionIsAdmin ? 'admin' : 'member'}`, async () => {
        const { container, unmount } = await renderSettings(surface.snapshot, { sessionIsAdmin })
        assertProductCopy(`${surface.name}-this-device`, container)
        await unmount()
      })
    }
  }
})

function assertProductCopy(name: string, container: HTMLElement): void {
  const text = visibleText(container)
  const matches = findForbiddenProductionCopyTerms(text).map((term) => term.id)
  expect(matches, `${name} rendered forbidden copy in: ${text}`).toEqual([])
  expect(text, `${name} must not label a Configuration section`).not.toMatch(/\bConfiguration\b/u)
  expect(text, `${name} must not label an Advanced section`).not.toMatch(/\bAdvanced\b/u)
  expect(text, `${name} must not be titled Device Features`).not.toContain('Device Features')
  expect(hasExactTextControl(container, 'Voice'), `${name} must not name the home speech tab Voice`).toBe(false)
}

function hasExactTextControl(container: HTMLElement, label: string): boolean {
  return Array.from(container.querySelectorAll('button, a, [role="tab"]'))
    .some((control) => control.textContent?.trim() === label)
}

async function renderShell(
  snapshot: AuroraShellSnapshot,
  sessionIsAdmin: boolean,
  options: { runtimeMode?: string; nodeMode?: AuroraNodeMode } = {},
) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <AppShell
        snapshot={snapshot}
        currentPath="/settings"
        sessionIsAdmin={sessionIsAdmin}
        {...(options.runtimeMode ? { runtimeMode: options.runtimeMode } : {})}
        {...(options.nodeMode ? { nodeMode: options.nodeMode } : {})}
      >
        <main>Settings page</main>
      </AppShell>
    )
  })
  await flushReactWork()
  return {
    container,
    async unmount() {
      await act(async () => root.unmount())
      container.remove()
    }
  }
}

async function renderSettings(
  snapshot: AuroraShellSnapshot,
  options: { sessionIsAdmin?: boolean; configRoute?: RouteAvailability }
) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const configRoute = options.configRoute ?? route(snapshot, 'config')
  await act(async () => {
    root.render(
      <SettingsView
        client={settingsClient()}
        snapshot={snapshot}
        configRoute={configRoute}
        dataRoute={configRoute}
        sessionIsAdmin={options.sessionIsAdmin ?? false}
      />
    )
  })
  await flushReactWork()
  return {
    container,
    async unmount() {
      await act(async () => root.unmount())
      container.remove()
    }
  }
}

function renderNativeAlias(snapshot: AuroraShellSnapshot): string {
  return renderToStaticMarkup(<SettingsNativeView snapshot={snapshot} />)
}

async function renderRoleLayout(
  snapshot: AuroraShellSnapshot,
  options: {
    sessionIsAdmin: boolean
    runtimeMode: string
    nodeMode: AuroraNodeMode
    runtimeProfile?: AuroraRuntimeProfileV2
    currentPath?: string
  },
) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const configRoute = route(snapshot, 'config')
  const surfaceProfile = getAuroraSurfaceProfile({
    runtimeMode: options.runtimeMode,
    nodeMode: options.nodeMode,
    runtimeTier: options.runtimeProfile?.runtimeTier,
    nativePlatform: snapshot.nativePlatform,
    transportKind: snapshot.transportKind,
    enabledCapabilityPacks: options.runtimeProfile?.localNode.enabledCapabilityPacks,
  })
  const showLocalSettings = shouldShowForSurface(surfaceProfile, 'localSettings')
  const currentPath = options.currentPath ?? (showLocalSettings ? '/settings' : '/')
  await act(async () => {
    root.render(
      <AppShell
        snapshot={snapshot}
        currentPath={currentPath}
        sessionIsAdmin={options.sessionIsAdmin}
        runtimeMode={options.runtimeMode}
        nodeMode={options.nodeMode}
      >
        {showLocalSettings ? (
          <SettingsView
            client={settingsClient()}
            snapshot={snapshot}
            configRoute={configRoute}
            dataRoute={configRoute}
            sessionIsAdmin={options.sessionIsAdmin}
            runtimeProfile={options.runtimeProfile}
            surfaceProfile={surfaceProfile}
          />
        ) : (
          <main>Connected Aurora</main>
        )}
      </AppShell>
    )
  })
  await flushReactWork()
  return {
    container,
    async unmount() {
      await act(async () => root.unmount())
      container.remove()
    }
  }
}

function settingsClient(): AuroraClient {
  return {
    transport: { kind: 'http' },
    config: {
      getSchemaMetadata: async () => ({ ok: true, data: { fields: [], secrets_redacted: true } }),
      applyChange: async () => ({ ok: true, data: { success: true } })
    },
    speech: {
      tts: {
        getCapabilities: async () => ({ ok: true, data: { capabilities: { ready: false, ready_languages: [] } } }),
        listVoices: async () => ({ ok: true, data: { voices: [] } })
      }
    },
    memory: {
      listNamespaces: async () => ({ ok: true, data: { namespaces: [] } }),
      listMessages: async () => ({ ok: true, data: { conversations: [] } })
    },
    capabilities: {
      listCatalog: async () => ({ ok: true, data: capabilityGraphCatalogFixture })
    },
    routes: {
      evaluatePolicy: async (request: { auditReceiptTarget?: string }) => ({
        decision: 'allowed',
        allowed: true,
        availability: 'available-local',
        reasonCode: 'ready',
        repairPath: null,
        privacyClass: 'personal',
        dataClasses: ['personal'],
        explicitSelectorRequired: false,
        approval: { required: false, status: 'not-required', scopes: [] },
        route: {},
        selectedCandidate: null,
        blockers: [],
        preview: {
          fallbackBehavior: 'none',
          auditReceiptTarget: request.auditReceiptTarget ?? 'local'
        }
      })
    }
  } as unknown as AuroraClient
}

function visibleText(container: HTMLElement): string {
  return (container.textContent ?? '').replace(/\s+/gu, ' ').trim()
}

async function flushReactWork(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
