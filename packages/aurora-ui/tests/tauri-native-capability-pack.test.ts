import { describe, expect, it, vi } from 'vitest'
import {
  AuroraError,
  androidNativeCapabilityManifestFixture,
  iosNativeCapabilityManifestFixture,
  nativeCapabilityManifestFixture,
  type AndroidVoiceForegroundServiceRequestResult,
  type AndroidVoiceForegroundServiceStatus,
  type NativeCapabilityManifest,
  type TauriSidecarStatus
} from '@aurora/client'
import {
  AURORA_NATIVE_TOOL_IDS,
  LocalToolExecutionPolicy,
  LocalToolRegistry,
  createLocalToolingProviderHandlers
} from '@aurora/client/local-tools'

import {
  registerTauriNativeCapabilityPack,
  type TauriNativeCapabilityTransport
} from '../src/index'

type PeerHostCallContext = Parameters<ReturnType<typeof createLocalToolingProviderHandlers>['executeTool']>[1]

describe('tauri native capability pack adapter', () => {
  it('advertises only bounded device status from a successful desktop manifest', async () => {
    const registry = new LocalToolRegistry({ stablePeerId: 'desktop-peer' })
    const manifest: NativeCapabilityManifest = {
      ...nativeCapabilityManifestFixture,
      permissions: {
        ...nativeCapabilityManifestFixture.permissions,
        'aurora.notificationsSend': true,
        'aurora.localFileRead': true,
        'aurora.localFileWrite': true
      },
      capabilities: {
        ...nativeCapabilityManifestFixture.capabilities,
        'native.notifications': true,
        'native.filesystem': true,
        'native.audioCapture': true
      },
      permissionStates: {
        ...nativeCapabilityManifestFixture.permissionStates,
        'aurora.nativeCapabilityManifest': 'available'
      },
      capabilityStates: {
        ...nativeCapabilityManifestFixture.capabilityStates,
        'native.permissionsManifest': 'available'
      }
    }
    const transport = transportFor({ manifest, sidecar: { running: true } })

    const result = await registerTauriNativeCapabilityPack({ registry, transport })

    expect(result.registered).toEqual([AURORA_NATIVE_TOOL_IDS.getDeviceStatus])
    expect(registry.publicTools().map((tool) => tool.tool_contract_id)).toEqual([AURORA_NATIVE_TOOL_IDS.getDeviceStatus])
    expect(registry.publicTools()[0]).toMatchObject({
      confirmation_required: false,
      required_permissions: ['Native.GetDeviceStatus'],
      share_group_id: 'native.deviceStatus'
    })
    expect(JSON.stringify(registry.publicTools())).not.toMatch(/share_text|open_deep_link|notification|clipboard|document|voice_capture/u)
    const descriptor = registry.resolvePublicId(AURORA_NATIVE_TOOL_IDS.getDeviceStatus)!.descriptor
    expect(JSON.stringify(descriptor.argsSchema)).not.toMatch(/shell|process|command|path|manifest|details/u)
    expect(JSON.stringify(descriptor.outputSchema)).not.toMatch(/shell|process|command|path|manifest|permissions|details/u)

    const provider = providerFor(registry)
    const response = await provider.executeTool({
      tool_name: AURORA_NATIVE_TOOL_IDS.getDeviceStatus,
      arguments: {}
    }, context(['Tooling.ExecuteTool', 'Native.GetDeviceStatus']))

    expect(response).toMatchObject({
      ok: true,
      status: 'success',
      data: {
        platform: 'tauri-desktop',
        online: true
      }
    })
    expect(response.data).toHaveProperty('availableCapabilities')
    expect(JSON.stringify(response.data)).not.toMatch(/manifest|permissions|details|pid|gatewayUrl|lastError/u)
  })

  it('fails closed when manifest evidence is missing or permission state is not available', async () => {
    const missingRegistry = new LocalToolRegistry({ stablePeerId: 'missing-peer' })
    await expect(registerTauriNativeCapabilityPack({
      registry: missingRegistry,
      transport: transportFor({ manifestError: true })
    })).resolves.toEqual({ registered: [] })
    expect(missingRegistry.publicTools()).toEqual([])

    const deniedRegistry = new LocalToolRegistry({ stablePeerId: 'denied-peer' })
    await registerTauriNativeCapabilityPack({
      registry: deniedRegistry,
      transport: transportFor({
        manifest: {
          ...nativeCapabilityManifestFixture,
          permissionStates: {
            ...nativeCapabilityManifestFixture.permissionStates,
            'aurora.nativeCapabilityManifest': 'needs_native_permission'
          }
        }
      })
    })
    expect(deniedRegistry.publicTools()).toEqual([])
  })

  it('requires explicit state proof even when manifest booleans are true', async () => {
    const desktopRegistry = new LocalToolRegistry({ stablePeerId: 'desktop-missing-states' })
    await registerTauriNativeCapabilityPack({
      registry: desktopRegistry,
      transport: transportFor({
        manifest: {
          ...nativeCapabilityManifestFixture,
          permissions: {
            ...nativeCapabilityManifestFixture.permissions,
            'aurora.nativeCapabilityManifest': true
          },
          capabilities: {
            ...nativeCapabilityManifestFixture.capabilities,
            'native.permissionsManifest': true
          },
          permissionStates: {},
          capabilityStates: {}
        }
      })
    })
    expect(desktopRegistry.publicTools()).toEqual([])

    const status = readyVoiceStatus()
    const androidRegistry = new LocalToolRegistry({ stablePeerId: 'android-missing-states' })
    await registerTauriNativeCapabilityPack({
      registry: androidRegistry,
      transport: transportFor({
        manifest: {
          ...readyAndroidManifest(status),
          permissionStates: {
            'aurora.nativeCapabilityManifest': 'available'
          },
          capabilityStates: {
            'native.permissionsManifest': 'available'
          }
        },
        foregroundStatus: status
      })
    })
    expect(androidRegistry.publicTools().map((tool) => tool.tool_contract_id)).toEqual([
      AURORA_NATIVE_TOOL_IDS.getDeviceStatus
    ])

    const explicitRegistry = new LocalToolRegistry({ stablePeerId: 'android-explicit-states' })
    await registerTauriNativeCapabilityPack({
      registry: explicitRegistry,
      transport: transportFor({
        manifest: readyAndroidManifest(status),
        foregroundStatus: status
      })
    })
    expect(explicitRegistry.publicTools().map((tool) => tool.tool_contract_id).sort()).toEqual([
      AURORA_NATIVE_TOOL_IDS.getDeviceStatus,
      AURORA_NATIVE_TOOL_IDS.startForegroundVoiceCapture
    ].sort())
  })

  it('registers Android foreground voice only when manifest and service status prove it startable', async () => {
    const registry = new LocalToolRegistry({ stablePeerId: 'android-peer' })
    const status = readyVoiceStatus()
    const manifest = readyAndroidManifest(status)
    const transport = transportFor({
      manifest,
      foregroundStatus: status,
      startResult: { started: true, status, reason: 'started' }
    })

    await registerTauriNativeCapabilityPack({ registry, transport })

    expect(registry.publicTools().map((tool) => tool.tool_contract_id).sort()).toEqual([
      AURORA_NATIVE_TOOL_IDS.getDeviceStatus,
      AURORA_NATIVE_TOOL_IDS.startForegroundVoiceCapture
    ].sort())
    expect(registry.publicTools().find((tool) => tool.tool_contract_id === AURORA_NATIVE_TOOL_IDS.startForegroundVoiceCapture)).toMatchObject({
      confirmation_required: true,
      required_permissions: ['Native.StartForegroundVoiceCapture'],
      share_group_id: 'android.voiceForegroundService.start'
    })

    const policy = policyFor()
    const provider = providerFor(registry, policy)
    const request = { tool_name: AURORA_NATIVE_TOOL_IDS.startForegroundVoiceCapture, arguments: {} }
    const prepared = await policy.prepare(
      registry.resolveForDispatch(AURORA_NATIVE_TOOL_IDS.startForegroundVoiceCapture)!,
      request,
      execution(['Tooling.ExecuteTool', 'Native.StartForegroundVoiceCapture'])
    )
    const approvalToken = policy.issueApprovalToken(
      prepared,
      request,
      execution(['Tooling.ExecuteTool', 'Native.StartForegroundVoiceCapture'])
    )

    await expect(provider.executeTool({
      ...request,
      approval_token: approvalToken
    }, context(['Tooling.ExecuteTool', 'Native.StartForegroundVoiceCapture']))).resolves.toMatchObject({
      ok: true,
      status: 'success',
      data: { started: true }
    })
    expect(transport.startAndroidVoiceForegroundService).toHaveBeenCalledTimes(1)
  })

  it('requires local approval before invoking Android foreground voice', async () => {
    const registry = new LocalToolRegistry({ stablePeerId: 'android-peer' })
    const status = readyVoiceStatus()
    const transport = transportFor({
      manifest: readyAndroidManifest(status),
      foregroundStatus: status,
      startResult: { started: true, status, reason: 'started' }
    })
    await registerTauriNativeCapabilityPack({ registry, transport })
    const provider = providerFor(registry)

    await expect(provider.executeTool({
      tool_name: AURORA_NATIVE_TOOL_IDS.startForegroundVoiceCapture,
      arguments: {}
    }, context(['Tooling.ExecuteTool', 'Native.StartForegroundVoiceCapture']))).resolves.toMatchObject({
      ok: false,
      status: 'denied'
    })
    expect(transport.startAndroidVoiceForegroundService).not.toHaveBeenCalled()
  })

  it('omits Android foreground voice unless both manifest and current status are available', async () => {
    const missingStatusRegistry = new LocalToolRegistry({ stablePeerId: 'android-missing-status' })
    await registerTauriNativeCapabilityPack({
      registry: missingStatusRegistry,
      transport: transportFor({
        manifest: readyAndroidManifest(readyVoiceStatus()),
        foregroundStatusError: true
      })
    })
    expect(missingStatusRegistry.publicTools().map((tool) => tool.tool_contract_id)).toEqual([
      AURORA_NATIVE_TOOL_IDS.getDeviceStatus
    ])

    const deniedStatusRegistry = new LocalToolRegistry({ stablePeerId: 'android-denied-status' })
    await registerTauriNativeCapabilityPack({
      registry: deniedStatusRegistry,
      transport: transportFor({
        manifest: readyAndroidManifest(readyVoiceStatus()),
        foregroundStatus: {
          ...readyVoiceStatus(),
          startable: false,
          state: 'needs_native_permission',
          microphoneGranted: false
        }
      })
    })
    expect(deniedStatusRegistry.publicTools().map((tool) => tool.tool_contract_id)).toEqual([
      AURORA_NATIVE_TOOL_IDS.getDeviceStatus
    ])

    const foregroundOnlyRegistry = new LocalToolRegistry({ stablePeerId: 'android-foreground-only' })
    await registerTauriNativeCapabilityPack({
      registry: foregroundOnlyRegistry,
      transport: transportFor({
        manifest: readyAndroidManifest(readyVoiceStatus()),
        foregroundStatus: {
          ...readyVoiceStatus(),
          running: true,
          startable: false,
          state: 'degraded',
          reason: 'native_voice_route_missing',
          backendAudioEvidenceRequired: true
        }
      })
    })
    expect(foregroundOnlyRegistry.publicTools().map((tool) => tool.tool_contract_id)).toEqual([
      AURORA_NATIVE_TOOL_IDS.getDeviceStatus
    ])

    const deniedManifestRegistry = new LocalToolRegistry({ stablePeerId: 'android-denied-manifest' })
    await registerTauriNativeCapabilityPack({
      registry: deniedManifestRegistry,
      transport: transportFor({
        manifest: {
          ...readyAndroidManifest(readyVoiceStatus()),
          permissions: {
            ...readyAndroidManifest(readyVoiceStatus()).permissions,
            'aurora.android.voiceForegroundStart': false
          }
        },
        foregroundStatus: readyVoiceStatus()
      })
    })
    expect(deniedManifestRegistry.publicTools().map((tool) => tool.tool_contract_id)).toEqual([
      AURORA_NATIVE_TOOL_IDS.getDeviceStatus
    ])
  })

  it('rechecks native state at execution and returns structured denial without raw details', async () => {
    const registry = new LocalToolRegistry({ stablePeerId: 'android-peer' })
    const status = readyVoiceStatus()
    const manifest = readyAndroidManifest(status)
    const transport = transportFor({
      manifest,
      foregroundStatus: status,
      startResult: { started: true, status, reason: 'started' }
    })
    await registerTauriNativeCapabilityPack({ registry, transport })
    transport.getAndroidVoiceForegroundServiceStatus.mockResolvedValueOnce({
      ...status,
      state: 'needs_native_permission',
      startable: false,
      microphoneGranted: false
    })
    const policy = policyFor()
    const provider = providerFor(registry, policy)
    const request = { tool_name: AURORA_NATIVE_TOOL_IDS.startForegroundVoiceCapture, arguments: {} }
    const prepared = await policy.prepare(
      registry.resolveForDispatch(AURORA_NATIVE_TOOL_IDS.startForegroundVoiceCapture)!,
      request,
      execution(['Tooling.ExecuteTool', 'Native.StartForegroundVoiceCapture'])
    )
    const approvalToken = policy.issueApprovalToken(
      prepared,
      request,
      execution(['Tooling.ExecuteTool', 'Native.StartForegroundVoiceCapture'])
    )

    const response = await provider.executeTool({
      ...request,
      approval_token: approvalToken
    }, context(['Tooling.ExecuteTool', 'Native.StartForegroundVoiceCapture']))

    expect(response).toMatchObject({
      ok: false,
      status: 'failed',
      error_code: 'permission_unavailable',
      error: 'Tool execution failed'
    })
    expect(JSON.stringify(response)).not.toMatch(/manifest|permissions|details|microphone_permission_missing/u)
    expect(transport.startAndroidVoiceForegroundService).not.toHaveBeenCalled()
  })

  it('registers only manifest-proven Android and iOS outgoing actions', async () => {
    for (const platform of ['android', 'ios'] as const) {
      const registry = new LocalToolRegistry({ stablePeerId: `${platform}-actions` })
      const transport = transportFor({ manifest: readyNativeActionsManifest(platform) })

      const result = await registerTauriNativeCapabilityPack({ registry, transport })

      expect(result.registered).toEqual(expect.arrayContaining([
        AURORA_NATIVE_TOOL_IDS.shareText,
        AURORA_NATIVE_TOOL_IDS.openDeepLink,
        AURORA_NATIVE_TOOL_IDS.showNotification
      ]))
      for (const toolId of [
        AURORA_NATIVE_TOOL_IDS.shareText,
        AURORA_NATIVE_TOOL_IDS.openDeepLink,
        AURORA_NATIVE_TOOL_IDS.showNotification
      ]) {
        expect(registry.resolvePublicId(toolId)?.toolInfo).toMatchObject({
          confirmation_required: true
        })
      }
      expect(registry.resolvePublicId(AURORA_NATIVE_TOOL_IDS.shareText)?.descriptor.nativeRequirements.capabilityIds)
        .toEqual([`${platform}.shareText`])
    }

    const desktopRegistry = new LocalToolRegistry({ stablePeerId: 'desktop-actions' })
    await registerTauriNativeCapabilityPack({
      registry: desktopRegistry,
      transport: transportFor({ manifest: nativeCapabilityManifestFixture })
    })
    expect(desktopRegistry.publicTools().map((tool) => tool.tool_contract_id)).not.toEqual(expect.arrayContaining([
      AURORA_NATIVE_TOOL_IDS.shareText,
      AURORA_NATIVE_TOOL_IDS.openDeepLink,
      AURORA_NATIVE_TOOL_IDS.showNotification
    ]))
  })

  it('requires local approval and maps revoked native permission to a structured denial', async () => {
    const registry = new LocalToolRegistry({ stablePeerId: 'android-actions' })
    const transport = transportFor({ manifest: readyNativeActionsManifest('android') })
    await registerTauriNativeCapabilityPack({ registry, transport })
    const policy = policyFor()
    const provider = providerFor(registry, policy)
    const request = {
      tool_name: AURORA_NATIVE_TOOL_IDS.shareText,
      arguments: { text: 'hello' }
    }
    const permissions = ['Tooling.ExecuteTool', 'Native.ShareText']

    await expect(provider.executeTool(request, context(permissions))).resolves.toMatchObject({
      ok: false,
      status: 'denied'
    })
    expect(transport.shareNativeText).not.toHaveBeenCalled()

    const prepared = await policy.prepare(
      registry.resolveForDispatch(AURORA_NATIVE_TOOL_IDS.shareText)!,
      request,
      execution(permissions)
    )
    const approvalToken = policy.issueApprovalToken(prepared, request, execution(permissions))
    transport.shareNativeText.mockRejectedValueOnce(new AuroraError({
      code: 'permission',
      message: 'permission denied'
    }))

    await expect(provider.executeTool({
      ...request,
      approval_token: approvalToken
    }, context(permissions))).resolves.toMatchObject({
      ok: false,
      status: 'failed',
      error_code: 'permission_denied',
      error: 'Tool execution failed'
    })
    expect(transport.shareNativeText).toHaveBeenCalledWith({ text: 'hello' })
  })
})

