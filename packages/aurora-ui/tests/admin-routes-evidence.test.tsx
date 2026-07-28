import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AuroraClient as Aurora, MockAuroraTransport } from '@aurora/client'
import { ConfigEditorView, buildConfigEditorModel } from '../src/config-editor-view'
import { auroraEmbeddedNavItems, navItemSnapshot } from '../src/nav'
import { AdminContractsView, buildAdminServicesSnapshot } from '../src/admin-services-view'
import { buildShellSnapshot, type RouteAvailability } from '../src/shell-data'
import { productionSurfaceContracts } from '../src/production-surface-contracts'

describe('admin route checkpoint status', () => {
  it('keeps sensitive admin read pages routeable while mutation surfaces stay AdminAction-scoped', async () => {
    const snapshot = await buildShellSnapshot(new Aurora({ transport: new MockAuroraTransport() }))
    const readRouteIds = ['admin', 'services', 'access', 'tokens', 'devices', 'config', 'contracts', 'plugins', 'pairing', 'backups', 'scheduler', 'audit']

    for (const id of readRouteIds) {
      const readRoute = route(snapshot.routes, id)
      expect(readRoute.item.adminGated, `${id} is an admin-owned read page`).toBe(true)
      expect(readRoute.requiresAdminAction, `${id} read page must not require an AdminAction mutation token`).toBe(false)
    }

    const mutationSurfaceIds = productionSurfaceContracts
      .filter((surface) => surface.adminActionRequired)
      .map((surface) => surface.id)

    expect(mutationSurfaceIds).toEqual(expect.arrayContaining([
      'admin-rbac',
      'admin-devices',
      'admin-plugins',
      'admin-scheduler',
      'config-editor'
    ]))
    for (const surface of productionSurfaceContracts.filter((candidate) => mutationSurfaceIds.includes(candidate.id))) {
      expect(surface.stateCoverage, `${surface.id} exposes AdminAction state coverage`).toContain('admin-action')
      expect(surface.truthSources.some((source) => source.kind === 'admin-action'), `${surface.id} has AdminAction truth source`).toBe(true)
    }
  })

  it('renders disabled config mutation controls when the config read route is denied', async () => {
    const client = new Aurora({ transport: new MockAuroraTransport() })
    const snapshot = await buildShellSnapshot(client)
    const deniedRoute: RouteAvailability = {
      ...route(snapshot.routes, 'config'),
      disabled: true,
      state: 'denied',
      blockers: ['missing:Config.manage']
    }
    const model = await buildConfigEditorModel(client, deniedRoute)
    const markup = renderToStaticMarkup(<ConfigEditorView client={client} route={deniedRoute} initialModel={model} />)

    expect(model.state).toBe('denied')
    expect(model.fields).toEqual([])
    expect(markup).toContain('Configuration editor is unavailable')
    expect(markup).toContain('Permission is needed')
    expect(markup).not.toContain('missing:Config.manage')
    expect(markup).toContain('disabled=""')
  })

  it('renders contract detail status from the SDK registry and capability catalog', async () => {
    const snapshot = await buildAdminServicesSnapshot(new Aurora({ transport: new MockAuroraTransport() }))
    const markup = renderToStaticMarkup(<AdminContractsView snapshot={snapshot} />)
    const copy = renderedCopy(markup)

    expect(snapshot.loadState).toBe('ready')
    expect(snapshot.contracts.map((contract) => contract.busTopic)).toContain('Auth.AuditLog')
    expect(copy).toContain('Service actions')
    expect(copy).toContain('Access Audit Log')
    expect(copy).not.toContain('Auth.AuditLog')
    expect(copy).not.toContain('Backend')
    expect(copy).toContain('Permissions')
  })

  it('surfaces config validation errors as a degraded editor state', async () => {
    const transport = new MockAuroraTransport()
    transport.register('Config.Validate', () => ({
      errors: ['services.gateway.api.port must be between 1 and 65535']
    }))
    const client = new Aurora({ transport })
    const snapshot = await buildShellSnapshot(client)
    const configRoute = { ...route(snapshot.routes, 'config'), disabled: false, state: 'available-local' as const }
    const model = await buildConfigEditorModel(client, configRoute)
    const markup = renderToStaticMarkup(<ConfigEditorView client={client} route={configRoute} initialModel={model} />)

    expect(model.state).toBe('degraded')
    expect(model.validationErrors).toEqual(['services.gateway.api.port must be between 1 and 65535'])
    expect(markup).toContain('Validation errors')
    expect(markup).toContain('Setting needs attention.')
    expect(markup).not.toContain('services.gateway.api.port')
    expect(markup).toContain('aria-invalid="true"')
  })

  it('maps config validation request failures before rendering them', async () => {
    const transport = new MockAuroraTransport()
    transport.fail('Config.Validate', 'validation', 'Config.Validate schema backend exploded')
    const client = new Aurora({ transport })
    const snapshot = await buildShellSnapshot(client)
    const configRoute = { ...route(snapshot.routes, 'config'), disabled: false, state: 'available-local' as const }
    const model = await buildConfigEditorModel(client, configRoute)
    const markup = renderToStaticMarkup(<ConfigEditorView client={client} route={configRoute} initialModel={model} />)

    expect(model.state).toBe('degraded')
    expect(markup).toContain('Validation errors')
    expect(markup).toContain('Setting needs attention.')
    expect(markup).not.toContain('Config.Validate')
    expect(markup).not.toContain('schema backend exploded')
  })
})

function renderedCopy(markup: string): string {
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

function route(routes: RouteAvailability[], id: string): RouteAvailability {
  const match = routes.find((candidate) => candidate.item.id === id)
  if (match) return match
  const item = auroraEmbeddedNavItems.find((candidate) => candidate.id === id)
  if (!item) throw new Error(`missing route ${id}`)
  return {
    item: navItemSnapshot(item),
    state: item.fallbackState,
    explanation: 'Embedded in a primary route for this nav revision.',
    providerLabel: 'embedded SDK route',
    blockers: [],
    repairActions: [],
    candidateProviders: [],
    evidenceSources: ['embedded primary route'],
    selectorRequired: false,
    approvalRequired: false,
    routeable: true,
    disabled: false,
    requiresAdminAction: false,
  }
}
