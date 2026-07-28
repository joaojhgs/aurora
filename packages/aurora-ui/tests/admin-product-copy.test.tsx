import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  buildAdminOverviewManifest,
  buildCapabilityGraph,
  capabilityCatalogFixture,
  capabilityGraphCatalogFixture,
  deploymentTopologyFixture,
  gatewayRegistryFixture,
  modelRuntimeCatalogFixture,
} from '@aurora/client'
import { AdminOverviewContent } from '../src/admin-overview-view'
import { AdminServicesView, AdminContractsView, type AdminServicesSnapshot } from '../src/admin-services-view'
import { ConfigEditorView, type ConfigEditorModel } from '../src/config-editor-view'
import { BackupRestoreView } from '../src/backup-restore-view'
import { AdminTokensView, type AdminTokensSnapshot } from '../src/admin-tokens-view'
import { AdminDevicesView, type AdminDevicesSnapshot } from '../src/admin-devices-view'
import { AdminPluginsView, type AdminPluginsSnapshot } from '../src/admin-plugins-view'
import { AdminRbacView, type AdminRbacSnapshot } from '../src/admin-rbac-view'
import { AdminSchedulerView, type AdminSchedulerSnapshot } from '../src/admin-scheduler-view'
import { AdminAuditView, type AdminAuditSnapshot } from '../src/admin-audit-view'
import { ModelsView } from '../src/models-view'
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

  it('keeps devices, tools, access, scheduler, and audit copy product-facing', () => {
    const markup = [
      renderToStaticMarkup(<AdminDevicesView snapshot={devicesSnapshot()} reauthConfirmed={false} />),
      renderToStaticMarkup(<AdminPluginsView client={client()} route={route()} initialSnapshot={pluginsSnapshot()} />),
      renderToStaticMarkup(<AdminRbacView snapshot={rbacSnapshot()} />),
      renderToStaticMarkup(<AdminSchedulerView client={client()} route={route()} initialSnapshot={schedulerSnapshot()} />),
      renderToStaticMarkup(<AdminAuditView snapshot={auditSnapshot()} />),
    ].join(' ')

    expect(markup).toContain('No registered devices were returned by Aurora')
    expect(markup).toContain('No tools are available from Aurora yet')
    expect(markup).toContain('Access &amp; RBAC')
    expect(markup).toContain('Create schedule')
    expect(markup).toContain('Protected detail preview')
    expectSafeProductCopy(markup)
  })

  it('keeps models page copy and ARIA product-facing', () => {
    const markup = renderToStaticMarkup(
      <ModelsView
        client={client()}
        initialCatalog={modelRuntimeCatalogFixture}
        initialGraph={buildCapabilityGraph({
          catalog: capabilityGraphCatalogFixture,
          registry: gatewayRegistryFixture,
          transportKind: 'mock',
        })}
      />
    )

    expect(markup).toContain('Models &amp; Sources')
    expect(markup).toContain('aria-label="Selected source and preferred connected device"')
    expectModelsCopy(markup)
  })

  it('maps hostile admin source errors and dynamic counts before rendering', () => {
    const hostile = 'Config.GetSchemaMetadata backend provider schema route manifest transport proof'
    const overviewMarkup = renderToStaticMarkup(
      <AdminOverviewContent
        manifest={buildAdminOverviewManifest({
          capabilityCatalog: capabilityCatalogFixture,
          registry: gatewayRegistryFixture,
          deploymentTopology: deploymentTopologyFixture,
          generatedAt: '2026-07-28T00:00:00Z',
        })}
        transportKind="mock"
      />
    )
    const hostileMarkup = [
      renderToStaticMarkup(<AdminDevicesView snapshot={{ ...devicesSnapshot(), loadState: 'error', error: hostile }} reauthConfirmed={false} />),
      renderToStaticMarkup(<AdminPluginsView client={client()} route={route()} initialSnapshot={{ ...pluginsSnapshot(), loadState: 'service-unavailable', error: hostile }} />),
      renderToStaticMarkup(<AdminRbacView snapshot={{ ...rbacSnapshot(), loadState: 'error', error: hostile }} />),
      renderToStaticMarkup(<AdminAuditView snapshot={{ ...auditSnapshot(), loadState: 'error', error: hostile }} />),
      renderToStaticMarkup(<BackupRestoreView client={client()} route={{ ...route(), disabled: true, explanation: hostile }} initialList={null} />),
      renderToStaticMarkup(<ConfigEditorView client={client()} route={route()} initialModel={{ ...configModel(), state: 'error', error: hostile }} />),
    ].join(' ')

    expect(overviewMarkup).toContain('actions across')
    expect(overviewMarkup).toContain('feature')
    expectSafeProductCopy(hostileMarkup)
  })
})