function transportFor(input: {
  manifest?: NativeCapabilityManifest
  manifestError?: boolean
  sidecar?: Partial<TauriSidecarStatus>
  foregroundStatus?: AndroidVoiceForegroundServiceStatus
  foregroundStatusError?: boolean
  startResult?: AndroidVoiceForegroundServiceRequestResult
  shareResult?: { shared: boolean }
  openResult?: { opened: boolean }
  notificationResult?: { shown: boolean }
}) {
  const status = input.foregroundStatus ?? readyVoiceStatus()
  return {
    getNativeCapabilityManifest: vi.fn(async () => {
      if (input.manifestError) throw new Error('missing')
      return input.manifest ?? nativeCapabilityManifestFixture
    }),
    getSidecarStatus: vi.fn(async () => ({ running: false, ...input.sidecar })),
    getAndroidVoiceForegroundServiceStatus: vi.fn(async () => {
      if (input.foregroundStatusError) throw new Error('missing')
      return status
    }),
    startAndroidVoiceForegroundService: vi.fn(async () => input.startResult ?? { started: true, status, reason: 'started' }),
    shareNativeText: vi.fn(async () => input.shareResult ?? { shared: true }),
    openNativeDeepLink: vi.fn(async () => input.openResult ?? { opened: true }),
    showNativeNotification: vi.fn(async () => input.notificationResult ?? { shown: true })
  } satisfies TauriNativeCapabilityTransport & {
    getNativeCapabilityManifest: ReturnType<typeof vi.fn<() => Promise<NativeCapabilityManifest>>>
    getSidecarStatus: ReturnType<typeof vi.fn<() => Promise<TauriSidecarStatus>>>
    getAndroidVoiceForegroundServiceStatus: ReturnType<typeof vi.fn<() => Promise<AndroidVoiceForegroundServiceStatus>>>
    startAndroidVoiceForegroundService: ReturnType<typeof vi.fn<() => Promise<AndroidVoiceForegroundServiceRequestResult>>>
    shareNativeText: ReturnType<typeof vi.fn<(request: { text: string, title?: string }) => Promise<{ shared: boolean }>>>
    openNativeDeepLink: ReturnType<typeof vi.fn<(request: { url: string }) => Promise<{ opened: boolean }>>>
    showNativeNotification: ReturnType<typeof vi.fn<(request: { title: string, body?: string }) => Promise<{ shown: boolean }>>>
  }
}

