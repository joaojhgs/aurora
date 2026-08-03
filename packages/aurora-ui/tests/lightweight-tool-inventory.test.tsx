// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import {
  AuroraClient,
  MockAuroraTransport,
  normalizeToolCatalog,
  type ToolCatalogEntry,
  type ToolingProjectionToolInfo,
} from '@aurora/client'
import {
  LightweightToolApprovalPanel,
  applyLocalToolSharingMutation,
  buildLocalToolSharingManagement,
  auroraNavSections,
  navItemSnapshot,
  type LocalFeatureSharingPort,
  type LocalFeatureSharingSnapshot,
  type LocalToolApprovalPolicySnapshot,
  type RouteAvailability,
} from '../src'

const LOCAL_FEATURE_ID = 'Native.GetDeviceStatus'
const TOOLING_SERVICE = {
  serviceId: 'tooling',
  servicePermissionId: 'Tooling.use',
  serviceLabel: 'Tools',
  serviceDescription: 'Use tools this device makes available.',
} as const

function projectionTool(overrides: Partial<ToolingProjectionToolInfo> = {}): ToolingProjectionToolInfo {
  return {
    name: 'get_device_status',
    local_name: 'get_device_status',
    global_tool_id: 'aurora-tool:v1:peer-waydroid:Native.GetDeviceStatus',
    tool_id_scheme: 'aurora-tool',
    tool_id_version: 1,
    tool_contract_id: LOCAL_FEATURE_ID,
    share_group_id: 'android.device',
    share_group_label: 'Device',
    legacy_global_tool_ids: [],
    exportable: true,
    provider_peer_id: 'peer-waydroid',
    provider_service_instance_id: 'local:peer-waydroid:Tooling',
    provider_label: 'Waydroid',
    provider_granted_permissions: ['Native.GetDeviceStatus'],
    provider_available: true,
    namespace: 'native',
    display_name: 'Device status',
    aliases: [],
    description: 'Read device status.',
    args_schema: {},
    schema: {},
    argument_visibility: {},
    source_type: 'local',
    source: 'core',
    source_id: 'native:waydroid',
    trust_tier: 'trusted',
    capability_class: 'local-native',
    resource_scope: [],
    execution_location: 'local',
    safety_class: 'read',
    risk_class: 'read',
    data_egress: false,
    mutating: false,
    external: false,
    admin: false,
    privacy_hints: [],
    required_permissions: ['Native.GetDeviceStatus'],
    confirmation_required: false,
    provenance: {
      stable_source_id: 'native:waydroid',
      provider_peer_id: 'peer-waydroid',
      provider_service_instance_id: 'local:peer-waydroid:Tooling',
      provider_tool_id: LOCAL_FEATURE_ID,
      advertised_name: 'get_device_status',
      source_type: 'local',
    },
    ...overrides,
  }
}

function remoteProjectionTool(): ToolingProjectionToolInfo {
  return projectionTool({
    name: 'read_calendar',
    local_name: 'read_calendar',
    global_tool_id: 'aurora-tool:v1:peer-home:Calendar.Read',
    tool_contract_id: 'Calendar.Read',
    share_group_id: 'calendar',
    share_group_label: 'Calendar',
    provider_peer_id: 'peer-home',
    provider_service_instance_id: 'tooling-home',
    provider_label: 'Home Aurora',
    provider_granted_permissions: ['Calendar.read'],
    display_name: 'Read calendar',
    description: 'Read calendar events.',
    source_type: 'mesh_peer',
    source: 'mesh_peer',
    source_id: 'mesh:peer-home:tooling-home',
    execution_location: 'remote',
    capability_class: 'remote-service',
    required_permissions: ['Calendar.read'],
    provenance: {
      stable_source_id: 'mesh:peer-home:tooling-home',
      provider_peer_id: 'peer-home',
      provider_service_instance_id: 'tooling-home',
      provider_tool_id: 'Calendar.Read',
      advertised_name: 'read_calendar',
      source_type: 'mesh_peer',
    },
  })
}

function sharingSnapshot(enabled = true): LocalFeatureSharingSnapshot {
  return {
    features: [{
      ...TOOLING_SERVICE,
      id: LOCAL_FEATURE_ID,
      label: 'Device status',
      description: 'Read device status.',
      enabled,
      available: true,
      requiresAuroraOpen: true,
      requiresLocalConfirmation: false,
    }],
    approvedDevices: [{
      peerId: 'peer-home',
      peerLabel: 'Home Aurora',
      featureIds: enabled ? [LOCAL_FEATURE_ID] : [],
      expiresAtMs: null,
    }],
  }
}

