// @vitest-environment jsdom
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  LightweightOrchestratorError,
  type LightweightAssistantProvider,
  type LightweightProviderResponse,
  type LightweightToolClientPort,
  type LightweightToolExecutionResponse,
} from '@aurora/client/lightweight-orchestrator'
import {
  MemoryLocalDataBackend,
  type EncryptedDataEnvelopeV1,
  type EnvelopeCryptoPort,
  type LocalDataKeyPurpose,
  type LocalDataSession,
} from '@aurora/client/local-data'
import type { JsonObject, ToolingPrepareExecutionRequest, ToolingPrepareExecutionResponse, ToolingProjectionToolInfo } from '@aurora/client'

import { findForbiddenProductionCopyTerms } from '../product-copy-forbidden-terms'
import { LightweightLocalAssistant } from './lightweight-assistant'

const scope = Object.freeze({ profileId: 'profile-1', localNodeId: 'node-1' })
const roots: Root[] = []

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Element.prototype.scrollIntoView = () => undefined
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('LightweightLocalAssistant', () => {
  it('runs a prompt to assistant turn through the bounded assistant and stores encrypted local messages', async () => {
    const crypto = new RecordingEnvelopeCryptoPort()
    const session = await dataSession()
    const container = renderAssistant({
      provider: sequenceProvider([{ type: 'message', content: 'Done on this device.' }]),
      tools: toolPort(),
      localData: session,
      envelopeCrypto: crypto,
      scope,
      availableTools: [tool('local.echo', 'local')],
      ids: idSequence('conv', 'user', 'assistant'),
    })

    await sendPrompt(container, 'hello')

    expect(container.textContent).toContain('hello')
    expect(container.textContent).toContain('Done on this device.')
    const conversations = await session.conversations.listConversations()
    expect(conversations).toHaveLength(1)
    const messages = await session.conversations.listMessages(conversations[0]!.id)
    expect(messages.map((message) => [message.role, message.status, message.contentEnvelope !== null])).toEqual([
      ['user', 'complete', true],
      ['assistant', 'complete', true],
    ])
    expect(crypto.encrypted.map((entry) => entry.plaintext)).toEqual(['hello', 'Done on this device.'])
  })

  it('approves and denies confirmation without bypassing the action port', async () => {
    const approveCalls: string[] = []
    const approveContainer = renderAssistant({
      provider: sequenceProvider([
        { type: 'tool_calls', toolCalls: [{ id: 'danger', toolName: 'local.delete', arguments: { id: '1' }, route: 'local' }] },
        { type: 'message', content: 'Removed.' },
      ]),
      tools: toolPort({ calls: approveCalls, approvalRequired: true }),
      localData: await dataSession(),
      envelopeCrypto: new RecordingEnvelopeCryptoPort(),
      scope,
      availableTools: [tool('local.delete', 'local', { confirmation_required: true, risk_class: 'mutating', mutating: true })],
      ids: idSequence('c1', 'u1', 'corr1', 'pending1', 'token1', 'tool1', 'assistant1'),
    })
    await sendPrompt(approveContainer, 'remove it')
    expect(approveContainer.textContent).toContain('Aurora needs your approval')
    await clickButton(approveContainer, 'Allow once')
    expect(approveContainer.textContent).toContain('Removed.')
    expect(approveCalls).toEqual([
      'prepare:local.delete:local',
      'request:local.delete:local',
      'confirm:approval-local.delete',
      'execute:local.delete:local:backend-token-local.delete',
    ])

    const denyCalls: string[] = []
    const denyContainer = renderAssistant({
      provider: sequenceProvider([
        { type: 'tool_calls', toolCalls: [{ id: 'danger', toolName: 'local.delete', arguments: { id: '1' }, route: 'local' }] },
      ]),
      tools: toolPort({ calls: denyCalls, approvalRequired: true }),
      localData: await dataSession(),
      envelopeCrypto: new RecordingEnvelopeCryptoPort(),
      scope,
      availableTools: [tool('local.delete', 'local', { confirmation_required: true })],
      ids: idSequence('c2', 'u2', 'corr2', 'pending2', 'token2', 'cancel2'),
    })
    await sendPrompt(denyContainer, 'do not remove')
    await clickButton(denyContainer, 'Deny')
    expect(denyContainer.textContent).not.toContain('Aurora needs your approval')
    expect(denyCalls).toEqual(['prepare:local.delete:local', 'request:local.delete:local'])
  })

  it('cancels a slow turn and then recovers from an error on the next prompt', async () => {
    let capturedSignal: AbortSignal | null = null
    const provider: LightweightAssistantProvider = {
      async complete(request) {
        capturedSignal = request.signal
        await new Promise((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true })
        })
        return { type: 'message', content: 'never' }
      },
    }
    const container = renderAssistant({
      provider,
      tools: toolPort(),
      localData: await dataSession(),
      envelopeCrypto: new RecordingEnvelopeCryptoPort(),
      scope,
      availableTools: [tool('local.echo', 'local')],
    })

    await sendPrompt(container, 'wait')
    await clickButton(container, 'Stop response')

    const cancelledSignal = capturedSignal as AbortSignal | null
    expect(cancelledSignal?.aborted).toBe(true)
    await waitUntil(() => !container.textContent!.includes('Aurora is working.'))

    const failingContainer = renderAssistant({
      provider: sequenceProviderError(new LightweightOrchestratorError('provider_response_malformed')),
      tools: toolPort(),
      localData: await dataSession(),
      envelopeCrypto: new RecordingEnvelopeCryptoPort(),
      scope,
      availableTools: [tool('local.echo', 'local')],
    })
    await sendPrompt(failingContainer, 'fail')
    expect(failingContainer.textContent).toContain('Could not connect to this Aurora device. Try again.')

    const recoveredContainer = renderAssistant({
      provider: sequenceProvider([{ type: 'message', content: 'Recovered.' }]),
      tools: toolPort(),
      localData: await dataSession(),
      envelopeCrypto: new RecordingEnvelopeCryptoPort(),
      scope,
      availableTools: [tool('local.echo', 'local')],
    })
    await sendPrompt(recoveredContainer, 'again')
    expect(recoveredContainer.textContent).toContain('Recovered.')
  })

  it('fails closed when any required assistant dependency is unavailable', async () => {
    const provider = sequenceProvider([{ type: 'message', content: 'should not run' }])
    const container = renderAssistant({
      provider,
      tools: toolPort(),
      localData: await dataSession(),
      envelopeCrypto: null,
      scope,
      availableTools: [tool('local.echo', 'local')],
    })

    expect(container.textContent).toContain('Assistant is unavailable on this device')
    expect(container.querySelector('textarea')).toBeNull()
  })

  it('keeps rendered assistant copy clear of blocked production wording', async () => {
    const container = renderAssistant({
      provider: sequenceProvider([{ type: 'message', content: 'Ready.' }]),
      tools: toolPort(),
      localData: await dataSession(),
      envelopeCrypto: new RecordingEnvelopeCryptoPort(),
      scope,
      availableTools: [tool('local.echo', 'local')],
    })
    await sendPrompt(container, 'hi')

    const matches = findForbiddenProductionCopyTerms(container.textContent ?? '')
    expect(matches.map((match) => match.id)).toEqual([])
  })
})