function readyNativeActionsManifest(platform: 'android' | 'ios'): NativeCapabilityManifest {
  const base = platform === 'android'
    ? androidNativeCapabilityManifestFixture
    : iosNativeCapabilityManifestFixture
  return {
    ...base,
    platform,
    permissions: {
      ...base.permissions,
      'aurora.nativeCapabilityManifest': true,
      [`aurora.${platform}.shareText`]: true,
      [`aurora.${platform}.openDeepLink`]: true,
      [`aurora.${platform}.showNotification`]: true
    },
    capabilities: {
      ...base.capabilities,
      'native.permissionsManifest': true,
      [`${platform}.shareText`]: true,
      [`${platform}.openDeepLink`]: true,
      [`${platform}.showNotification`]: true
    },
    permissionStates: {
      ...base.permissionStates,
      'aurora.nativeCapabilityManifest': 'available',
      [`aurora.${platform}.shareText`]: 'available',
      [`aurora.${platform}.openDeepLink`]: 'available',
      [`aurora.${platform}.showNotification`]: 'available'
    },
    capabilityStates: {
      ...base.capabilityStates,
      'native.permissionsManifest': 'available',
      [`${platform}.shareText`]: 'available',
      [`${platform}.openDeepLink`]: 'available',
      [`${platform}.showNotification`]: 'available'
    }
  }
}

