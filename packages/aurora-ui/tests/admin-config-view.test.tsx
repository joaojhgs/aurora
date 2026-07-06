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
import { auroraNavSections, navItemSnapshot } from '../src/nav'
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
    expect(markup).toContain('Schema-backed config accordion')
    expect(markup).toContain('Config section: services.gateway')
    expect(markup).toContain('type="number"')
    expect(markup).toContain('min="1024"')
    expect(markup).toContain('<select')
    expect(markup).toContain('Reload impact')
    expect(markup).toContain('restart required')
    expect(markup).toContain('Review Apply through AdminAction')
    expect(markup).toContain('secret redacted')
    expect(markup).toContain('[REDACTED]')
    expect(markup).not.toContain('secret-token')
    expect(markup).not.toContain('raw-super-secret')
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
    expect(container.querySelector('[role="dialog"]')).toBeNull()

    const reviewButton = findButtonByText(container, 'Review Apply through AdminAction')
    expect(reviewButton).not.toBeNull()
    await act(async () => {
      reviewButton!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    const dialog = container.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog!.textContent).toContain('Apply staged config changes')
    expect(calls).not.toContain('Config.Set')

    const confirmButton = findButtonByText(container, 'Confirm Apply through AdminAction')
    expect(confirmButton).not.toBeNull()
    expect(confirmButton!.hasAttribute('disabled')).toBe(true)

    const unlock = container.querySelector('[role="dialog"] input[type="checkbox"]') as HTMLInputElement | null
    expect(unlock).not.toBeNull()
    await act(async () => {
      unlock!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    const armedConfirmButton = findButtonByText(container, 'Confirm Apply through AdminAction')
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
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })
})

function configRoute(): RouteAvailability {
  const item = auroraNavSections.flatMap((section) => section.items).find((candidate) => candidate.id === 'config')
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
        secrets_redacted: true
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