function toolsRoute(): RouteAvailability {
  const item = auroraNavSections.flatMap((section) => section.items)
    .find((candidate) => candidate.id === 'tools')!
  return {
    item: navItemSnapshot(item),
    state: 'unsupported',
    explanation: 'not connected',
    providerLabel: 'Unavailable',
    blockers: [],
    repairActions: [],
    candidateProviders: [],
    evidenceSources: [],
    selectorRequired: false,
    approvalRequired: false,
    routeable: false,
    disabled: true,
    requiresAdminAction: false,
  }
}

describe('lightweight node tool inventory', () => {
  it('stays on the local-node Tools surface while local sharing is temporarily unavailable', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport() })
    const loadPolicy = vi.spyOn(client.tools, 'getPolicySummary')
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <LightweightToolApprovalPanel
          client={client}
          route={toolsRoute()}
          localTools={[projectionTool()]}
          nativePlatform="android"
        />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Device status')
    expect(container.textContent).not.toContain('Tools are unavailable')
    expect(container.textContent).not.toContain('Add MCP source')
    expect(loadPolicy).not.toHaveBeenCalled()
    await act(async () => root.unmount())
  })

  it('renders local native tools and peer-shared tools through the canonical Tools console', async () => {
    const port: LocalFeatureSharingPort = {
      load: vi.fn(async () => sharingSnapshot()),
      setFeatureEnabled: vi.fn(async () => undefined),
      replacePeerSharing: vi.fn(async () => undefined),
      revokePeerSharing: vi.fn(async () => undefined),
    }
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <LightweightToolApprovalPanel
          client={new AuroraClient({ transport: new MockAuroraTransport() })}
          route={toolsRoute()}
          localTools={[projectionTool()]}
          remoteTools={[remoteProjectionTool()]}
          featureSharing={port}
          nativePlatform="android"
        />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Tools')
    expect(container.textContent).toContain('Home Aurora')
    expect(container.textContent).toContain('Device status')
    expect(container.textContent).not.toContain('Service sharing')
    expect(container.textContent).not.toContain('Features on this device')
    expect(container.textContent).not.toContain('Tools are unavailable')
    expect(container.textContent).not.toContain('Add MCP source')

    const revealSelectedSource = vi.fn()
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: revealSelectedSource,
    })
    const sourcesTrigger = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Sources')
    await act(async () => sourcesTrigger?.click())
    expect(container.querySelector('#tool-source-drawer')?.className).toContain('flex')

    const homeSource = Array.from(container.querySelectorAll<HTMLButtonElement>('[aria-label="Tool sources"] button'))
      .find((button) => button.textContent?.includes('Home Aurora'))
    await act(async () => homeSource?.click())
    expect(container.querySelector('#tool-source-drawer')?.className).toContain('hidden lg:flex')
    expect(revealSelectedSource).toHaveBeenCalledWith({ block: 'start' })
    expect(container.textContent).toContain('Read calendar')

    const remoteDetails = container.querySelector<HTMLButtonElement>('button[aria-label="Toggle details for Read calendar"]')
    await act(async () => remoteDetails?.click())
    expect(container.textContent).toContain('Shared from another device')
    await act(async () => root.unmount())
  })

  it('uses the canonical approval controls for durable local source and tool policy', async () => {
    let policySnapshot: LocalToolApprovalPolicySnapshot = {
      sourcePolicies: [],
      toolPolicies: [],
      revision: 0,
      unavailable: false,
    }
    const setSourceApprovalPolicy = vi.fn(async (
      sourceId: string,
      trustTier: 'trusted' | 'untrusted' | 'blocked',
      includeFutureTools = false,
    ) => {
      policySnapshot = {
        ...policySnapshot,
        sourcePolicies: [{ sourceId, trustTier, includeFutureTools, revision: 1, updatedAtMs: 1 }],
        revision: 1,
      }
    })
    const setToolApprovalOverride = vi.fn(async (
      toolContractId: string,
      mode: 'approve_all_for_peer' | 'ask_each_time' | 'deny_all',
    ) => {
      const trustTier = mode === 'approve_all_for_peer'
        ? 'trusted'
        : mode === 'ask_each_time'
          ? 'untrusted'
          : 'blocked'
      policySnapshot = {
        ...policySnapshot,
        toolPolicies: [{
          toolContractId,
          globalToolId: projectionTool().global_tool_id,
          localToolName: projectionTool().local_name,
          trustTier,
          revision: 2,
          updatedAtMs: 2,
        }],
        revision: 2,
      }
    })
    const port: LocalFeatureSharingPort = {
      load: vi.fn(async () => sharingSnapshot()),
      setFeatureEnabled: vi.fn(async () => undefined),
      replacePeerSharing: vi.fn(async () => undefined),
      revokePeerSharing: vi.fn(async () => undefined),
      toolApprovalPolicy: {
        loadApprovalPolicies: vi.fn(async () => policySnapshot),
        setSourceApprovalPolicy,
        clearSourceApprovalPolicy: vi.fn(async () => undefined),
        setToolApprovalOverride,
        clearToolApprovalOverride: vi.fn(async () => undefined),
      },
    }
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <LightweightToolApprovalPanel
          client={new AuroraClient({ transport: new MockAuroraTransport() })}
          route={toolsRoute()}
          localTools={[projectionTool()]}
          remoteTools={[remoteProjectionTool()]}
          featureSharing={port}
          nativePlatform="android"
        />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    const sourceApproval = container.querySelector('[role="group"][aria-label="Trust policy for Device"]')
    const requireSourceApproval = [...(sourceApproval?.querySelectorAll('button') ?? [])]
      .find((button) => button.textContent === 'Require approval') as HTMLButtonElement
    expect(requireSourceApproval.disabled).toBe(false)
    await act(async () => requireSourceApproval.click())
    await waitUntil(() => expect(setSourceApprovalPolicy).toHaveBeenCalledWith('android.device', 'untrusted', true))

    const details = container.querySelector<HTMLButtonElement>('button[aria-label="Toggle details for Device status"]')
    await act(async () => details?.click())
    const toolApproval = container.querySelector('[role="group"][aria-label="Policy override for Device status"]')
    const blockTool = [...(toolApproval?.querySelectorAll('button') ?? [])]
      .find((button) => button.textContent === 'Block') as HTMLButtonElement
    expect(blockTool.disabled).toBe(false)
    await act(async () => blockTool.click())
    await waitUntil(() => expect(setToolApprovalOverride).toHaveBeenCalledWith(LOCAL_FEATURE_ID, 'deny_all'))

    const homeSource = Array.from(container.querySelectorAll<HTMLButtonElement>('[aria-label="Tool sources"] button'))
      .find((button) => button.textContent?.includes('Home Aurora'))
    await act(async () => homeSource?.click())
    const remoteApproval = container.querySelector('[role="group"][aria-label="Trust policy for Home Aurora · Calendar"]')
    expect([...(remoteApproval?.querySelectorAll('button') ?? [])].every((button) => button.disabled)).toBe(true)

    await act(async () => root.unmount())
  })

  it('maps the existing per-tool sharing control to the native feature and preserves other peer grants', async () => {
    const snapshot = {
      ...sharingSnapshot(false),
      approvedDevices: [{
        peerId: 'peer-home',
        peerLabel: 'Home Aurora',
        featureIds: ['Native.Other'],
        expiresAtMs: 123,
      }],
    }
    const local = projectionTool()
    const cards = normalizeToolCatalog({
      tools: [local as unknown as ToolCatalogEntry],
      secrets_redacted: true,
    })
    const setFeatureEnabled = vi.fn(async () => undefined)
    const replacePeerSharing = vi.fn(async () => undefined)
    const port: LocalFeatureSharingPort = {
      load: vi.fn(async () => snapshot),
      setFeatureEnabled,
      replacePeerSharing,
      revokePeerSharing: vi.fn(async () => undefined),
    }

    const management = buildLocalToolSharingManagement(snapshot, cards)
    expect(management.sharingPolicy?.rules).toContainEqual(expect.objectContaining({
      scopeType: 'tool',
      scopeId: cards[0]!.id,
      peerId: null,
      state: 'unshared',
    }))

    await applyLocalToolSharingMutation(port, snapshot, cards, {
      scopeType: 'tool',
      scopeId: cards[0]!.id,
      mode: 'shared',
      peerIds: ['peer-home'],
    })

    expect(setFeatureEnabled).toHaveBeenCalledWith(LOCAL_FEATURE_ID, true)
    expect(replacePeerSharing).toHaveBeenCalledWith(
      'peer-home',
      [LOCAL_FEATURE_ID, 'Native.Other'].sort(),
      123,
    )
  })
})

async function waitUntil(assertion: () => void, timeoutMs = 1_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      assertion()
      return
    } catch {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
      })
    }
  }
  assertion()
}