function renderAssistant(props: React.ComponentProps<typeof LightweightLocalAssistant>): HTMLElement {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => {
    root.render(<LightweightLocalAssistant {...props} />)
  })
  return container
}

async function sendPrompt(container: HTMLElement, text: string): Promise<void> {
  const textarea = container.querySelector('textarea')
  if (!textarea) throw new Error('missing textarea')
  await act(async () => {
    setTextAreaValue(textarea, text)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()
  })
  await clickButton(container, 'Send message')
}

async function clickButton(container: HTMLElement, label: string): Promise<void> {
  const button = [...container.querySelectorAll('button')].find((candidate) => candidate.getAttribute('aria-label') === label || candidate.textContent?.includes(label))
  if (!button) throw new Error(`missing button ${label}`)
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

function setTextAreaValue(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(textarea, value)
}

async function waitUntil(assertion: () => boolean): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    if (assertion()) return
  }
  throw new Error('condition not met')
}

async function dataSession(): Promise<LocalDataSession> {
  return await new MemoryLocalDataBackend().open(scope.profileId, scope.localNodeId)
}

function sequenceProvider(responses: LightweightProviderResponse[]): LightweightAssistantProvider {
  const queue = [...responses]
  return {
    async complete() {
      const response = queue.shift()
      if (!response) throw new LightweightOrchestratorError('provider_response_malformed')
      return response
    },
  }
}

