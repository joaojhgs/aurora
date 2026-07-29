import { describe, expect, it } from 'vitest'

import {
  AURORA_NATIVE_TOOL_IDS,
  LocalToolExecutionPolicy,
  LocalToolRegistry,
  NATIVE_TOOL_DESCRIPTORS,
  createLocalToolingProviderHandlers,
  nativeCapabilityError,
  registerNativeCapabilityTools,
  type LocalNativeCapabilitySnapshot
} from '../src/local-tools/index.js'
import type { PeerHostCallContext } from '../src/peer-host/index.js'

describe('native capability local tool pack', () => {
  it('advertises only proven or explicitly degraded native tools', () => {
    const registry = new LocalToolRegistry({ stablePeerId: 'provider' })
    const registered = registerNativeCapabilityTools({
      registry,
      capabilities: {
        [AURORA_NATIVE_TOOL_IDS.shareText]: capability('native.share', 'available'),
        [AURORA_NATIVE_TOOL_IDS.openDeepLink]: capability('native.deep_link', 'unsupported_platform'),
        [AURORA_NATIVE_TOOL_IDS.showNotification]: capability('native.notification', 'degraded', ['notifications']),
        [AURORA_NATIVE_TOOL_IDS.getDeviceStatus]: capability('native.device_status', 'needs_native_permission')
      },
      handlers: {
        [AURORA_NATIVE_TOOL_IDS.shareText]: () => ({ shared: true }),
        [AURORA_NATIVE_TOOL_IDS.openDeepLink]: () => ({ opened: true }),
        [AURORA_NATIVE_TOOL_IDS.showNotification]: () => ({ shown: true }),
        [AURORA_NATIVE_TOOL_IDS.getDeviceStatus]: () => ({ online: true })
      }
    })

    expect(registered).toEqual([
      AURORA_NATIVE_TOOL_IDS.shareText,
      AURORA_NATIVE_TOOL_IDS.showNotification,
      AURORA_NATIVE_TOOL_IDS.getDeviceStatus
    ])
    expect(new Set(registry.publicTools().map((tool) => tool.tool_contract_id))).toEqual(new Set(registered))
    expect(registry.publicTools().find((tool) => tool.tool_contract_id === AURORA_NATIVE_TOOL_IDS.showNotification)).toMatchObject({
      share_group_id: 'native.notification',
      required_permissions: ['Native.ShowNotification']
    })
  })

  it('keeps sensitive native actions behind local approval tokens', async () => {
    const registry = new LocalToolRegistry({ stablePeerId: 'provider' })
    registerNativeCapabilityTools({
      registry,
      capabilities: { [AURORA_NATIVE_TOOL_IDS.shareText]: capability('native.share', 'available') },
      handlers: { [AURORA_NATIVE_TOOL_IDS.shareText]: () => ({ shared: true }) }
    })
    const policy = new LocalToolExecutionPolicy({
      providerPeerId: 'provider',
      providerServiceInstanceId: 'local:provider:Tooling',
      randomToken: () => 'fixed',
      nowMs: () => 1_000,
      ports: allowPorts()
    })
    const provider = providerFor(registry, policy)
    const request = { tool_name: AURORA_NATIVE_TOOL_IDS.shareText, arguments: { text: 'hello' } }

    expect(await provider.executeTool(request, context(['Tooling.ExecuteTool', 'Native.ShareText']))).toMatchObject({
      ok: false,
      status: 'denied',
      error_code: 'approval_token_required'
    })

    const prepared = await policy.prepare(registry.resolveForDispatch(AURORA_NATIVE_TOOL_IDS.shareText)!, request, execution(['Tooling.ExecuteTool', 'Native.ShareText']))
    const token = policy.issueApprovalToken(prepared, request, execution(['Tooling.ExecuteTool', 'Native.ShareText']))
    expect(await provider.executeTool({ ...request, approval_token: token }, context(['Tooling.ExecuteTool', 'Native.ShareText']))).toMatchObject({
      ok: true,
      status: 'success',
      data: { shared: true }
    })
  })

  it('returns structured permission and platform errors without leaking handler details', async () => {
    const registry = new LocalToolRegistry({ stablePeerId: 'provider' })
    registerNativeCapabilityTools({
      registry,
      capabilities: {
        [AURORA_NATIVE_TOOL_IDS.getDeviceStatus]: capability('native.device_status', 'needs_native_permission'),
        [AURORA_NATIVE_TOOL_IDS.showNotification]: capability('native.notification', 'available')
      },
      handlers: {
        [AURORA_NATIVE_TOOL_IDS.getDeviceStatus]: () => ({ online: true }),
        [AURORA_NATIVE_TOOL_IDS.showNotification]: () => { throw nativeCapabilityError('user_activation_required') }
      }
    })
    const policy = new LocalToolExecutionPolicy({
      providerPeerId: 'provider',
      providerServiceInstanceId: 'local:provider:Tooling',
      randomToken: () => 'fixed',
      nowMs: () => 1_000,
      ports: allowPorts()
    })
    const provider = providerFor(registry, policy)

    expect(await provider.executeTool({ tool_name: AURORA_NATIVE_TOOL_IDS.getDeviceStatus, arguments: {} }, context(['Tooling.ExecuteTool', 'Native.GetDeviceStatus']))).toMatchObject({
      ok: false,
      status: 'failed',
      error_code: 'permission_denied',
      error: 'Tool execution failed'
    })
    expect(await provider.executeTool({
      tool_name: AURORA_NATIVE_TOOL_IDS.showNotification,
      arguments: { title: 'Hi' },
      approval_token: await approvalFor(policy, registry, AURORA_NATIVE_TOOL_IDS.showNotification)
    }, context(['Tooling.ExecuteTool', 'Native.ShowNotification']))).toMatchObject({
      ok: false,
      status: 'failed',
      error_code: 'user_activation_required',
      error: 'Tool execution failed'
    })
  })

  it('does not define raw shell/process tools or unrestricted path arguments', () => {
    const serialized = JSON.stringify(NATIVE_TOOL_DESCRIPTORS)
    expect(serialized).not.toMatch(/shell|process|command/i)
    for (const descriptor of NATIVE_TOOL_DESCRIPTORS) {
      expect(descriptor.toolContractId).not.toMatch(/shell|process/i)
      expect(Object.keys(descriptor.argsSchema.properties as Record<string, unknown> | undefined ?? {})).not.toContain('path')
    }
  })
})