function expectSafeProductCopy(markup: string): void {
  const text = copySurface(markup)
  const shared = findForbiddenProductionCopyTerms(text).map((term) => term.id)
  const extra = EXTRA_FORBIDDEN_PRODUCT_TERMS
    .filter((term) => term.pattern.test(text))
    .map((term) => term.id)
  expect([...shared, ...extra], text).toEqual([])
}

function copySurface(markup: string): string {
  return `${visibleText(markup)} ${attributeText(markup)}`
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

function attributeText(markup: string): string {
  const values: string[] = []
  const pattern = /\b(?:aria-label|title|alt|placeholder|disabledreason|disabledReason)=["']([^"']*)["']/giu
  let match: RegExpExecArray | null
  while ((match = pattern.exec(markup)) !== null) {
    values.push(match[1] ?? '')
  }
  return values.join(' ')
}

function expectModelsCopy(markup: string): void {
  const text = copySurface(markup)
  const findings = MODEL_FORBIDDEN_PRODUCT_TERMS
    .filter((term) => term.pattern.test(text))
    .map((term) => term.id)
  expect(findings, text).toEqual([])
}

const EXTRA_FORBIDDEN_PRODUCT_TERMS = [
  { id: 'admin-action', pattern: /\bAdminAction\b/iu },
  { id: 'sdk', pattern: /\bSDK\b/iu },
  { id: 'backend', pattern: /\bbackend\b/iu },
  { id: 'gateway', pattern: /\bGateway\b/iu },
  { id: 'registry', pattern: /\bregistry\b/iu },
  { id: 'route', pattern: /\broute(?:able|s|d)?\b/iu },
] as const

const MODEL_FORBIDDEN_PRODUCT_TERMS = [
  { id: 'runtime', pattern: /\bRuntime\b/iu },
  { id: 'backend', pattern: /\bbackend\b/iu },
  { id: 'provider', pattern: /\bproviders?\b/iu },
  { id: 'backend-option-schema', pattern: /\bbackend option schema\b/iu },
  { id: 'config-schema-method', pattern: /\bConfig\.GetSchemaMetadata\b/iu },
  { id: 'configuration-schema', pattern: /\bconfiguration schema\b/iu },
  { id: 'active-provider', pattern: /\bactive provider\b/iu },
  { id: 'currently-selected-provider', pattern: /\bCurrently selected provider\b/iu },
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

function devicesSnapshot(): AdminDevicesSnapshot {
  return {
    loadState: 'empty',
    generatedAt: '2026-07-28T00:00:00Z',
    secretsRedacted: true,
    devices: [],
    pendingPairings: [],
    listState: 'available-local',
    listReason: 'Ready',
    tokenState: 'available-local',
    tokenReason: 'Ready',
    pairingState: 'available-local',
    pairingReason: 'Ready',
    deleteState: 'unsupported',
    deleteReason: 'Device removal is not ready yet.',
    meshPeerState: 'unsupported',
    meshPeerReason: 'Connected device links are not ready yet.',
    meshPeerActionState: 'unsupported',
    meshPeerActionReason: 'Trust actions are not ready yet.',
    nativePlatform: null,
    nativeCapabilities: [],
    warnings: [],
    error: null,
    evidenceSource: 'Aurora service response',
  }
}

function pluginsSnapshot(): AdminPluginsSnapshot {
  return {
    loadState: 'empty',
    policy: {
      mode: 'enforce',
      defaultBehavior: 'No tools are available from Aurora yet.',
      activeGrantCount: 0,
      pendingApprovalCount: 0,
      blockedCount: 0,
      sourceCount: 0,
      bypassEnabled: false,
      dryRunOnly: false,
      denyAll: false,
      lastChanged: 'not reported',
      actor: 'not reported',
      evidence: 'This device',
    },
    sourceSummaries: [],
    sourceDetails: {},
    fallbackTools: [],
    warnings: [],
    error: null,
    evidenceSource: 'Aurora service response',
  }
}

function rbacSnapshot(): AdminRbacSnapshot {
  return {
    loadState: 'empty',
    generatedAt: '2026-07-28T00:00:00Z',
    secretsRedacted: true,
    principals: [],
    roles: [],
    permissions: [],
    permissionCatalog: [],
    audit: [],
    mutationState: 'unsupported',
    mutationReason: 'Permission changes are not ready yet.',
    warnings: [],
    error: null,
    evidenceSource: 'Aurora service response',
  }
}

function schedulerSnapshot(): AdminSchedulerSnapshot {
  return {
    loadState: 'empty',
    jobs: [],
    createControl: {
      available: false,
      state: 'unsupported',
      reason: 'Schedule creation is not ready in this version.',
      requiresAdminAction: true,
      targetOptions: [{ id: 'local-peer', label: 'Local scheduler', disabled: true, reason: 'No scheduler target was returned by Aurora.' }],
    },
    totals: { local: 0, delegatedOwned: 0, remoteRunning: 0, foreignDenied: 0 },
    warnings: [],
    error: null,
    evidenceSource: 'Aurora service response',
    secretsRedacted: true,
    toolOptions: [],
  }
}

function auditSnapshot(): AdminAuditSnapshot {
  return {
    loadState: 'ready',
    generatedAt: '2026-07-28T00:00:00Z',
    secretsRedacted: true,
    backendFilter: { limit: 100, offset: 0 },
    filters: {
      query: '',
      event: 'all',
      actor: '',
      action: '',
      resource: '',
      createdAfter: '',
      createdBefore: '',
      principalId: '',
      peerOrProvider: '',
      routePath: '',
      approvalMode: 'all',
      status: 'all',
      toolId: '',
      dataNamespace: '',
      audioSessionId: '',
      schedulerJobId: '',
      correlationId: '',
      denialReason: '',
    },
    rows: [{
      id: 'audit-1',
      event: 'admin_action.confirmed',
      principalId: 'admin',
      action: 'Gateway.GetSupportBundle',
      status: 'approved',
      createdAt: '2026-07-28T00:00:00Z',
      correlationId: 'corr-admin-001',
      peerId: 'local',
      providerId: 'local service',
      routePath: 'Gateway.GetSupportBundle',
      approvalMode: 'single',
      toolId: 'not applicable',
      dataNamespace: 'not applicable',
      audioSessionId: 'not applicable',
      schedulerJobId: 'not applicable',
      denialReason: 'none',
      receipt: 'receipt-admin-001',
      payloadHash: 'sha256:safe',
      supportBundleCorrelationIds: ['corr-admin-001'],
      details: {},
      redactedPreview: '{}',
      lifecycleLabel: 'approved',
      rawEvent: {} as never,
    }],
    total: 1,
    warnings: [],
    error: null,
    evidenceSource: 'Aurora service response',
    exportState: 'available-local',
    exportReason: 'Export includes protected activity rows, receipts, and support references.',
  }
}

function client() {
  return {
    transport: { kind: 'http' },
    config: {},
    backups: {},
    tools: {},
    scheduler: {},
    registry: {},
    capabilities: {},
  } as never
}
