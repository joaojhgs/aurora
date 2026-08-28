// @vitest-environment jsdom
import { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { AuroraClient } from '@aurora/client'
import { buildCapabilityGraph, capabilityGraphCatalogFixture, gatewayRegistryFixture } from '@aurora/client'
import { AppShell } from '../src/shell'
import { SettingsView } from '../src/settings-view'
import { errorShellSnapshot, snapshotFromGraph, type AuroraShellSnapshot, type RouteAvailability } from '../src/shell-data'
import { MeshPeersView, type MeshPeersSnapshot } from '../src/mesh-peers-view'
import { AdminPluginsView, type AdminPluginsSnapshot } from '../src/admin-plugins-view'
import { AdminSchedulerView, type AdminSchedulerSnapshot } from '../src/admin-scheduler-view'
import { OnboardingView, type OnboardingModePreferenceStore } from '../src/onboarding-view'
import { findForbiddenProductionCopyTerms } from '../src/product-copy-forbidden-terms'
import { ServiceRoutingView, type ServiceRoutingSnapshot } from '../src/service-routing-view'
import { HomeNodeConnectionPanel, type WebThinConnectionProfile } from '../src/web-thin-connection-panel'
import { webRtcProfileFromInvite, type BrowserWebRtcPeerController, type BrowserWebRtcSnapshot } from '../src/web-thin-runtime'
import { encodeMeshInviteUrl } from '../src/mesh-invite'

describe('production UI copy', () => {
  it('keeps runtime-role surfaces free of internal wording', () => {
    const snapshot = safeShellSnapshot()
    const surfaces = [
      ['shell', <AppShell key="shell" snapshot={snapshot} runtimeMode="web-thin"><main>Ready</main></AppShell>],
      [
        'onboarding',
        <OnboardingView
          key="onboarding"
          client={client('http')}
          snapshot={snapshot}
          setupRequired
          thinConnectionPanel={<div>Use your Aurora invite to connect this device.</div>}
        />,
      ],
      [
        'home-node-connection',
        <HomeNodeConnectionPanel
          key="home-node-connection"
          peer={peerController()}
          mode="webrtc-preferred"
          transportKind="http"
          configureOnly
        />,
      ],
      ['mesh', <MeshPeersView key="mesh" snapshot={meshSnapshot()} route={route()} canManageLocalServiceConfiguration={false} />],
      ['service-sharing', <ServiceRoutingView key="service-sharing" snapshot={serviceRoutingSnapshot()} />],
      [
        'settings',
        <SettingsView
          key="settings"
          client={client('http')}
          snapshot={settingsSnapshot()}
          configRoute={route()}
          dataRoute={route()}
        />,
      ],
    ] as const

    for (const [name, element] of surfaces) {
      const text = visibleText(renderToStaticMarkup(element))
      const matches = findForbiddenProductionCopyTerms(text).map((term) => term.id)
      expect(matches, `${name} rendered forbidden copy in: ${text}`).toEqual([])
    }
  })

  it('keeps internal device identifiers out of connected-device summaries', () => {
    const html = renderToStaticMarkup(
      <MeshPeersView
        snapshot={meshSnapshot()}
        route={route()}
        canManageLocalServiceConfiguration={false}
      />,
    )

    expect(html).toContain('Studio Aurora')
    expect(html).not.toContain('peer-studio')
  })

  it('maps device connection setting metadata before rendering the settings dialog', async () => {
    const hostileConfigSnapshot: MeshPeersSnapshot = {
      ...meshSnapshot(),
      config: {
        ...meshSnapshot().config,
        editable: true,
        fields: [{
          key_path: 'services.gateway.webrtc.enable_app_layer_e2ee',
          title: 'Application E2EE WebRTC Gateway config',
          description: 'Whether app-layer peer encryption is enabled by Gateway schema fallback.',
          type: 'boolean',
          current_value: true,
          default: true,
          secret: false,
          source_layer: 'user',
          reload_required: false,
          restart_required: false,
          affected_services: [],
          constraints: {},
        }],
      },
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <MeshPeersView
          snapshot={hostileConfigSnapshot}
          route={route()}
          canManageLocalServiceConfiguration
          onConfigChange={() => undefined}
        />,
      )
    })
    await flushReactWork()
    await act(async () => {
      buttonByText(container, 'Device network settings').click()
    })
    await flushReactWork()

    const text = visibleText(document.body.innerHTML)
    expect(text).toContain('Extra message protection')
    expect(text).toContain('Add another protection layer')
    expect(text).not.toContain('Application E2EE WebRTC Gateway config')
    expect(text).not.toContain('Gateway schema fallback')
    expect(findForbiddenProductionCopyTerms(text).map((term) => term.id)).toEqual([])

    root.unmount()
    container.remove()
    document.body.innerHTML = ''
  })

  it('maps hostile shell errors before the activity rail renders them', () => {
    const raw = 'thin client HTTP Gateway WebRTC invite failed'
    const snapshot = errorShellSnapshot('http', new Error(raw))
    const text = visibleText(renderToStaticMarkup(
      <AppShell snapshot={snapshot} runtimeMode="web-thin">
        <main>Ready</main>
      </AppShell>,
    ))

    expect(text).toContain('Could not connect to this Aurora device')
    expect(text).not.toContain(raw)
    expect(findForbiddenProductionCopyTerms(text).map((term) => term.id)).toEqual([])
  })

  it('maps internal platform identifiers to device language in the activity rail', () => {
    const snapshot = safeShellSnapshot({
      loadState: 'ready',
      nativeAvailable: true,
      nativePlatform: 'tauri-desktop',
      transportKind: 'tauri-local',
    })
    const text = visibleText(renderToStaticMarkup(
      <AppShell snapshot={snapshot} runtimeMode="desktop-local">
        <main>Ready</main>
      </AppShell>,
    ))

    expect(text).toContain('Device features available')
    expect(text).not.toContain('tauri-desktop')
    expect(text).not.toMatch(/\bnative\b/i)
  })

  it('does not render hostile onboarding store evidence', async () => {
    const store: OnboardingModePreferenceStore = {
      evidence: 'thin client HTTP Gateway WebRTC invite store evidence',
      readSelectedMode: async () => 'remote-console',
      readSelectedRuntimeTier: async () => 'none',
      writeSelectedMode: async () => true,
      writeSelectedRuntimeTier: async () => true,
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <OnboardingView
          client={client('http')}
          snapshot={safeShellSnapshot()}
          modePreferenceStore={store}
          setupRequired
        />,
      )
    })
    await flushReactWork()

    expect(container.textContent).toContain('Restored Connect to Aurora')
    expect(container.textContent).not.toContain(store.evidence)
    expect(findForbiddenProductionCopyTerms(container.textContent ?? '').map((term) => term.id)).toEqual([])
    root.unmount()
    container.remove()
  })

  it('keeps setup-required onboarding on the role chooser before invite setup', async () => {
    const savedProfiles: WebThinConnectionProfile[] = []
    const onSaveProfile = vi.fn(async (profile: WebThinConnectionProfile) => {
      savedProfiles.push(profile)
    })
    const onUseManualAddress = vi.fn(async () => undefined)
    const inviteText = firstRunInviteText()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <OnboardingView
          client={client('native-mobile')}
          snapshot={safeShellSnapshot({ nativePlatform: 'android', nativeAvailable: true })}
          setupRequired
          onUseManualAddress={onUseManualAddress}
          thinConnectionPanel={
            <HomeNodeConnectionPanel
              peer={peerController({ status: 'needs-invite', secureContext: true, hasHttpFallback: false })}
              mode="webrtc-only"
              transportKind="native-mobile"
              nativePlatform="android"
              initialInviteText={inviteText}
              configureOnly
              onScanQr={async () => firstRunInviteText('scan-room')}
              onSaveProfile={onSaveProfile}
            />
          }
        />,
      )
    })

    expect(container.textContent).toContain('Connect to Aurora')
    expect(container.textContent).toContain('Make this device available')
    expect(container.textContent).not.toContain('Run Aurora on this computer')
    expect(container.querySelector('[data-testid="home-node-panel"]')).toBeNull()

    await act(async () => {
      choiceByText(container, 'Connect to Aurora').click()
      buttonByText(container, 'Continue').click()
    })
    expect(container.querySelector('[data-thin-invite-onboarding="true"]')).not.toBeNull()
    expect(container.querySelectorAll('#webthin-profile-node-name, #aurora-device-name')).toHaveLength(1)
    expect(container.textContent).toContain('Scan invite')
    expect(container.textContent).toContain('Open invite file')
    expect(container.textContent).toContain('Paste invite')
    expect(container.textContent).toContain('1 connection option')
    expect(container.querySelector<HTMLTextAreaElement>('#webthin-invite')?.value).toContain('aurora://mesh/invite?')
    expect(container.textContent).not.toContain('Sign in')
    expect(container.textContent).not.toContain('Access key')
    expect(container.textContent).not.toContain('Request pairing code')
    expect(container.textContent).not.toContain('Exchange code')
    expect(container.querySelector('#aurora-endpoint')).toBeNull()

    await act(async () => {
      const deviceName = container.querySelector<HTMLInputElement>('#webthin-profile-node-name')
      if (!deviceName) throw new Error('Device name input not found')
      setInputValue(deviceName, 'Kitchen tablet')
    })

    await act(async () => {
      buttonByText(container, 'Save invite and continue').click()
    })
    await flushReactWork()
    expect(onSaveProfile).toHaveBeenCalledTimes(1)
    expect(savedProfiles[0]).toMatchObject({ nodeName: 'Kitchen tablet' })

    await act(async () => {
      buttonByText(container, 'Connect with an address').click()
    })
    const endpoint = container.querySelector<HTMLInputElement>('#aurora-endpoint')
    expect(endpoint).not.toBeNull()

    await act(async () => {
      setInputValue(endpoint!, 'https://home.example.test')
    })
    await act(async () => {
      buttonByText(container, 'Use this address').click()
    })
    await flushReactWork()
    expect(onUseManualAddress).toHaveBeenCalledWith('https://home.example.test')

    await act(async () => {
      buttonByText(container, 'Use invite instead').click()
    })
    expect(container.querySelector('#aurora-endpoint')).toBeNull()
    root.unmount()
    container.remove()
  })

  it('shows device setup copy without manual address for available-device setup', async () => {
    const writes: string[] = []
    const tiers: string[] = []
    const store: OnboardingModePreferenceStore = {
      evidence: 'Saved for this device',
      readSelectedMode: async () => null,
      readSelectedRuntimeTier: async () => null,
      writeSelectedMode: async (modeId) => {
        writes.push(modeId)
        return true
      },
      writeSelectedRuntimeTier: async (runtimeTier) => {
        tiers.push(runtimeTier)
        return true
      },
    }
    const onUseManualAddress = vi.fn(async () => undefined)
    const onSaveProfile = vi.fn(async () => undefined)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <OnboardingView
          client={client('native-mobile')}
          snapshot={safeShellSnapshot({ nativePlatform: 'android', nativeAvailable: true })}
          modePreferenceStore={store}
          setupRequired
          onUseManualAddress={onUseManualAddress}
          renderThinConnectionPanel={(modeId) => (
            <HomeNodeConnectionPanel
              peer={peerController({ status: 'needs-invite', secureContext: true, hasHttpFallback: false })}
              mode="webrtc-only"
              transportKind="native-mobile"
              nativePlatform="android"
              initialInviteText={firstRunInviteText()}
              configureOnly
              setupIntent={modeId}
              onSaveProfile={onSaveProfile}
            />
          )}
        />,
      )
    })
    await flushReactWork()
    writes.length = 0
    tiers.length = 0

    await act(async () => {
      choiceByText(container, 'Make this device available').click()
    })
    expect(writes).toEqual(['mesh-node'])
    expect(tiers).toEqual(['lightweight-ts'])
    expect(activeChoiceText(container)).toContain('Make this device available')

    await act(async () => {
      buttonByText(container, 'Continue').click()
    })
    expect(container.textContent).toContain('Choose what this device can share with approved Aurora devices.')
    expect(container.textContent).toContain('Add setup invite')
    expect(container.textContent).toContain('Save device setup')
    expect(container.textContent).not.toContain('Connect with an address')
    expect(container.querySelector('#aurora-endpoint')).toBeNull()
    expect(findForbiddenProductionCopyTerms(container.textContent ?? '').map((term) => term.id)).toEqual([])

    root.unmount()
    container.remove()
  })

  it('does not offer manual address setup without a save handler', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <OnboardingView
          client={client('native-mobile')}
          snapshot={safeShellSnapshot({ nativePlatform: 'android', nativeAvailable: true })}
          setupRequired
          thinConnectionPanel={
            <HomeNodeConnectionPanel
              peer={peerController({ status: 'needs-invite', secureContext: true, hasHttpFallback: false })}
              mode="webrtc-only"
              transportKind="native-mobile"
              nativePlatform="android"
              configureOnly
            />
          }
        />,
      )
    })

    await act(async () => {
      buttonByText(container, 'Continue').click()
    })
    expect(container.textContent).not.toContain('Connect with an address')
    expect(container.querySelector('#aurora-endpoint')).toBeNull()
    expect(findForbiddenProductionCopyTerms(container.textContent ?? '').map((term) => term.id)).toEqual([])
    root.unmount()
    container.remove()
  })

  it('keeps hosted device sharing selectable while saved choices load', async () => {
    const writes: string[] = []
    const tiers: string[] = []
    let resolveMode: (modeId: string | null) => void = () => undefined
    const pendingMode = new Promise<string | null>((resolve) => {
      resolveMode = resolve
    })
    const store: OnboardingModePreferenceStore = {
      evidence: 'Saved for this device',
      readSelectedMode: async () => pendingMode,
      readSelectedRuntimeTier: async () => 'none',
      writeSelectedMode: async (modeId) => {
        writes.push(modeId)
        return true
      },
      writeSelectedRuntimeTier: async (runtimeTier) => {
        tiers.push(runtimeTier)
        return true
      },
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <OnboardingView
          client={client('http')}
          snapshot={safeShellSnapshot()}
          modePreferenceStore={store}
          setupRequired
          thinConnectionPanel={<div data-testid="home-node-panel">Invite panel</div>}
        />,
      )
    })
    await flushReactWork()

    const makeAvailable = choiceByText(container, 'Make this device available')
    expect(makeAvailable.disabled).toBe(false)
    expect(buttonByText(container, 'Continue').disabled).toBe(true)

    await act(async () => {
      makeAvailable.click()
    })
    expect(writes).toEqual(['mesh-node'])
    expect(tiers).toEqual(['lightweight-ts'])
    expect(buttonByText(container, 'Continue').disabled).toBe(false)

    resolveMode('remote-console')
    await flushReactWork()
    expect(activeChoiceText(container)).toContain('Make this device available')

    await act(async () => {
      buttonByText(container, 'Continue').click()
    })
    expect(container.querySelector('[data-testid="home-node-panel"]')).not.toBeNull()

    root.unmount()
    container.remove()
  })

  it('waits for both parts of a role choice to be saved before continuing setup', async () => {
    let resolveModeWrite: (saved: boolean) => void = () => undefined
    let resolveTierWrite: (saved: boolean) => void = () => undefined
    const store: OnboardingModePreferenceStore = {
      evidence: 'Saved for this device',
      readSelectedMode: async () => 'remote-console',
      readSelectedRuntimeTier: async () => 'none',
      writeSelectedMode: async () => new Promise<boolean>((resolve) => {
        resolveModeWrite = resolve
      }),
      writeSelectedRuntimeTier: async () => new Promise<boolean>((resolve) => {
        resolveTierWrite = resolve
      }),
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <OnboardingView
          client={client('http')}
          snapshot={safeShellSnapshot()}
          modePreferenceStore={store}
          setupRequired
          thinConnectionPanel={<div data-testid="home-node-panel">Invite panel</div>}
        />,
      )
    })
    await flushReactWork()

    await act(async () => {
      choiceByText(container, 'Make this device available').click()
    })
    expect(buttonByText(container, 'Continue').disabled).toBe(true)

    await act(async () => {
      resolveModeWrite(true)
      await Promise.resolve()
    })
    expect(buttonByText(container, 'Continue').disabled).toBe(true)

    await act(async () => {
      resolveTierWrite(true)
      await Promise.resolve()
    })
    expect(buttonByText(container, 'Continue').disabled).toBe(false)

    root.unmount()
    container.remove()
  })

  it('saves the preselected Android device-sharing role before allowing setup to continue', async () => {
    const modes: string[] = []
    const tiers: string[] = []
    const store: OnboardingModePreferenceStore = {
      evidence: 'Saved with the Android connection profile',
      readSelectedMode: async () => null,
      readSelectedRuntimeTier: async () => null,
      writeSelectedMode: async (modeId) => {
        modes.push(modeId)
        return true
      },
      writeSelectedRuntimeTier: async (runtimeTier) => {
        tiers.push(runtimeTier)
        return true
      },
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <OnboardingView
          client={client('native-mobile')}
          snapshot={safeShellSnapshot({ nativePlatform: 'android', nativeAvailable: true })}
          modePreferenceStore={store}
          setupRequired
          thinConnectionPanel={<div data-testid="home-node-panel">Invite panel</div>}
        />,
      )
    })
    await flushReactWork()

    expect(activeChoiceText(container)).toContain('Make this device available')
    expect(modes).toEqual(['mesh-node'])
    expect(tiers).toEqual(['lightweight-ts'])
    expect(buttonByText(container, 'Continue').disabled).toBe(false)

    await act(async () => {
      root.render(
        <OnboardingView
          client={client('native-mobile')}
          snapshot={safeShellSnapshot({ nativePlatform: 'android', nativeAvailable: true })}
          modePreferenceStore={store}
          setupRequired
          thinConnectionPanel={<div data-testid="home-node-panel">Invite panel</div>}
        />,
      )
    })
    await flushReactWork()
    expect(modes).toEqual(['mesh-node'])
    expect(tiers).toEqual(['lightweight-ts'])
    expect(buttonByText(container, 'Continue').disabled).toBe(false)

    root.unmount()
    container.remove()
  })

  it('renders role choices for hosted web, desktop, Android, and iOS surfaces', () => {
    const surfaces = [
      ['hosted-web', client('http'), safeShellSnapshot({ nativePlatform: 'web' }), false],
      ['desktop-thin', client('mesh'), safeShellSnapshot({ nativePlatform: 'desktop' }), false],
      ['android', client('native-mobile'), safeShellSnapshot({ nativePlatform: 'android', nativeAvailable: true }), false],
      ['ios', client('native-mobile'), safeShellSnapshot({ nativePlatform: 'ios', nativeAvailable: true }), false],
      ['desktop-local', client('tauri-local'), safeShellSnapshot({ nativePlatform: 'desktop', nativeAvailable: true }), true],
    ] as const

    for (const [name, surfaceClient, surfaceSnapshot, includesLocalRun] of surfaces) {
      const text = visibleText(renderToStaticMarkup(<OnboardingView client={surfaceClient} snapshot={surfaceSnapshot} setupRequired />))
      expect(text, name).toContain('Connect to Aurora')
      expect(text, name).toContain('Make this device available')
      if (includesLocalRun) expect(text, name).toContain('Run Aurora on this computer')
      else expect(text, name).not.toContain('Run Aurora on this computer')
      expect(findForbiddenProductionCopyTerms(text).map((term) => term.id), name).toEqual([])
    }
  })

  it('restores legacy node modes into product choices and writes canonical node modes', async () => {
    const writes: string[] = []
    const tiers: string[] = []
    const store: OnboardingModePreferenceStore = {
      evidence: 'Saved for this device',
      readSelectedMode: async () => 'remote-console',
      readSelectedRuntimeTier: async () => 'none',
      writeSelectedMode: async (modeId) => {
        writes.push(modeId)
        return true
      },
      writeSelectedRuntimeTier: async (runtimeTier) => {
        tiers.push(runtimeTier)
        return true
      },
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(<OnboardingView client={client('http')} snapshot={safeShellSnapshot()} modePreferenceStore={store} setupRequired />)
    })
    await flushReactWork()

    expect(activeChoiceText(container)).toContain('Connect to Aurora')
    expect(container.textContent).not.toContain('remote-console')
    expect(writes).toEqual([])

    await act(async () => {
      choiceByText(container, 'Make this device available').click()
    })
    expect(writes).toEqual(['mesh-node'])
    expect(tiers).toEqual(['lightweight-ts'])

    root.unmount()
    container.remove()
  })

  it('gates saved local runtime choices until desktop local capability is available', async () => {
    const writes: string[] = []
    const tiers: string[] = []
    const store: OnboardingModePreferenceStore = {
      evidence: 'Saved for this device',
      readSelectedMode: async () => 'mesh-node',
      readSelectedRuntimeTier: async () => 'python-full',
      writeSelectedMode: async (modeId) => {
        writes.push(modeId)
        return true
      },
      writeSelectedRuntimeTier: async (runtimeTier) => {
        tiers.push(runtimeTier)
        return true
      },
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <OnboardingView
          client={client('tauri-local')}
          snapshot={safeShellSnapshot({ nativePlatform: 'desktop', nativeAvailable: false })}
          modePreferenceStore={store}
          setupRequired
        />,
      )
    })
    await flushReactWork()

    expect(container.textContent).not.toContain('Run Aurora on this computer')
    expect(activeChoiceText(container)).not.toContain('Run Aurora on this computer')
    expect(writes).toEqual([])

    await act(async () => {
      root.render(
        <OnboardingView
          client={client('tauri-local')}
          snapshot={safeShellSnapshot({ nativePlatform: 'desktop', nativeAvailable: true })}
          modePreferenceStore={store}
          setupRequired
        />,
      )
    })
    await flushReactWork()

    expect(container.textContent).toContain('Run Aurora on this computer')
    expect(activeChoiceText(container)).toContain('Run Aurora on this computer')

    await act(async () => {
      choiceByText(container, 'Run Aurora on this computer').click()
    })
    expect(writes).toEqual(['mesh-node'])
    expect(tiers).toEqual(['python-full'])

    root.unmount()
    container.remove()
  })

  it('maps raw connection diagnostics to product-safe copy', () => {
    const rawDiagnostic = 'WebRTC thin-client transport DataChannel failed'
    const text = visibleText(renderToStaticMarkup(
      <HomeNodeConnectionPanel
        peer={peerController({ status: 'failed', diagnostic: rawDiagnostic })}
        mode="webrtc-preferred"
        transportKind="http"
      />,
    ))

    expect(text).toContain('Could not connect to this Aurora device')
    expect(text).not.toContain(rawDiagnostic)
    expect(findForbiddenProductionCopyTerms(text).map((term) => term.id)).toEqual([])
  })

  it('maps hostile mesh trust and availability states before rendering device details', () => {
    const snapshot = meshSnapshot()
    snapshot.liveSessions = [{
      ...snapshot.liveSessions[0]!,
      pairingState: 'auth timeout pending',
      linkedPeerState: 'runtime peer authenticated',
      authState: 'authenticated',
    }]
    snapshot.peers = [{
      ...snapshot.peers[0]!,
      lifecycleLabel: 'runtime peer connected',
      trustLabel: 'outbound=approved; inbound=pending',
      connectionStatus: 'disconnected',
    }]
    snapshot.warnings = ['WebRTC transport DataChannel failed']

    const text = visibleText(renderToStaticMarkup(
      <MeshPeersView snapshot={snapshot} route={route()} canManageLocalServiceConfiguration={false} />,
    ))

    expect(text).toContain('Review required')
    expect(text).not.toContain('runtime peer')
    expect(text).not.toContain('outbound=')
    expect(text).not.toContain('DataChannel')
    expect(findForbiddenProductionCopyTerms(text).map((term) => term.id)).toEqual([])
  })

  it('maps hostile admin tool source policy and trust terms before rendering', () => {
    const snapshot: AdminPluginsSnapshot = {
      loadState: 'ready',
      policy: {
        mode: 'unrestricted_except_blocked',
        defaultBehavior: 'allow',
        activeGrantCount: 0,
        pendingApprovalCount: 1,
        blockedCount: 0,
        sourceCount: 1,
        bypassEnabled: true,
        dryRunOnly: false,
        denyAll: false,
        lastChanged: 'not reported',
        actor: 'Tooling.GetPolicySummary',
        evidence: 'Tooling.GetPolicySummary',
      },
      sourceSummaries: [],
      sourceDetails: {},
      fallbackTools: [],
      warnings: [],
      error: null,
      evidenceSource: 'Aurora',
    }
    const text = visibleText(renderToStaticMarkup(
      <AdminPluginsView
        client={client()}
        route={route()}
        initialSnapshot={{
          ...snapshot,
          sourceSummaries: [{
            id: 'source-1',
            label: 'External assistant tools',
            kind: 'mcp',
            providerKind: 'mcp',
            transport: 'stdio',
            providerPeerId: null,
            providerServiceInstanceId: null,
            trustTier: 'quarantined',
            configuredTrustTier: null,
            toolCount: 0,
            blockedToolCount: 0,
            approvalRequiredCount: 0,
            status: 'stale',
            cacheStatus: 'capability catalog fallback',
            catalogCacheState: null,
            lastAnnouncementAt: null,
            generatedAt: null,
          } as unknown as AdminPluginsSnapshot['sourceSummaries'][number]],
        }}
      />,
    ))

    expect(text).toContain('Review: Allow trusted')
    expect(text).toContain('Connected tool sources')
    expect(text).toContain('review needed')
    expect(text).not.toContain('unrestricted_except_blocked')
    expect(text).not.toContain('MCP')
    expect(text).not.toContain('capability catalog')
    expect(findForbiddenProductionCopyTerms(text).map((term) => term.id)).toEqual([])
  })

  it('maps hostile scheduler status and tool reasons before rendering', () => {
    const snapshot: AdminSchedulerSnapshot = {
      loadState: 'ready',
      jobs: [{
        id: 'job-1',
        name: 'Morning summary',
        schedule: '0 8 * * *',
        action: 'Orchestrator.ExternalUserInput',
        enabled: true,
        status: 'stale',
        namespace: 'home',
        ownership: 'local-owned',
        ownerLabel: 'local-peer/local-principal',
        targetLabel: 'local node',
        approvalLabel: 'approval is saved; no delegated permissions; approval record not reported',
        policyDecisionId: 'not reported',
        auditReceipt: 'audit pending',
        privacyClass: 'personal',
        nextRun: 'not scheduled',
        lastRun: 'never',
        runHistory: 'last never run; 0 failures; this device; timezone UTC',
        toolIntegration: 'Assistant external user input; delegated no delegated permissions',
        blockedReason: 'capability catalog fallback stale_provider',
        operationControls: [],
      }],
      createControl: {
        available: true,
        state: 'available-local',
        reason: 'Ready',
        requiresAdminAction: false,
        targetOptions: [],
      },
      totals: { local: 1, delegatedOwned: 0, remoteRunning: 0, foreignDenied: 0 },
      warnings: [],
      error: null,
      evidenceSource: 'Aurora',
      secretsRedacted: true,
      toolOptions: [{
        id: 'tool-1',
        label: 'Search (this device)',
        localName: 'Search',
        globalToolId: 'Search',
        providerPeerId: null,
        serviceInstanceId: null,
        disabled: false,
        reason: 'Available from reviewed Tools.',
      }],
    }
    const text = visibleText(renderToStaticMarkup(
      <AdminSchedulerView client={client()} route={route()} initialSnapshot={snapshot} />,
    ))

    expect(text).toContain('Assistant external user input')
    expect(text).not.toContain('Orchestrator.ExternalUserInput')
    expect(text).not.toContain('capability catalog')
    expect(text).not.toContain('stale_provider')
    expect(findForbiddenProductionCopyTerms(text).map((term) => term.id)).toEqual([])
  })
})