function sequenceProviderError(error: Error): LightweightAssistantProvider {
  return {
    async complete() {
      throw error
    },
  }
}

function toolPort(options: {
  calls?: string[]
  approvalRequired?: boolean
  execute?: (payload: ToolingPrepareExecutionRequest) => Promise<LightweightToolExecutionResponse>
} = {}): LightweightToolClientPort {
  return {
    async prepareExecution(payload) {
      options.calls?.push(`prepare:${payload.tool_name}:${selectorLocation(payload.resource_selector)}`)
      return prepareResponse(payload, options.approvalRequired === true)
    },
    async requestApproval(payload) {
      options.calls?.push(`request:${payload.tool_name}:${selectorLocation(payload.resource_selector)}`)
      return {
        ok: true,
        approval_request_id: `approval-${payload.tool_name}`,
        policy_decision: {
          decision_id: `decision-${payload.tool_name}`,
          allowed: false,
          approval_required: true,
          approval_mode: 'ask_each_time',
          token_ttl_seconds: 300,
          reason: 'approval_token_required',
        },
        expires_at: 1_900_000_000,
        correlation_id: payload.correlation_id ?? `corr-${payload.tool_name}`,
        error: null,
      }
    },
    async confirmExecution(payload) {
      options.calls?.push(`confirm:${payload.approval_request_id}`)
      const toolName = payload.approval_request_id.replace(/^approval-/, '')
      return {
        ok: payload.approve !== false,
        approval_token: payload.approve === false ? null : `backend-token-${toolName}`,
        expires_at: 1_900_000_000,
        policy_decision_id: `decision-${toolName}`,
        correlation_id: payload.correlation_id ?? null,
        error: payload.approve === false ? 'approval_denied' : null,
      }
    },
    async execute(payload) {
      options.calls?.push(`execute:${payload.tool_name}:${selectorLocation(payload.resource_selector)}:${payload.approval_token ?? 'no-token'}`)
      if (options.execute) return await options.execute(payload)
      return {
        ok: true,
        data: { value: payload.tool_name },
        status: 'success',
        correlation_id: payload.correlation_id ?? null,
        provider_peer_id: 'node-1',
        global_tool_id: payload.tool_name,
      }
    },
  }
}

function prepareResponse(request: ToolingPrepareExecutionRequest, approvalRequired: boolean): ToolingPrepareExecutionResponse {
  return {
    ok: !approvalRequired,
    policy_decision: {
      allowed: !approvalRequired,
      share: true,
      approval_required: approvalRequired,
      approval_mode: approvalRequired ? 'ask_each_time' : 'approve_all_local_safe',
      decision_id: `decision-${request.tool_name}`,
      reason: approvalRequired ? 'approval_token_required' : null,
      token_ttl_seconds: 300,
    },
    args_hash: `args-${request.tool_name}`,
    resource_selector_hash: `selector-${request.tool_name}`,
    route_decision_id: `path-${request.tool_name}`,
    correlation_id: request.correlation_id ?? `corr-${request.tool_name}`,
    provider_peer_id: 'node-1',
    provider_service_instance_id: 'local:Tooling',
    global_tool_id: request.tool_name,
    local_tool_name: request.tool_name,
    args_schema_hash: 'a'.repeat(64),
    source: 'core',
    source_id: 'source-1',
    trust_tier: approvalRequired ? 'untrusted' : 'trusted',
    capability_class: 'utility',
    resource_scope: [],
    display_args_preview: {},
    argument_visibility: {},
    secrets_redacted: true,
  }
}

