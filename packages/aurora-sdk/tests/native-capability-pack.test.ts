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
import type { JsonObject } from '../src/types.js'

describe('native capability local tool pack', () => {
  it('advertises only proven native tools', () => {
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
      AURORA_NATIVE_TOOL_IDS.shareText
    ])
    expect(new Set(registry.publicTools().map((tool) => tool.tool_contract_id))).toEqual(new Set(registered))
    expect(registry.publicTools().find((tool) => tool.tool_contract_id === AURORA_NATIVE_TOOL_IDS.shareText)).toMatchObject({
      share_group_id: 'native.share',
      required_permissions: ['Native.ShareText']
    })
  })

  it('keeps needs-permission and degraded capabilities unbindable even when includeDegraded is set', () => {
    const registry = new LocalToolRegistry({ stablePeerId: 'provider' })
    const registered = registerNativeCapabilityTools({
      registry,
      includeDegraded: true,
      capabilities: {
        [AURORA_NATIVE_TOOL_IDS.showNotification]: capability('native.notification', 'degraded', ['notifications']),
        [AURORA_NATIVE_TOOL_IDS.getDeviceStatus]: capability('native.device_status', 'needs_native_permission')
      },
      handlers: {
        [AURORA_NATIVE_TOOL_IDS.showNotification]: () => ({ shown: true }),
        [AURORA_NATIVE_TOOL_IDS.getDeviceStatus]: () => ({ online: true })
      }
    })

    expect(registered).toEqual([])
    expect(registry.publicTools()).toEqual([])
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

  it('returns structured native handler errors without leaking handler details', async () => {
    const registry = new LocalToolRegistry({ stablePeerId: 'provider' })
    const mutableDeviceCapability = capability('native.device_status', 'available')
    registerNativeCapabilityTools({
      registry,
      capabilities: {
        [AURORA_NATIVE_TOOL_IDS.getDeviceStatus]: mutableDeviceCapability,
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
    mutableDeviceCapability.state = 'needs_native_permission'

    expect(await provider.executeTool({ tool_name: AURORA_NATIVE_TOOL_IDS.getDeviceStatus, arguments: {} }, context(['Tooling.ExecuteTool', 'Native.GetDeviceStatus']))).toMatchObject({
      ok: false,
      status: 'failed',
      error_code: 'permission_unavailable',
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

  it('accepts only safe Aurora deep links before calling the native handler', async () => {
    const calls: string[] = []
    const registry = new LocalToolRegistry({ stablePeerId: 'provider' })
    registerNativeCapabilityTools({
      registry,
      capabilities: { [AURORA_NATIVE_TOOL_IDS.openDeepLink]: capability('native.deep_link', 'available') },
      handlers: {
        [AURORA_NATIVE_TOOL_IDS.openDeepLink]: (args) => {
          calls.push(String(args.url))
          return { opened: true }
        }
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

    const safeRequest = { tool_name: AURORA_NATIVE_TOOL_IDS.openDeepLink, arguments: { url: 'aurora://pair/invite?id=abc' } }
    expect(await provider.executeTool({
      ...safeRequest,
      approval_token: await approvalForRequest(policy, registry, safeRequest, ['Tooling.ExecuteTool', 'Native.OpenDeepLink'])
    }, context(['Tooling.ExecuteTool', 'Native.OpenDeepLink']))).toMatchObject({
      ok: true,
      status: 'success',
      data: { opened: true }
    })

    const unsafeRequest = { tool_name: AURORA_NATIVE_TOOL_IDS.openDeepLink, arguments: { url: 'file:///etc/passwd' } }
    expect(await provider.executeTool({
      ...unsafeRequest,
      approval_token: await approvalForRequest(policy, registry, unsafeRequest, ['Tooling.ExecuteTool', 'Native.OpenDeepLink'])
    }, context(['Tooling.ExecuteTool', 'Native.OpenDeepLink']))).toMatchObject({
      ok: false,
      status: 'failed',
      error_code: 'handler_failed',
      error: 'Tool execution failed'
    })
    expect(calls).toEqual(['aurora://pair/invite?id=abc'])
  })

  it('does not define raw shell/process tools or unrestricted path arguments', () => {
    const serialized = JSON.stringify(NATIVE_TOOL_DESCRIPTORS)
    expect(serialized).not.toMatch(/shell|process|command/i)
    for (const descriptor of NATIVE_TOOL_DESCRIPTORS) {
      expect(descriptor.toolContractId).not.toMatch(/shell|process/i)
      expect(Object.keys(descriptor.argsSchema.properties as Record<string, unknown> | undefined ?? {})).not.toContain('path')
    }
  })

  it('preserves the approved native tool ids and confirmation policies', () => {
    expect(Object.values(AURORA_NATIVE_TOOL_IDS)).toHaveLength(10)
    expect(new Set(Object.values(AURORA_NATIVE_TOOL_IDS)).size).toBe(10)
    expect(Object.fromEntries(NATIVE_TOOL_DESCRIPTORS.map((descriptor) => [
      descriptor.toolContractId,
      descriptor.confirmationPolicy
    ]))).toEqual({
      [AURORA_NATIVE_TOOL_IDS.shareText]: 'sensitive',
      [AURORA_NATIVE_TOOL_IDS.openDeepLink]: 'sensitive',
      [AURORA_NATIVE_TOOL_IDS.showNotification]: 'sensitive',
      [AURORA_NATIVE_TOOL_IDS.pickDocument]: 'sensitive',
      [AURORA_NATIVE_TOOL_IDS.readGrantedDocument]: 'sensitive',
      [AURORA_NATIVE_TOOL_IDS.writeGrantedDocument]: 'always',
      [AURORA_NATIVE_TOOL_IDS.getClipboardText]: 'sensitive',
      [AURORA_NATIVE_TOOL_IDS.setClipboardText]: 'sensitive',
      [AURORA_NATIVE_TOOL_IDS.getDeviceStatus]: 'never',
      [AURORA_NATIVE_TOOL_IDS.startForegroundVoiceCapture]: 'sensitive'
    })
  })

  it('keeps device status output bounded to product-safe availability fields', () => {
    const descriptor = NATIVE_TOOL_DESCRIPTORS.find((item) => item.toolContractId === AURORA_NATIVE_TOOL_IDS.getDeviceStatus)!
    expect(descriptor.outputSchema).toMatchObject({
      type: 'object',
      properties: {
        platform: { type: 'string', minLength: 1, maxLength: 64 },
        availableCapabilities: {
          type: 'array',
          items: { type: 'string', minLength: 1, maxLength: 160 },
          maxItems: 128
        },
        online: { type: 'boolean' },
        batteryLevel: { type: 'number', minimum: 0, maximum: 1 },
        charging: { type: 'boolean' }
      },
      required: [],
      additionalProperties: false
    })
    expect(Object.keys(descriptor.outputSchema.properties as Record<string, unknown>)).not.toEqual(expect.arrayContaining([
      'manifest',
      'permissions',
      'diagnostics'
    ]))
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
  return approvalForRequest(policy, registry, request, ['Tooling.ExecuteTool', 'Native.ShowNotification'])
}

async function approvalForRequest(
  policy: LocalToolExecutionPolicy,
  registry: LocalToolRegistry,
  request: { tool_name: string, arguments: JsonObject },
  permissions: string[]
): Promise<string> {
  const prepared = await policy.prepare(registry.resolveForDispatch(request.tool_name)!, request, execution(permissions))
  return policy.issueApprovalToken(prepared, request, execution(permissions))
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