function readyAndroidManifest(status: AndroidVoiceForegroundServiceStatus): NativeCapabilityManifest {
  return {
    ...androidNativeCapabilityManifestFixture,
    permissions: {
      ...androidNativeCapabilityManifestFixture.permissions,
      'aurora.nativeCapabilityManifest': true,
      'aurora.android.microphone': true,
      'aurora.android.notifications': true,
      'aurora.android.foregroundServiceMicrophone': true,
      'aurora.android.voiceForegroundService': true,
      'aurora.android.voiceForegroundStart': true
    },
    capabilities: {
      ...androidNativeCapabilityManifestFixture.capabilities,
      'native.permissionsManifest': true,
      'android.microphoneCapture': true,
      'android.foregroundService': true,
      'android.voiceForegroundService': true,
      'android.voiceForegroundService.start': true
    },
    permissionStates: {
      ...androidNativeCapabilityManifestFixture.permissionStates,
      'aurora.nativeCapabilityManifest': 'available',
      'aurora.android.microphone': 'available',
      'aurora.android.notifications': 'available',
      'aurora.android.foregroundServiceMicrophone': 'available',
      'aurora.android.voiceForegroundService': 'available',
      'aurora.android.voiceForegroundStart': 'available'
    },
    capabilityStates: {
      ...androidNativeCapabilityManifestFixture.capabilityStates,
      'native.permissionsManifest': 'available',
      'android.microphoneCapture': 'available',
      'android.foregroundService': 'available',
      'android.voiceForegroundService': 'available',
      'android.voiceForegroundService.start': 'available'
    },
    voiceForegroundService: status
  }
}