function capability(capabilityId: string, state: NonNullable<LocalNativeCapabilitySnapshot[keyof LocalNativeCapabilitySnapshot]>['state'], requiredOsPermissions: readonly string[] = []) {
  return { capabilityId, state, requiredOsPermissions }
}

function providerFor(registry: LocalToolRegistry, policy = new LocalToolExecutionPolicy({
  providerPeerId: 'provider',
  providerServiceInstanceId: 'local:provider:Tooling',
  ports: allowPorts()
})) {
  return createLocalToolingProviderHandlers({
    registry,
    policy,
    providerPeerId: 'provider',
    serviceInstanceId: 'local:provider:Tooling',
    audit: () => undefined,
    exportDecision: { isShared: () => true }
  })
}

async function approvalFor(policy: LocalToolExecutionPolicy, registry: LocalToolRegistry, toolName: string): Promise<string> {
  const request = { tool_name: toolName, arguments: { title: 'Hi' } }
  const prepared = await policy.prepare(registry.resolveForDispatch(toolName)!, request, execution(['Tooling.ExecuteTool', 'Native.ShowNotification']))
  return policy.issueApprovalToken(prepared, request, execution(['Tooling.ExecuteTool', 'Native.ShowNotification']))
}

function allowPorts() {
  return {
    hasMethodGrant: (methodId: string) => methodId === 'Tooling.ExecuteTool',
    hasToolGrant: () => true,
    hasCapabilityGrant: () => true,
    hasResourceGrant: () => true
  }
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
