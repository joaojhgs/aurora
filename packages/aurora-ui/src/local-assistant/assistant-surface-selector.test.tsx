// @vitest-environment jsdom
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ToolingProjectionToolInfo } from '@aurora/client'
import type { LightweightAssistantProvider, LightweightToolClientPort } from '@aurora/client/lightweight-orchestrator'
import {
  MemoryLocalDataBackend,
  type EncryptedDataEnvelopeV1,
  type EnvelopeCryptoPort,
  type LocalDataKeyPurpose,
} from '@aurora/client/local-data'

import { findForbiddenProductionCopyTerms } from '../product-copy-forbidden-terms'
import { AssistantSurfaceSelector, type AssistantSurfaceSelectorProps } from './assistant-surface-selector'
import type { LightweightAssistantProps } from './lightweight-assistant'

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

describe('AssistantSurfaceSelector', () => {
  it('defaults to the connected assistant when both choices are available', async () => {
    const container = renderSelector({
      connectedAssistant: <article aria-label="connected-assistant">Connected assistant is ready.</article>,
      localAssistant: await localAssistantProps(),
    })

    expect(container.textContent).toContain('Assistant on this device')
    expect(container.textContent).toContain('Connected Aurora device')
    expect(container.textContent).toContain('Connected assistant is ready.')
    expect(container.querySelector('textarea')).toBeNull()
    expect(buttonByText(container, 'Connected Aurora device')?.getAttribute('aria-pressed')).toBe('true')
  })

  it('switches accessibly to the on-device assistant', async () => {
    const container = renderSelector({
      connectedAssistant: <article aria-label="connected-assistant">Connected assistant is ready.</article>,
      localAssistant: await localAssistantProps(),
    })

    await clickButton(container, 'Assistant on this device')

    expect(buttonByText(container, 'Assistant on this device')?.getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelector('[aria-label="Assistant choice"]')).not.toBeNull()
    expect(container.querySelector('textarea')?.getAttribute('aria-label')).toBe('Message Aurora')
    expect(container.textContent).toContain('Ask Aurora anything available on this device.')
  })

  it('preserves the connected assistant without showing local unavailable copy when local dependencies are incomplete', async () => {
    const container = renderSelector({
      connectedAssistant: <article aria-label="connected-assistant">Connected assistant is ready.</article>,
      localAssistant: {
        ...(await localAssistantProps()),
        envelopeCrypto: null,
      },
    })

    expect(container.textContent).toBe('Connected assistant is ready.')
    expect(container.textContent).not.toContain('Assistant on this device')
    expect(container.textContent).not.toContain('Assistant is unavailable on this device')
  })

  it('renders the on-device assistant directly when it is the only available choice', async () => {
    const container = renderSelector({
      localAssistant: await localAssistantProps(),
    })

    expect(container.textContent).not.toContain('Connected Aurora device')
    expect(container.querySelector('textarea')?.getAttribute('aria-label')).toBe('Message Aurora')
    expect(container.textContent).toContain('Saved on this device.')
  })

  it('uses the connected assistant when on-device assistant selection is disabled', async () => {
    const container = renderSelector({
      connectedAssistant: <article aria-label="connected-assistant">Connected assistant is ready.</article>,
      localAssistant: await localAssistantProps(),
      localAssistantEnabled: false,
    })

    expect(container.textContent).toBe('Connected assistant is ready.')
    expect(container.textContent).not.toContain('Assistant on this device')
  })

  it('keeps selector copy clear of blocked production wording', async () => {
    const container = renderSelector({
      connectedAssistant: <article aria-label="connected-assistant">Connected assistant is ready.</article>,
      localAssistant: await localAssistantProps(),
    })

    const matches = findForbiddenProductionCopyTerms(container.textContent ?? '')
    expect(matches.map((match) => match.id)).toEqual([])
  })
})

function renderSelector(props: AssistantSurfaceSelectorProps): HTMLElement {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => {
    root.render(<AssistantSurfaceSelector {...props} />)
  })
  return container
}

async function localAssistantProps(): Promise<LightweightAssistantProps> {
  return {
    provider: provider(),
    tools: toolPort(),
    localData: await new MemoryLocalDataBackend().open(scope.profileId, scope.localNodeId),
    envelopeCrypto: new TestEnvelopeCryptoPort(),
    scope,
    availableTools: [tool('local.echo')],
  }
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement | null {
  return [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === text) ?? null
}

async function clickButton(container: HTMLElement, text: string): Promise<void> {
  const button = buttonByText(container, text)
  if (!button) throw new Error(`missing button ${text}`)
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await Promise.resolve()
  })
}

function provider(): LightweightAssistantProvider {
  return {
    async complete() {
      return { type: 'message', content: 'Handled on this device.' }
    },
  }
}

function toolPort(): LightweightToolClientPort {
  return {
    async prepareExecution() {
      throw new Error('unexpected tool call')
    },
    async requestApproval() {
      throw new Error('unexpected approval request')
    },
    async confirmExecution() {
      throw new Error('unexpected approval confirmation')
    },
    async execute() {
      throw new Error('unexpected execution')
    },
  }
}

function tool(name: string): ToolingProjectionToolInfo {
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
    provider_peer_id: 'node-1',
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
    source_type: 'local',
    source: 'core',
    source_id: 'local:source',
    trust_tier: 'trusted',
    capability_class: 'utility',
    resource_scope: [],
    execution_location: 'local',
    safety_class: 'safe',
    risk_class: 'safe',
    data_egress: false,
    mutating: false,
    external: false,
    admin: false,
    privacy_hints: [],
    required_permissions: ['Tooling.ExecuteTool'],
    confirmation_required: false,
    rate_limit_hints: null,
    provenance: {
      provider_peer_id: 'node-1',
      provider_service_instance_id: 'local:actions',
      provider_kind: 'local',
      source: 'core',
      advertised_name: name,
    },
  }
}

class TestEnvelopeCryptoPort implements EnvelopeCryptoPort {
  async encrypt(keyPurpose: LocalDataKeyPurpose, plaintext: Uint8Array, aad: Uint8Array): Promise<EncryptedDataEnvelopeV1> {
    void keyPurpose
    void plaintext
    void aad
    return {
      version: 1,
      algorithm: 'AES-GCM-256',
      keyId: 'test-key',
      nonceB64Url: 'AAAAAAAAAAAAAAAA',
      ciphertextAndTagB64Url: 'Y2lwaGVydGV4dA',
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