function readyVoiceStatus(): AndroidVoiceForegroundServiceStatus {
  return {
    platform: 'android',
    running: false,
    startable: true,
    microphoneGranted: true,
    notificationsGranted: true,
    foregroundServiceReady: true,
    manifestReady: true,
    state: 'available',
    reason: 'ready',
    privacyClass: 'raw-audio',
    backendAudioEvidenceRequired: true,
    evidenceSource: 'test',
    secretsRedacted: true
  }
}

function providerFor(registry: LocalToolRegistry, policy = policyFor()) {
  return createLocalToolingProviderHandlers({
    registry,
    policy,
    providerPeerId: 'provider',
    serviceInstanceId: 'local:provider:Tooling',
    audit: () => undefined,
    exportDecision: { isShared: () => true }
  })
}

function policyFor() {
  return new LocalToolExecutionPolicy({
    providerPeerId: 'provider',
    providerServiceInstanceId: 'local:provider:Tooling',
    randomToken: () => 'fixed',
    nowMs: () => 1_000,
    ports: {
      hasMethodGrant: (methodId) => methodId === 'Tooling.ExecuteTool',
      hasToolGrant: () => true,
      hasCapabilityGrant: () => true,
      hasResourceGrant: () => true
    }
  })
}

function execution(permissions: string[]) {
  return {
    callerPeerId: 'peer-a',
    callerPrincipalId: 'principal-a',
    permissions,
    methodId: 'Tooling.ExecuteTool',
    nowMs: 1_000
  }
}

function context(permissions: string[]): PeerHostCallContext {
  return {
    id: 'call-1',
    methodId: 'Tooling.ExecuteTool',
    remotePeerId: 'peer-a',
    identity: {
      callerPeerId: 'peer-a',
      principalId: 'principal-a',
      effectivePermissions: permissions,
      authGrantRevision: 1,
      manifestRevision: 1
    },
    signal: new AbortController().signal,
    receivedAtMs: 1_000,
    deadlineAtMs: 31_000
  }
}
