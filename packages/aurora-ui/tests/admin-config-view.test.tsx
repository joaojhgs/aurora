// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  AuroraClient as Aurora,
  MockAuroraTransport,
  type ConfigDiffPreviewResponse,
  type ConfigFieldMetadata,
  type ConfigReloadImpactResponse,
  type ConfigSchemaMetadataResponse,
  type ConfigSetRequest,
  type ConfigVersionHistoryResponse
} from '@aurora/client'
import { AdminConfigView, buildAdminConfigModel } from '../src/admin-config-view'
import { auroraEmbeddedNavItems, auroraNavSections, navItemSnapshot } from '../src/nav'
import type { RouteAvailability } from '../src/shell-data'

const roots: Root[] = []

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount()
})

describe('AdminConfigView', () => {
  it('renders schema-backed typed controls, reload impact, staged review, and redacts backend secret values', async () => {
    const client = new Aurora({ transport: configTransport() })
    const model = await buildAdminConfigModel(client, configRoute())
    const markup = renderToStaticMarkup(<AdminConfigView client={client} route={configRoute()} initialModel={model} />)

    expect(model.state).toBe('ready')
    expect(markup).toContain('Configuration sections')
    expect(markup).toContain('Settings group: Connection settings')
    expect(markup).not.toContain('services.gateway.api.port')
    expect(markup).toContain('type="number"')
    expect(markup).toContain('min="1024"')
    expect(markup).toContain('<select')
    expect(markup).toContain('Refresh impact')
    expect(markup).toContain('restart required')
    expect(markup).toContain('Review and apply')
    expect(markup).toContain('secret redacted')
    expect(markup).toContain('[REDACTED]')
    expect(markup).not.toContain('secret-token')
    expect(markup).not.toContain('raw-super-secret')
  })

  it('keeps hostile config key paths out of rendered text and attributes', async () => {
    const client = new Aurora({ transport: hostileConfigTransport() })
    const model = await buildAdminConfigModel(client, configRoute())
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(<AdminConfigView client={client} route={configRoute()} initialModel={model} />)
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })

    expectUnsafeConfigCopyAbsent(container.innerHTML)
    expect(container.textContent).toContain('Assistant setting')
    expect(container.textContent).toContain('Protected setting')
    expect(container.textContent).toContain('Setting 1')
    expect(container.innerHTML).toContain('value="openai"')
    expect(container.innerHTML).toContain('[REDACTED]')
    expect(container.innerHTML).not.toContain('sk-abc123')

    const rollbackButton = findButtonByText(container, 'Rollback')
    expect(rollbackButton).not.toBeNull()
    await act(async () => {
      rollbackButton!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
    expect(document.body.textContent).toContain('Roll back Setting 1 to a prior version.')
    expect(document.body.textContent).toContain('Setting 1')
    expectUnsafeConfigCopyAbsent(document.body.innerHTML)

    const cancelButton = findButtonByText(document.body, 'Cancel')
    await act(async () => {
      cancelButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })

    const input = Array.from(container.querySelectorAll('input')).find((candidate) => candidate.value === 'openai')
    expect(input).not.toBeNull()
    await act(async () => {
      setInputValue(input!, 'local')
      input!.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Assistant setting')
    expect(container.textContent).toContain('Assistant')
    expect(container.textContent).toContain('openai')
    expect(container.textContent).toContain('local')
    expectUnsafeConfigCopyAbsent(container.innerHTML)

    const reviewButton = findButtonByText(container, 'Review and apply')
    expect(reviewButton).not.toBeNull()
    await act(async () => {
      reviewButton!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })

    expect(document.body.textContent).toContain('Apply staged config changes')
    expect(document.body.textContent).toContain('Assistant setting')
    expectUnsafeConfigCopyAbsent(document.body.innerHTML)
  })

  it('does not submit Config.Set until a staged change is reviewed and explicitly confirmed', async () => {
    const calls: string[] = []
    const transport = configTransport(calls)
    const client = new Aurora({ transport })
    const model = await buildAdminConfigModel(client, configRoute())
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(<AdminConfigView client={client} route={configRoute()} initialModel={model} />)
    })

    const input = container.querySelector('input[type="number"]') as HTMLInputElement | null
    expect(input).not.toBeNull()
    await act(async () => {
      setInputValue(input!, '9000')
      input!.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })

    expect(calls).toEqual(['Config.PreviewDiff', 'Config.PreviewReloadImpact'])
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()

    const reviewButton = findButtonByText(container, 'Review and apply')
    expect(reviewButton).not.toBeNull()
    await act(async () => {
      reviewButton!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      // Base UI's AlertDialog mounts its portal content over two animation-frame
      // ticks (unmounted -> starting-style -> open); flush both before asserting.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })

    const dialog = document.body.querySelector('[role="alertdialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog!.textContent).toContain('Apply staged config changes')
    expect(calls).not.toContain('Config.Set')

    const confirmButton = findButtonByText(document.body, 'Confirm apply')
    expect(confirmButton).not.toBeNull()
    expect(confirmButton!.hasAttribute('disabled')).toBe(true)

    const unlock = document.body.querySelector('[role="alertdialog"] input[type="checkbox"]') as HTMLInputElement | null
    expect(unlock).not.toBeNull()
    await act(async () => {
      unlock!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    const armedConfirmButton = findButtonByText(document.body, 'Confirm apply')
    expect(armedConfirmButton!.hasAttribute('disabled')).toBe(false)
    await act(async () => {
      armedConfirmButton!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })

    expect(calls).toEqual([
      'Config.PreviewDiff',
      'Config.PreviewReloadImpact',
      'Gateway.AdminActionDraft',
      'Gateway.AdminActionConfirm',
      'Config.Set'
    ])
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
  })
})

function configRoute(): RouteAvailability {
  const item = [...auroraNavSections.flatMap((section) => section.items), ...auroraEmbeddedNavItems].find((candidate) => candidate.id === 'config')
  if (!item) throw new Error('config route missing')
  return {
    item: navItemSnapshot(item),
    state: 'available-local',
    explanation: 'Config route available from mock status.',
    providerLabel: 'mock Config.GetSchemaMetadata',
    blockers: [],
    repairActions: [],
    candidateProviders: [],
    evidenceSources: ['Config.GetSchemaMetadata'],
    selectorRequired: false,
    approvalRequired: false,
    routeable: true,
    disabled: false,
    requiresAdminAction: true
  }
}

function configTransport(calls: string[] = []): MockAuroraTransport {
  return MockAuroraTransport.empty()
    .register('Config.GetSchemaMetadata', () => schemaFixture())
    .register('Config.GetVersionHistory', () => ({
      versions: [
        {
          version_id: 'cfgv-secret-001',
          timestamp: '2026-07-02T00:00:00Z',
          key_path: 'services.gateway.api.token',
          old_value: '[REDACTED]',
          new_value: '[REDACTED]',
          affected_sections: ['services.gateway'],
          secret: true
        }
      ],
      secrets_redacted: true
    } satisfies ConfigVersionHistoryResponse))
    .register('Config.Validate', () => ({ errors: [] }))
    .register('Config.PreviewDiff', (request) => {
      calls.push('Config.PreviewDiff')
      const payload = request.payload as { changes?: ConfigSetRequest[] }
      return {
        valid: true,
        diffs: (payload.changes ?? []).map((change) => ({
          key_path: change.key_path,
          old_value: change.key_path.includes('token') ? 'secret-token' : 8080,
          new_value: change.key_path.includes('token') ? 'raw-super-secret' : change.value,
          changed: true,
          source_layer: 'config.json',
          secret: change.key_path.includes('token'),
          reload_required: true,
          restart_required: change.key_path === 'services.gateway.api.port',
          affected_services: ['gateway']
        })),
        errors: [],
        secrets_redacted: true,
        changed_paths: (payload.changes ?? []).map((change) => change.key_path)
      } satisfies ConfigDiffPreviewResponse
    })
    .register('Config.PreviewReloadImpact', (request) => {
      calls.push('Config.PreviewReloadImpact')
      const payload = request.payload as { changes?: ConfigSetRequest[] }
      return {
        impacts: (payload.changes ?? []).map((change) => ({
          key_path: change.key_path,
          reload_required: true,
          restart_required: change.key_path === 'services.gateway.api.port',
          affected_services: ['gateway'],
          reason: 'Gateway port changes require restart.'
        }))
      } satisfies ConfigReloadImpactResponse
    })
    .register('Gateway.AdminActionDraft', () => {
      calls.push('Gateway.AdminActionDraft')
      return {
        action_id: 'aa-config',
        nonce: 'nonce',
        digest: 'digest',
        method_id: 'Config.Set',
        affected_resources: ['services.gateway.api.port'],
        required_phrase: 'CONFIRM',
        required_reason: true,
        required_reauth: true,
        expires_at: '2026-07-02T00:05:00Z',
        expires_in_seconds: 300,
        confirmation_headers: {
          action_id: 'X-Aurora-AdminAction-Id',
          confirmation_token: 'X-Aurora-AdminAction-Token',
          digest: 'X-Aurora-AdminAction-Digest'
        }
      }
    })
    .register('Gateway.AdminActionConfirm', () => {
      calls.push('Gateway.AdminActionConfirm')
      return {
        action_id: 'aa-config',
        confirmation_token: 'token',
        digest: 'digest',
        confirmed: true,
        expires_at: '2026-07-02T00:05:00Z',
        audit_receipt: 'audit-config-001',
        confirmation_headers: {
          action_id: 'X-Aurora-AdminAction-Id',
          confirmation_token: 'X-Aurora-AdminAction-Token',
          digest: 'X-Aurora-AdminAction-Digest'
        }
      }
    })
    .register('Config.Set', () => {
      calls.push('Config.Set')
      return { success: true, previous_value: 8080, error: null }
    })
}

function hostileConfigTransport(): MockAuroraTransport {
  return MockAuroraTransport.empty()
    .register('Config.GetSchemaMetadata', () => hostileSchemaFixture())
    .register('Config.GetVersionHistory', () => ({
      versions: [
        {
          version_id: 'cfgv-hostile-001',
          timestamp: '2026-07-02T00:00:00Z',
          key_path: 'services.unknown.room_password',
          old_value: '[REDACTED]',
          new_value: '[REDACTED]',
          affected_sections: ['services.unknown'],
          secret: true
        }
      ],
      secrets_redacted: true
    } satisfies ConfigVersionHistoryResponse))
    .register('Config.Validate', () => ({
      errors: [
        'services.orchestrator.llm.provider uses fallback provider schema',
        'Gateway.GetSchemaMetadata failed proof',
        'services.gateway.webrtc.room_password invalid room password'
      ]
    }))
    .register('Config.PreviewDiff', (request) => {
      const payload = request.payload as { changes?: ConfigSetRequest[] }
      return {
        valid: true,
        diffs: (payload.changes ?? []).map((change) => ({
          key_path: change.key_path,
          old_value: 'openai',
          new_value: change.value,
          changed: true,
          source_layer: 'config.json',
          secret: false,
          reload_required: true,
          restart_required: false,
          affected_services: ['orchestrator']
        })),
        errors: [],
        secrets_redacted: true,
        changed_paths: (payload.changes ?? []).map((change) => change.key_path)
      } satisfies ConfigDiffPreviewResponse
    })
    .register('Config.PreviewReloadImpact', (request) => {
      const payload = request.payload as { changes?: ConfigSetRequest[] }
      return {
        impacts: (payload.changes ?? []).map((change) => ({
          key_path: change.key_path,
          reload_required: true,
          restart_required: false,
          affected_services: ['orchestrator'],
          reason: 'services.orchestrator.llm.provider fallback protocol proof'
        }))
      } satisfies ConfigReloadImpactResponse
    })
}

function schemaFixture(): ConfigSchemaMetadataResponse {
  return {
    secrets_redacted: true,
    fields: [
      field({
        key_path: 'services.gateway.api.port',
        title: 'Gateway port',
        type: 'integer',
        current_value: 8080,
        restart_required: true,
        constraints: { minimum: 1024, maximum: 65535 }
      }),
      field({
        key_path: 'services.gateway.mode',
        title: 'Gateway mode',
        type: 'string',
        current_value: 'local',
        choices: ['local', 'remote']
      }),
      field({
        key_path: 'services.gateway.api.token',
        title: 'Gateway token',
        type: 'string',
        current_value: 'secret-token',
        secret: true
      })
    ]
  }
}

function hostileSchemaFixture(): ConfigSchemaMetadataResponse {
  return {
    secrets_redacted: true,
    fields: [
      field({
        key_path: 'services.orchestrator.llm.provider',
        title: 'LLM provider',
        description: 'Provider schema fallback proof from services.orchestrator.llm.provider.',
        type: 'string',
        current_value: 'openai',
        source_layer: 'config.json',
        affected_services: ['orchestrator']
      }),
      field({
        key_path: 'Gateway.GetSchemaMetadata',
        title: 'Gateway.GetSchemaMetadata',
        description: 'Gateway.GetSchemaMetadata protocol proof.',
        type: 'string',
        current_value: 'ready',
        source_layer: 'config.json',
        affected_services: ['gateway']
      }),
      field({
        key_path: 'services.gateway.webrtc.room_password',
        title: 'room_password',
        description: 'room password protocol',
        type: 'string',
        current_value: 'sk-abc123',
        source_layer: 'config.json',
        affected_services: ['gateway'],
        secret: false
      })
    ]
  }
}

function field(overrides: Partial<ConfigFieldMetadata>): ConfigFieldMetadata {
  return {
    key_path: 'services.example.enabled',
    title: 'Example',
    description: 'Schema field from config metadata.',
    type: 'string',
    current_value: 'value',
    source_layer: 'config.json',
    secret: false,
    reload_required: true,
    restart_required: false,
    affected_services: ['gateway'],
    constraints: {},
    ...overrides
  }
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
}

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement | null {
  return Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes(text)) ?? null
}

function expectUnsafeConfigCopyAbsent(markup: string): void {
  expect(markup).not.toMatch(/services\.orchestrator|services\.gateway|services\.unknown|Gateway\.Get|room[_ -]?password|key_path|provider|schema|route|manifest|transport|proof|fallback|protocol/iu)
}