function selectorLocation(selector: JsonObject | null | undefined): string {
  const value = selector?.execution_location
  return typeof value === 'string' ? value : 'none'
}

function tool(name: string, executionLocation: 'local' | 'remote', overrides: Partial<ToolingProjectionToolInfo> = {}): ToolingProjectionToolInfo {
  return {
    name,
    local_name: name,
    global_tool_id: name,
    tool_id_scheme: 'aurora-tool',
    tool_id_version: 1,
    tool_contract_id: `action.${name}`,
    share_group_id: `group.${name}`,
    share_group_label: name,
    legacy_global_tool_ids: [],
    exportable: true,
    provider_peer_id: executionLocation === 'local' ? 'node-1' : 'peer-1',
    provider_service_instance_id: 'local:actions',
    provider_label: null,
    provider_granted_permissions: null,
    provider_available: true,
    namespace: 'node-1',
    display_name: name,
    aliases: [],
    description: name,
    args_schema: { type: 'object' },
    schema: { type: 'object' },
    argument_visibility: {},
    source_type: executionLocation === 'local' ? 'local' : 'mesh_peer',
    source: executionLocation === 'local' ? 'core' : 'mesh_peer',
    source_id: `${executionLocation}:source`,
    trust_tier: 'trusted',
    capability_class: 'utility',
    resource_scope: [],
    execution_location: executionLocation,
    safety_class: 'safe',
    risk_class: 'safe',
    data_egress: executionLocation === 'remote',
    mutating: false,
    external: executionLocation === 'remote',
    admin: false,
    privacy_hints: [],
    required_permissions: ['Tooling.ExecuteTool'],
    confirmation_required: false,
    rate_limit_hints: null,
    provenance: {
      provider_peer_id: executionLocation === 'local' ? 'node-1' : 'peer-1',
      provider_service_instance_id: 'local:actions',
      provider_kind: executionLocation === 'local' ? 'local' : 'mesh_peer',
      source: executionLocation === 'local' ? 'core' : 'mesh_peer',
      advertised_name: name,
    },
    ...overrides,
  }
}

function idSequence(...values: string[]): () => string {
  const queue = [...values]
  let index = 0
  return () => queue.shift() ?? `generated-${index++}`
}

class RecordingEnvelopeCryptoPort implements EnvelopeCryptoPort {
  readonly encrypted: Array<{ keyPurpose: LocalDataKeyPurpose; aad: Uint8Array; plaintext: string }> = []

  async encrypt(keyPurpose: LocalDataKeyPurpose, plaintext: Uint8Array, aad: Uint8Array): Promise<EncryptedDataEnvelopeV1> {
    const keyId = `test-key-${this.encrypted.length + 1}`
    this.encrypted.push({ keyPurpose, aad: new Uint8Array(aad), plaintext: new TextDecoder().decode(plaintext) })
    return {
      version: 1,
      algorithm: 'AES-GCM-256',
      keyId,
      nonceB64Url: 'AAAAAAAAAAAAAAAA',
      ciphertextAndTagB64Url: base64Url(new TextEncoder().encode(`ciphertext-${keyId}`)),
      createdAtMs: 1000,
    }
  }

  async decrypt(): Promise<Uint8Array> {
    return new Uint8Array()
  }

  async rotateKey(): Promise<{ previousKeyId: string; newKeyId: string }> {
    return { previousKeyId: 'old', newKeyId: 'new' }
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')
}
