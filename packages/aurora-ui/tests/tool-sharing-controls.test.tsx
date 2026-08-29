// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolApprovalCardModel, ToolExportDecisionModel, ToolExportPolicyModel, ToolExportScopeModel } from '@aurora/client'
import { ToolSharingGroupControl, ToolSharingRowControl, decisionSourceLabel, type ToolSharingMutation } from '../src/tooling/tool-sharing-controls'

const localTool = {
  id: 'tool:stable:schedule', shareGroupId: 'group:scheduling', shareGroupLabel: 'Scheduling', exportable: true,
  name: 'Schedule a task', description: 'Schedules a task.', providerLabel: 'Aurora core', providerPeerId: null,
  serviceInstanceId: 'tooling-main', providerKind: 'builtin', sourceType: 'core', trustTier: 'trusted', transport: 'local', routePath: ['Tooling', 'ExecuteTool'],
  riskClass: 'mutating', approvalRequired: true, requiresAdminAction: false, selectorRequired: false, providerSelectorRequired: false,
  dataEgress: false, mutating: true, requiredPermissions: [], argsSchema: null, argsPreview: null, argsHash: null, meshSelector: null,
  resourceSelector: null, approvalScopes: ['once'], requestedApprovalScope: null, tokenTtlSeconds: null, state: 'ready', disabledReason: null,
  denialReason: null, dryRunSupported: false, dryRunRequired: false, dryRunPreview: null, auditDestination: null, correlationId: null,
  policyDecisionId: null, approvalRequestId: null, expiresAt: null, providers: [], result: null, secretsRedacted: true
} as ToolApprovalCardModel

const remoteTool = {
  ...localTool, id: 'peer-stable-2.schedule', name: 'Peer schedule', exportable: false,
  providerPeerId: 'peer-stable-2', providerKind: 'mesh', sourceType: 'mesh_peer', providerLabel: 'Kitchen Aurora'
} as ToolApprovalCardModel

const peers: ToolExportScopeModel[] = [
  { peerId: 'peer-stable-2', label: 'Kitchen Aurora', stale: false },
  { peerId: 'peer-stable-3', label: 'Kitchen Aurora', stale: false }
]

const policy: ToolExportPolicyModel = {
  scope: { peerId: null, label: 'All peers', stale: false }, defaultState: 'unshared', revision: 7, initialized: true,
  scopes: [{ peerId: null, label: 'All peers', stale: false }], migratedFromLegacy: false, updatedAt: 1, rules: [], staleToolIds: [],
  staleGroupIds: [], protocolTier: 'projection_v1', providerEnabled: true, consumerEnabled: true, enforcementActive: true,
  switchRevision: 4, secretsRedacted: true
}

const decision: ToolExportDecisionModel = {
  effectiveState: 'shared', inheritedFrom: 'global_group', inheritedFromLabel: 'Group default for all peers', matchedRuleId: 'rule-1',
  peerId: null, globalToolId: localTool.id, shareGroupId: 'group:scheduling', exportable: true, staleToolId: false, staleGroupId: false,
  prerequisites: [{ key: 'peer_execute_rbac', state: 'blocked', label: 'Peer lacks execution permission', source: 'auth_projection', reasonCode: 'permission_denied', requiredPermissions: ['Tooling.ExecuteTool'], observedPermissions: [] }],
  policyRevision: 7, reasonCode: 'peer_execute_rbac_denied'
}

function control(overrides: Partial<React.ComponentProps<typeof ToolSharingRowControl>> = {}) {
  return <ToolSharingRowControl tool={localTool} policy={policy} peers={peers} decision={decision} {...overrides} />
}

