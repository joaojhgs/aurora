import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AuroraClient as Aurora, MockAuroraTransport } from '@aurora/client'
import { ConfigEditorView, buildConfigEditorModel } from '../src/config-editor-view'
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
    expect(markup).toContain('missing:Config.manage')
    expect(markup).toContain('disabled=""')
  })

  it('renders contract detail status from the SDK registry and capability catalog', async () => {
    const snapshot = await buildAdminServicesSnapshot(new Aurora({ transport: new MockAuroraTransport() }))
    const markup = renderToStaticMarkup(<AdminContractsView snapshot={snapshot} />)

    expect(snapshot.loadState).toBe('ready')
    expect(snapshot.contracts.map((contract) => contract.busTopic)).toContain('Auth.AuditLog')
    expect(markup).toContain('Contracts')
    expect(markup).toContain('Auth.AuditLog')
    expect(markup).toContain('Backend')
    expect(markup).toContain('Permissions')
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
    expect(markup).toContain('services.gateway.api.port must be between 1 and 65535')
    expect(markup).toContain('aria-invalid="true"')
  })
})

function route(routes: RouteAvailability[], id: string): RouteAvailability {
  const match = routes.find((candidate) => candidate.item.id === id)
  if (!match) throw new Error(`missing route ${id}`)
  return match
}
