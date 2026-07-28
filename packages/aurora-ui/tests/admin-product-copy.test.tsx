import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AdminOverviewContent } from '../src/admin-overview-view'
import { AdminServicesView, AdminContractsView, type AdminServicesSnapshot } from '../src/admin-services-view'
import { ConfigEditorView, type ConfigEditorModel } from '../src/config-editor-view'
import { BackupRestoreView } from '../src/backup-restore-view'
import { AdminTokensView, type AdminTokensSnapshot } from '../src/admin-tokens-view'
import { findForbiddenProductionCopyTerms } from '../src/product-copy-forbidden-terms'
import type { RouteAvailability } from '../src/shell-data'

describe('admin product copy', () => {
  it('keeps admin overview and action browser copy product-facing', () => {
    const markup = [
      renderToStaticMarkup(<AdminOverviewContent manifest={null} transportKind="http" error={{ code: 'transport_loss' }} />),
      renderToStaticMarkup(<AdminServicesView snapshot={servicesSnapshot()} />),
      renderToStaticMarkup(<AdminContractsView snapshot={servicesSnapshot()} />),
    ].join(' ')

    expect(markup).toContain('Aurora could not load the service overview')
    expect(markup).toContain('Service actions')
    expect(markup).toContain('Available from this screen')
    expectSafeProductCopy(markup)
  })

  it('keeps admin empty and error states free of internal wording', () => {
    const markup = [
      renderToStaticMarkup(<ConfigEditorView client={client()} route={route()} initialModel={configModel()} />),
      renderToStaticMarkup(<BackupRestoreView client={client()} route={{ ...route(), disabled: true, routeable: false }} initialList={null} />),
      renderToStaticMarkup(<AdminTokensView snapshot={tokensSnapshot()} />),
    ].join(' ')

    expect(markup).toContain('No settings')
    expect(markup).toContain('Backup operations are disabled until Aurora reports backup actions are ready')
    expect(markup).toContain('Admin approval is required before this action can run')
    expectSafeProductCopy(markup)
  })
})

function expectSafeProductCopy(markup: string): void {
  const text = visibleText(markup)
  const shared = findForbiddenProductionCopyTerms(text).map((term) => term.id)
  const extra = EXTRA_FORBIDDEN_PRODUCT_TERMS
    .filter((term) => term.pattern.test(text))
    .map((term) => term.id)
  expect([...shared, ...extra], text).toEqual([])
}

function visibleText(markup: string): string {
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

const EXTRA_FORBIDDEN_PRODUCT_TERMS = [
  { id: 'admin-action', pattern: /\bAdminAction\b/iu },
  { id: 'sdk', pattern: /\bSDK\b/iu },
  { id: 'backend', pattern: /\bbackend\b/iu },
  { id: 'gateway', pattern: /\bGateway\b/iu },
  { id: 'registry', pattern: /\bregistry\b/iu },
  { id: 'route', pattern: /\broute(?:able|s|d)?\b/iu },
] as const

function route(): RouteAvailability {
  return {
    item: {
      id: 'backup',
      label: 'Backups',
      href: '/admin/backups',
      capabilityModule: 'Backup',
      capabilityMethod: 'List',
      methodType: 'manage',
      privacyClass: 'admin-critical',
      fallbackState: 'unsupported',
      adminGated: true,
      expectedTask: 'BACKUP',
    },
    state: 'unsupported',
    explanation: 'not ready',
    providerLabel: 'This device',
    blockers: [],
    repairActions: [],
    candidateProviders: [],
    evidenceSources: [],
    selectorRequired: false,
    approvalRequired: true,
    routeable: false,
    disabled: false,
    requiresAdminAction: true,
  }
}

function servicesSnapshot(): AdminServicesSnapshot {
  return {
    loadState: 'ready',
    servicesMode: 'processes',
    generatedAt: '2026-07-28T00:00:00Z',
    secretsRedacted: true,
    services: [{
      module: 'Config',
      version: '1.0.0',
      summary: 'Configuration service',
      capabilities: ['reload'],
      methodCount: 1,
      lastSeen: '2026-07-28T00:00:00Z',
      status: 'healthy',
      healthState: 'available-local',
      instanceId: 'config-local',
      providerLabel: 'This device',
      routeState: 'available-local',
      routeReason: 'Ready',
      privacyClass: 'admin-critical',
      methods: [],
      controls: [{
        verb: 'restart',
        methodId: 'Supervisor.RestartService',
        state: 'unsupported',
        available: false,
        requiresAdminAction: true,
        reason: 'Service controls are not ready for this view.',
        action: null,
      }],
    }],
    contracts: [{
      name: 'ReloadService',
      summary: 'Reload configuration values.',
      busTopic: 'Config.ReloadService',
      module: 'Config',
      routePath: '/api/Config/ReloadService',
      availableOverHttp: true,
      exposure: 'external',
      methodType: 'manage',
      inputModel: 'ReloadRequest',
      outputModel: 'ReloadResponse',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      requiredPermissions: ['Config.manage'],
      availability: 'available-local',
      providerLabel: 'This device',
      backendCoverage: 'http',
      privacyClass: 'admin-critical',
      routeReason: 'Ready',
      liveRegistryStatus: 'live-registry',
      conformanceStatus: 'conformant',
      generatedRoutePath: '/api/Config/ReloadService',
      openApiState: 'Available from this screen.',
      exportState: 'Ready',
      schemaState: 'request details, response details',
      capabilityPermissions: ['Config.manage'],
    } as never],
    warnings: [],
    error: null,
    evidenceSource: 'Aurora service response',
  }
}

function configModel(): ConfigEditorModel {
  return {
    state: 'empty',
    fields: [],
    versions: [],
    validationErrors: [],
    secretsRedacted: true,
    evidence: 'This device',
    error: null,
  }
}

function tokensSnapshot(): AdminTokensSnapshot {
  return {
    loadState: 'ready',
    tokens: [{
      id: 'tok_1',
      prefix: 'aurora',
      userId: 'user_1',
      owner: 'Admin',
      deviceId: null,
      scopes: ['Config.manage'],
      createdAt: '2026-07-28T00:00:00Z',
      expiresAt: null,
      lastUsedAt: null,
      status: 'active',
      listState: 'available-local',
      listReason: 'Ready',
      revokeState: 'available-local',
      revokeReason: 'Admin approval is required before this action can run.',
      revokeAction: {
        title: 'Revoke token aurora',
        description: 'Aurora will revoke this token only after admin confirmation and audit logging.',
        methodId: 'Auth.RevokeToken',
        payload: { token_id: 'tok_1' },
        affectedResources: ['token:tok_1'],
        severity: 'critical',
        reason: 'Revoke scoped API token',
        requiresAdminAction: true,
      },
      rotateAction: null,
    }],
    listState: 'available-local',
    listReason: 'Ready',
    revokeState: 'available-local',
    revokeReason: 'Admin approval is required before this action can run.',
    createState: 'unsupported',
    createReason: 'Token creation is not ready in this Aurora version.',
    secretsRedacted: true,
    warnings: [],
    error: null,
    evidenceSource: 'Aurora service response',
    oneTimeReveal: null,
  }
}

function client() {
  return {
    transport: { kind: 'http' },
    config: {},
    backups: {},
  } as never
}