describe('tool-row mesh sharing controls', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Element.prototype.scrollIntoView = () => undefined
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  it('renders a compact state-first control and hides recipients while inherited', () => {
    const markup = renderToStaticMarkup(control())
    expect(markup).toContain('Inherit')
    expect(markup).toContain('Shared')
    expect(markup).toContain('Not shared')
    expect(markup).not.toContain('Share with')
    expect(markup).toContain('Effective via Group default for all peers')
    expect(markup).not.toContain('Shared to mesh')
    expect(markup).not.toContain('Default for all local tools')
    expect(markup).not.toContain('Controls which local tool definitions')
  })

  it('writes an all-peer tool block from the state segment', async () => {
    const mutations: ToolSharingMutation[] = []
    await act(async () => root.render(control({ onMutate: (mutation) => mutations.push(mutation) })))
    const notShared = [...container.querySelectorAll('button')].find((node) => node.textContent === 'Not shared') as HTMLButtonElement
    await act(async () => notShared.click())
    expect(mutations).toEqual([{ scopeType: 'tool', scopeId: localTool.id, mode: 'unshared', peerIds: [] }])
  })

  it('starts group sharing with all peers and reveals the multi-peer picker', async () => {
    const mutations: ToolSharingMutation[] = []
    await act(async () => root.render(
      <ToolSharingGroupControl
        groupId="group:scheduling"
        groupLabel="Scheduling"
        policy={policy}
        peers={peers}
        onMutate={(mutation) => mutations.push(mutation)}
      />
    ))
    const shared = [...container.querySelectorAll('button')].find((node) => node.textContent === 'Shared') as HTMLButtonElement
    await act(async () => shared.click())
    expect(mutations).toEqual([{ scopeType: 'group', scopeId: 'group:scheduling', mode: 'shared', peerIds: [null] }])
  })

  it('uses stable peer IDs while allowing multiple duplicate-name recipients', async () => {
    const mutations: ToolSharingMutation[] = []
    const sharedPolicy: ToolExportPolicyModel = {
      ...policy,
      rules: [{
        id: 'global-unshared', peerId: null, scopeType: 'tool', scopeId: localTool.id, state: 'unshared',
        actorPrincipalId: 'admin', reason: 'test', createdAt: 1, updatedAt: 1
      }, {
        id: 'peer-shared', peerId: 'peer-stable-2', scopeType: 'tool', scopeId: localTool.id, state: 'shared',
        actorPrincipalId: 'admin', reason: 'test', createdAt: 1, updatedAt: 1
      }]
    }
    await act(async () => root.render(control({ policy: sharedPolicy, onMutate: (mutation) => mutations.push(mutation) })))
    const picker = container.querySelector<HTMLButtonElement>('button[aria-label="Choose peers to share with"]')!
    expect(picker.textContent).toContain('Kitchen Aurora')
    await act(async () => picker.click())
    expect(document.body.textContent).toContain('Kitchen Aurora · able-2')
    expect(document.body.textContent).toContain('Kitchen Aurora · able-3')
    const secondPeer = [...document.body.querySelectorAll<HTMLElement>('[cmdk-item]')]
      .find((item) => item.textContent?.includes('able-3'))!
    await act(async () => secondPeer.click())
    expect(mutations).toEqual([{
      scopeType: 'tool',
      scopeId: localTool.id,
      mode: 'shared',
      peerIds: ['peer-stable-2', 'peer-stable-3']
    }])
  })

  it('keeps remote tools visibly read-only instead of offering re-sharing actions', () => {
    const markup = renderToStaticMarkup(control({ tool: remoteTool, decision: null }))
    expect(markup).toContain('Shared from another device')
    expect(markup).toContain('Change sharing on Kitchen Aurora')
    expect(markup).not.toContain('Not shared</button>')
  })

  it('maps effective decision sources to friendly labels', () => {
    expect(decisionSourceLabel('peer_tool', 'Kitchen Aurora')).toBe('Exact tool for Kitchen Aurora')
    expect(decisionSourceLabel('global_tool', 'Kitchen Aurora')).toBe('Exact tool for all peers')
    expect(decisionSourceLabel('peer_group', 'Kitchen Aurora')).toBe('Group default for Kitchen Aurora')
    expect(decisionSourceLabel('global_group', 'Kitchen Aurora')).toBe('Group default for all peers')
    expect(decisionSourceLabel('global_default', 'Kitchen Aurora')).toBe('Global default')
  })
})