function visibleText(markup: string): string {
  return markup
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function client(kind: string = 'http'): AuroraClient {
  return {
    transport: { kind },
    auth: {
      refreshClock: () => ({
        state: 'anonymous',
        isAuthenticated: false,
        isTerminal: false,
        isMeshPeer: false,
        principalId: null,
        principalName: null,
        permissions: [],
      }),
      subscribe: () => () => undefined,
      setPairing: vi.fn(),
      setPairingChallenge: vi.fn(),
    },
    authApi: {
      login: vi.fn(),
      validateToken: vi.fn(),
      pairingStart: vi.fn(),
      pairingExchange: vi.fn(),
    },
  } as unknown as AuroraClient
}

function settingsSnapshot(): AuroraShellSnapshot {
  const graph = buildCapabilityGraph({
    catalog: capabilityGraphCatalogFixture,
    registry: gatewayRegistryFixture,
    nativeManifest: null,
    transportKind: 'http',
  })
  return snapshotFromGraph('http', graph, null)
}

function safeShellSnapshot(overrides: Partial<AuroraShellSnapshot> = {}): AuroraShellSnapshot {
  return {
    ...errorShellSnapshot('http', new Error('offline')),
    routes: [],
    routeCount: 0,
    blockedCount: 0,
    availableCount: 0,
    error: null,
    ...overrides,
  }
}

function route(): RouteAvailability {
  return {
    item: {
      id: 'mesh',
      label: 'Mesh',
      href: '/mesh',
      capabilityModule: 'Gateway',
      capabilityMethod: 'GetMeshStatus',
      methodType: 'use',
      privacyClass: 'personal',
      fallbackState: 'degraded',
      adminGated: false,
      expectedTask: 'MESH-001',
    },
    state: 'available-local',
    explanation: 'ready',
    providerLabel: 'This device',
    blockers: [],
    repairActions: [],
    candidateProviders: [],
    evidenceSources: [],
    selectorRequired: false,
    approvalRequired: false,
    routeable: true,
    disabled: false,
    requiresAdminAction: false,
  }
}

function peerController(overrides: Partial<BrowserWebRtcSnapshot> = {}): BrowserWebRtcPeerController {
  const snapshot: BrowserWebRtcSnapshot = {
    state: 'closed',
    connectionMode: 'webrtc-preferred',
    expectedStablePeerId: 'home-node',
    nodeName: 'Home Aurora',
    icePathCategory: 'unknown',
    protocolCapabilities: [],
    reconnectCount: 0,
    pendingCallCount: 0,
    pendingStreamCount: 0,
    pendingSubscriptionCount: 0,
    pendingFragmentCount: 0,
    bufferPressureHighWaterBytes: 0,
    sentFragmentCount: 0,
    receivedFragmentCount: 0,
    updatedAt: '2026-07-28T00:00:00Z',
    status: 'closed',
    secureContext: true,
    visible: true,
    focused: true,
    hasHttpFallback: true,
    secretsPersisted: true,
    persistenceBackend: 'platform-keychain',
    ...overrides,
  }
  return {
    snapshot: () => snapshot,
    subscribe: () => () => undefined,
    importInvite: vi.fn((invite: string) => webRtcProfileFromInvite(invite)),
    connect: vi.fn(),
    disconnect: vi.fn(),
    confirmPairing: vi.fn(),
    rejectPairing: vi.fn(),
  } as unknown as BrowserWebRtcPeerController
}

function firstRunInviteText(room = 'first-run-room') {
  return encodeMeshInviteUrl({
    kind: 'aurora.mesh.invite',
    version: 1,
    node: { node_name: 'Home Aurora', peer_id: 'home-peer' },
    signaling: {
      provider: 'mqtt',
      mqtt_brokers: ['wss://broker.example/mqtt'],
      room,
      room_password: 'secret-room-password',
    },
    generated_at: '2026-07-30T00:00:00Z',
  })
}

function meshSnapshot(): MeshPeersSnapshot {
  return {
    loadState: 'ready',
    generatedAt: '2026-07-28T00:00:00Z',
    localPeerId: 'local-peer',
    localNodeName: 'Home Aurora',
    meshEnabled: false,
    meshStarted: false,
    webrtcStarted: false,
    inviteConfig: null,
    secretsRedacted: true,
    peers: [{
      peerId: 'peer-studio',
      nodeName: 'Studio Aurora',
      roomName: 'Private room',
      lifecycleState: 'available-remote',
      lifecycleLabel: 'Ready',
      trustState: 'available-remote',
      trustLabel: 'approved',
      outboundStatus: 'approved',
      inboundStatus: 'approved',
      connectionStatus: 'connected',
      fingerprint: 'peer-studio',
      permissions: ['TTS.use'],
      inboundPermissions: ['TTS.use'],
      latencyMs: 12,
      routeQuality: 'Ready',
      compatibility: 'Ready',
      serviceCount: 1,
      services: ['TTS'],
      lastSeen: '2026-07-28T00:00:00Z',
      lastEvidenceSource: 'Aurora',
      pendingPairing: null,
      approveAction: null,
      denyAction: null,
      removeAction: null,
    }],
    pendingRequests: [],
    liveSessions: [{
      sessionId: 'session-1',
      stablePeerId: 'peer-studio',
      nodeName: 'Studio Aurora',
      pairingSessionId: null,
      verificationCode: null,
      state: 'available-remote',
      connectionState: 'connected',
      iceState: 'connected',
      dataChannelState: 'open',
      authState: 'authenticated',
      latencyMs: 12,
      identitySource: 'saved',
      permissions: 'Ready',
      pairingState: 'Ready',
      linkedPeerState: 'Ready',
      evidenceSource: 'Aurora',
    }],
    devices: [{
      deviceId: 'device-1',
      name: 'Studio Aurora',
      principalId: 'principal-1',
      state: 'available-local',
      trustLabel: 'Trusted',
      linkedPeerId: 'peer-studio',
      linkedPeerLabel: 'Studio Aurora',
      lastSeen: '2026-07-28T00:00:00Z',
      evidenceSource: 'Aurora',
    }],
    pendingCount: 0,
    approvedCount: 1,
    deniedCount: 0,
    removedCount: 0,
    runtimePeerCount: 1,
    liveSessionCount: 1,
    deviceCount: 1,
    routeCount: 1,
    compatibilityFailures: [],
    listState: 'available-local',
    listReason: 'No peers found.',
    statusState: 'available-local',
    statusReason: 'Mesh is off.',
    mutationState: 'available-local',
    mutationReason: 'Changes are available.',
    config: {
      fields: [
        {
          key_path: 'services.gateway.mesh_network.enabled',
          title: 'Mesh enabled',
          description: 'Turn approved device connections on or off.',
          type: 'boolean',
          current_value: true,
          default: true,
          secret: false,
          source_layer: 'user',
          reload_required: false,
          restart_required: false,
          affected_services: [],
          constraints: {},
        },
      ],
      state: 'available-local',
      reason: 'Settings are available.',
      secretsRedacted: true,
      editable: true,
      warnings: [],
    },
    warnings: [],
    error: null,
    evidenceSource: 'Aurora',
    transportKind: 'http',
    fixtureOnly: false,
  }
}

function serviceRoutingSnapshot(): ServiceRoutingSnapshot {
  return {
    loadState: 'ready',
    rows: [{
      id: 'tts',
      label: 'Text to speech',
      basePath: 'services.tts',
      sharingPath: 'services.tts.mesh_sharing',
      routingPath: 'services.tts.mesh_routing',
      registryStatus: 'healthy',
      registryVersion: '1.0.0',
      registered: true,
      exportPolicy: { share: true, maxConcurrent: 2, unsharedFeatureIds: [], unsharedMethodIds: [] },
      routingPolicy: { prefer: 'local', fallback: 'network', allowedProviderPeerIds: ['peer-studio'], minVersion: null, requiredProviderFeatureIds: [], requiredProviderCapabilityTags: [], requireExplicitSelector: false },
      exportFeatures: [{ featureId: 'speech', label: 'Speech', summary: 'Speak responses aloud.', stale: false, methods: [{ topic: 'TTS.Speak', label: 'Speak', summary: 'Speak responses aloud.' }] }],
      ungroupedMethods: [],
      staleMethodIds: [],
      providerOptions: [{ id: 'peer-studio', label: 'Studio Aurora', stale: false }],
      remoteFeatureOptions: [{ id: 'speech', label: 'Speech', stale: false }],
      remoteCapabilityTagOptions: [{ id: 'audio', label: 'Audio', stale: false }],
    }],
    knownPeers: [{ peerId: 'peer-studio', label: 'Studio Aurora' }],
    editable: true,
    registryMode: 'thread',
    warnings: [],
    error: null,
    evidenceSource: 'Aurora',
  }
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((candidate) => candidate.textContent?.trim() === text)
  if (!button) throw new Error(`Button not found: ${text}`)
  return button
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function choiceByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button[role="radio"]')).find((candidate) => candidate.textContent?.includes(text))
  if (!button) throw new Error(`Choice not found: ${text}`)
  return button
}

function activeChoiceText(container: HTMLElement): string {
  return container.querySelector<HTMLButtonElement>('button[role="radio"][aria-checked="true"]')?.textContent ?? ''
}

async function flushReactWork() {
  await act(async () => {
    await Promise.resolve()
  })
}
