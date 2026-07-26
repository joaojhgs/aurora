import type { ContractMethodType, PrivacyClass } from '@aurora/client'

export type ProductionSurfaceId =
  | 'assistant-route-sheet'
  | 'admin-overview'
  | 'admin-services'
  | 'admin-contracts'
  | 'admin-rbac'
  | 'admin-audit'
  | 'admin-plugins'
  | 'admin-devices'
  | 'admin-scheduler'
  | 'config-editor'
  | 'memory-rag'
  | 'backup-restore'
  | 'models-runtime'
  | 'mesh-peers'
  | 'mesh-diagnostics'
  | 'route-policy'
  | 'resource-diagnostics'
  | 'settings-permissions-privacy'
  | 'native-capabilities'
  | 'onboarding-auth-pairing'

export type ProductionTruthSourceKind =
  | 'sdk-method'
  | 'capability-graph'
  | 'native-manifest'
  | 'admin-action'
  | 'unsupported-degraded'

export type ProductionRouteState =
  | 'loading'
  | 'empty'
  | 'error'
  | 'offline'
  | 'permission'
  | 'admin-action'
  | 'unsupported'
  | 'privacy'
  | 'native-permission'

export interface ProductionTruthSource {
  kind: ProductionTruthSourceKind
  label: string
  methods: string[]
  evidence: string
}

export interface ProductionRouteOracle {
  navItemId: string
  renderedLandmarks: string[]
  routeSpecificControls: string[]
}

export interface ProductionSurfaceContract {
  id: ProductionSurfaceId
  label: string
  navItemIds: string[]
  routeOracles?: ProductionRouteOracle[]
  mockReferenceFiles: string[]
  mockUxAnchors: string[]
  componentFiles: string[]
  stateCoverage: ProductionRouteState[]
  truthSources: ProductionTruthSource[]
  highestPrivacyClass: PrivacyClass
  mutatingMethodType: ContractMethodType | 'none'
  adminActionRequired: boolean
  fixturePolicy: 'test-only' | 'none'
  degradedState: string
  coverage: string[]
}


export const productionGlobalMockReferences = [
  'components/aurora/app-shell.tsx',
  'components/aurora/page-header.tsx',
  'components/aurora/status-badges.tsx'
] as const

export const requiredProductionMockReferenceFiles = [
  ...productionGlobalMockReferences,
  'components/aurora/assistant/assistant-view.tsx',
  'components/aurora/assistant/route-sheet.tsx',
  'components/aurora/assistant/tool-call-card.tsx',
  'components/aurora/mesh/mesh-view.tsx',
  'components/aurora/models/models-view.tsx',
  'components/aurora/admin/overview.tsx',
  'components/aurora/admin/services-view.tsx',
  'components/aurora/admin/rbac-view.tsx',
  'components/aurora/admin/tokens-view.tsx',
  'components/aurora/admin/devices-view.tsx',
  'components/aurora/admin/config-view.tsx',
  'components/aurora/admin/audit-view.tsx',
  'components/aurora/admin/secondary-surface.tsx',
  'app/(cockpit)/memory/page.tsx',
  'app/(cockpit)/tools/page.tsx',
  'components/aurora/diagnostics/diagnostics-view.tsx',
  'components/aurora/onboarding/onboarding-view.tsx',
  'components/aurora/settings/settings-permissions-view.tsx'
] as const

export const productionSurfaceContracts: ProductionSurfaceContract[] = [
  {
    id: 'assistant-route-sheet',
    label: 'Assistant and RouteSheet',
    navItemIds: ['assistant', 'assistant-cancel', 'voice-transcription', 'voice-wake-process', 'voice-wake-control', 'voice-tts-synthesize', 'voice-tts-stop'],
    routeOracles: [routeOracle('assistant', ['Assistant', 'Prompt'], ['Assistant conversation list', 'Send'])],
    mockReferenceFiles: ['components/aurora/assistant/assistant-view.tsx', 'components/aurora/assistant/route-sheet.tsx', 'components/aurora/assistant/tool-call-card.tsx'],
    mockUxAnchors: ['Conversation rail', 'Route and privacy', 'Voice modes', 'Tool call approval card'],
    componentFiles: ['assistant-view.tsx', 'route-sheet.tsx', 'tool-approval-panel.tsx'],
    stateCoverage: ['loading', 'empty', 'error', 'offline', 'permission', 'unsupported', 'admin-action', 'privacy', 'native-permission'],
    truthSources: [
      source('sdk-method', 'assistant request/interrupt/event SDK methods', ['Orchestrator.ExternalUserInput', 'Orchestrator.Interrupt', 'Aurora.EventStream']),
      source('capability-graph', 'route and privacy policy evaluation', ['Gateway.GetCapabilityCatalog', 'Gateway.ExplainRoute']),
      source('admin-action', 'tool approval and admin-critical route guard', ['Gateway.AdminActionDraft', 'Gateway.AdminActionConfirm', 'Tooling.RequestApproval', 'Tooling.ConfirmExecution'])
    ],
    highestPrivacyClass: 'raw-audio',
    mutatingMethodType: 'use',
    adminActionRequired: true,
    fixturePolicy: 'test-only',
    degradedState: 'Not ready, denied, privacy-blocked, or unconfirmed AdminAction states disable send/confirm controls.',
    coverage: ['packages/aurora-ui/tests/shell.test.tsx', 'packages/aurora-sdk/tests/conformance.test.ts']
  },
  {
    id: 'admin-overview',
    label: 'Admin overview',
    navItemIds: ['admin'],
    routeOracles: [routeOracle('admin', ['Admin overview'], ['AdminAction controller'])],
    mockReferenceFiles: ['components/aurora/admin/overview.tsx'],
    mockUxAnchors: ['AdminAction controller', 'Runtime topology', 'Deployment posture'],
    componentFiles: ['admin-overview-view.tsx', 'shell-data.ts'],
    stateCoverage: ['loading', 'empty', 'error', 'offline', 'permission', 'unsupported'],
    truthSources: [
      source('capability-graph', 'admin posture and capability summary', ['Gateway.GetCapabilityCatalog']),
      source('sdk-method', 'registry and deployment state', ['Gateway.GetRegistry', 'Gateway.GetDeploymentTopology'])
    ],
    highestPrivacyClass: 'admin-critical',
    mutatingMethodType: 'none',
    adminActionRequired: false,
    fixturePolicy: 'test-only',
    degradedState: 'Service controls remain previews until the matching capability and AdminAction are advertised.',
    coverage: ['packages/aurora-ui/tests/shell.test.tsx']
  },
  {
    id: 'admin-services',
    label: 'Admin services',
    navItemIds: ['services'],
    routeOracles: [routeOracle('services', ['Services'], ['Services table with health'])],
    mockReferenceFiles: ['components/aurora/admin/services-view.tsx'],
    mockUxAnchors: ['Services', 'Backend service health', 'Restart control is not available for this service.'],
    componentFiles: ['admin-services-view.tsx'],
    stateCoverage: ['loading', 'empty', 'error', 'offline', 'permission', 'unsupported', 'admin-action'],
    truthSources: [
      source('sdk-method', 'service registry descriptors', ['Gateway.GetServices']),
      source('admin-action', 'service lifecycle boundary', ['Supervisor.Restart', 'Gateway.AdminActionDraft', 'Gateway.AdminActionConfirm'])
    ],
    highestPrivacyClass: 'admin-critical',
    mutatingMethodType: 'manage',
    adminActionRequired: true,
    fixturePolicy: 'test-only',
    degradedState: 'Internal-only or unadvertised lifecycle controls render disabled with backend-derived reasons.',
    coverage: ['packages/aurora-ui/tests/shell.test.tsx']
  },
  {
    id: 'admin-contracts',
    label: 'Admin contracts registry',
    navItemIds: ['contracts'],
    routeOracles: [routeOracle('contracts', ['Contracts registry'], ['Search contracts'])],
    mockReferenceFiles: ['components/aurora/admin/services-view.tsx'],
    mockUxAnchors: ['Contracts registry', 'Contract registry browser', 'Search contracts', 'Method detail'],
    componentFiles: ['admin-services-view.tsx'],
    stateCoverage: ['loading', 'empty', 'error', 'offline', 'permission', 'unsupported'],
    truthSources: [
      source('sdk-method', 'method registry descriptors', ['Gateway.GetRegistry']),
      source('capability-graph', 'contract route and permission conformance', ['Gateway.GetCapabilityCatalog'])
    ],
    highestPrivacyClass: 'public',
    mutatingMethodType: 'none',
    adminActionRequired: false,
    fixturePolicy: 'test-only',
    degradedState: 'Registry-only, internal-only, or missing-capability contracts remain visible with backend-derived conformance reasons.',
    coverage: ['packages/aurora-ui/tests/admin-contracts-view.test.tsx', 'packages/aurora-ui/tests/shell.test.tsx']
  },
  {
    id: 'admin-rbac',
    label: 'Admin RBAC',
    navItemIds: ['access', 'tokens'],
    routeOracles: [
      routeOracle('access', ['RBAC'], ['Permission matrix']),
      routeOracle('tokens', ['RBAC'], ['Scoped token inventory'])
    ],
    mockReferenceFiles: ['components/aurora/admin/rbac-view.tsx', 'components/aurora/admin/tokens-view.tsx'],
    mockUxAnchors: ['Access & RBAC', 'PermissionEditorTable', 'API tokens issued to principals, with their granted scopes.'],
    componentFiles: ['admin-rbac-view.tsx', 'admin-tokens-view.tsx'],
    stateCoverage: ['loading', 'empty', 'error', 'offline', 'permission', 'unsupported', 'admin-action'],
    truthSources: [
      source('sdk-method', 'principal, permission, and token lists', ['Auth.ListPrincipals', 'Auth.ListTokens', 'Auth.AuditLog']),
      source('admin-action', 'permission and token mutations', ['Auth.PatchPermissions', 'Auth.SetPermissions', 'Auth.RevokeToken', 'Gateway.AdminActionDraft', 'Gateway.AdminActionConfirm'])
    ],
    highestPrivacyClass: 'credential',
    mutatingMethodType: 'manage',
    adminActionRequired: true,
    fixturePolicy: 'test-only',
    degradedState: 'Permission patches and token revocation stay disabled without AdminAction/audit support.',
    coverage: ['packages/aurora-ui/tests/shell.test.tsx']
  },
  {
    id: 'admin-audit',
    label: 'Admin audit log',
    navItemIds: ['audit'],
    routeOracles: [routeOracle('audit', ['Audit log'], ['Filters'])],
    mockReferenceFiles: ['components/aurora/admin/audit-view.tsx'],
    mockUxAnchors: ['Audit log', 'Filters', 'Redacted event details', 'Redacted payload preview'],
    componentFiles: ['admin-audit-view.tsx'],
    stateCoverage: ['loading', 'empty', 'error', 'offline', 'permission', 'unsupported'],
    truthSources: [source('sdk-method', 'redacted audit records', ['Auth.AuditLog'])],
    highestPrivacyClass: 'sensitive',
    mutatingMethodType: 'none',
    adminActionRequired: false,
    fixturePolicy: 'test-only',
    degradedState: 'Audit export is disabled when audit records or redacted support state are unavailable.',
    coverage: ['packages/aurora-ui/tests/shell.test.tsx']
  },
  {
    id: 'admin-plugins',
    label: 'Admin plugins and tools',
    navItemIds: ['plugins', 'tools'],
    routeOracles: [
      routeOracle('plugins', ['Plugins, MCP, and tools'], ['Reload catalog']),
      routeOracle('tools', ['Tool registry and Approval cards'], ['Tool search', 'Tool detail drawer', 'Tool parameters', 'MCP server status', 'Open scheduler'])
    ],
    mockReferenceFiles: ['app/(cockpit)/tools/page.tsx'],
    mockUxAnchors: ['Tools &amp; Plugins', 'grouped by source', 'Add MCP source', 'Policy:'],
    componentFiles: ['admin-plugins-view.tsx', 'tool-approval-panel.tsx'],
    stateCoverage: ['loading', 'empty', 'error', 'offline', 'permission', 'unsupported', 'admin-action'],
    truthSources: [
      source('sdk-method', 'aggregate tool catalog', ['Tooling.GetToolCatalog']),
      source('sdk-method', 'scheduler snapshot for automation handoff', ['Scheduler.ListJobs']),
      source('admin-action', 'tool/plugin mutations and approval flow', ['Tooling.PrepareExecution', 'Tooling.RequestApproval', 'Tooling.ConfirmExecution', 'Tooling.ExecuteTool', 'Gateway.AdminActionDraft', 'Gateway.AdminActionConfirm'])
    ],
    highestPrivacyClass: 'admin-critical',
    mutatingMethodType: 'manage',
    adminActionRequired: true,
    fixturePolicy: 'test-only',
    degradedState: 'Reload, install, sharing, and approval-required execution remain gated by catalog policy and AdminAction.',
    coverage: ['packages/aurora-ui/tests/shell.test.tsx']
  },
  {
    id: 'admin-devices',
    label: 'Admin devices',
    navItemIds: ['devices'],
    routeOracles: [routeOracle('devices', ['Devices'], ['Registered devices'])],
    mockReferenceFiles: ['components/aurora/admin/devices-view.tsx'],
    mockUxAnchors: ['Devices and sessions', 'Pending pairings', 'Delete device', 'Sessions'],
    componentFiles: ['admin-devices-view.tsx'],
    stateCoverage: ['loading', 'empty', 'error', 'offline', 'permission', 'unsupported', 'admin-action'],
    truthSources: [
      source('sdk-method', 'device/session list', ['Auth.ListDevices']),
      source('admin-action', 'device deletion and session revocation', ['Auth.DeleteDevice', 'Gateway.AdminActionDraft', 'Gateway.AdminActionConfirm'])
    ],
    highestPrivacyClass: 'credential',
    mutatingMethodType: 'manage',
    adminActionRequired: true,
    fixturePolicy: 'test-only',
    degradedState: 'Device deletion renders as pending/rollback until refreshed backend state confirms the mutation.',
    coverage: ['packages/aurora-ui/tests/shell.test.tsx']
  },
  {
    id: 'admin-scheduler',
    label: 'Admin scheduler',
    navItemIds: ['scheduler'],
    routeOracles: [routeOracle('scheduler', ['Scheduler'], ['Jobs'])],
    mockReferenceFiles: ['app/(cockpit)/tools/page.tsx'],
    mockUxAnchors: ['Scheduler jobs', 'Ownership-scoped job table', 'Running on remote peer', 'Scheduler admin change'],
    componentFiles: ['admin-scheduler-view.tsx'],
    stateCoverage: ['loading', 'empty', 'error', 'offline', 'permission', 'unsupported', 'admin-action'],
    truthSources: [
      source('sdk-method', 'scheduler job inventory', ['Scheduler.ListJobs']),
      source('admin-action', 'scheduler create/cancel/pause/resume controls', ['Scheduler.Schedule', 'Scheduler.Cancel', 'Scheduler.Pause', 'Scheduler.Resume', 'Gateway.AdminActionDraft', 'Gateway.AdminActionConfirm'])
    ],
    highestPrivacyClass: 'admin-critical',
    mutatingMethodType: 'manage',
    adminActionRequired: true,
    fixturePolicy: 'test-only',
    degradedState: 'Not ready scheduler methods stay disabled when registry/capability descriptors do not advertise manage access.',
    coverage: ['packages/aurora-ui/tests/shell.test.tsx', 'packages/aurora-sdk/tests/scheduler.test.ts']
  },
  {
    id: 'config-editor',
    label: 'Config editor',
    navItemIds: ['config'],
    routeOracles: [routeOracle('config', ['Configuration'], ['Preview diff'])],
    mockReferenceFiles: ['components/aurora/admin/config-view.tsx'],
    mockUxAnchors: ['Configuration', 'Schema-backed config accordion', 'diff preview', 'rollback'],
    componentFiles: ['config-editor-view.tsx'],
    stateCoverage: ['loading', 'empty', 'error', 'offline', 'permission', 'unsupported', 'admin-action'],
    truthSources: [
      source('sdk-method', 'config schema, diff, history, and reload impact', ['Config.GetSchemaMetadata', 'Config.PreviewDiff', 'Config.GetVersionHistory', 'Config.PreviewReloadImpact']),
      source('admin-action', 'config set and rollback', ['Config.Set', 'Config.Rollback', 'Gateway.AdminActionDraft', 'Gateway.AdminActionConfirm'])
    ],
    highestPrivacyClass: 'secret',
    mutatingMethodType: 'manage',
    adminActionRequired: true,
    fixturePolicy: 'test-only',
    degradedState: 'Secrets are redacted; apply/rollback controls require AdminAction and schema-derived validation.',
    coverage: ['packages/aurora-ui/tests/shell.test.tsx']
  },
  {
    id: 'memory-rag',
    label: 'Memory, RAG, and data policy',
    navItemIds: ['memory', 'data'],
    routeOracles: [
      routeOracle('memory', ['Memory & Knowledge'], ['Search memory and RAG']),
      routeOracle('data', ['Data policy and retention'], ['Audit trail for policy changes'])
    ],
    mockReferenceFiles: ['app/(cockpit)/memory/page.tsx'],
    mockUxAnchors: ['Memory & Knowledge', 'Memory collections', 'Search conversations', 'Export, delete, and import data flows', 'Data policy and retention', 'Audit trail for policy changes'],
    componentFiles: ['memory-view.tsx', 'data-policy-view.tsx'],
    stateCoverage: ['loading', 'empty', 'error', 'offline', 'permission', 'unsupported', 'admin-action', 'privacy'],
    truthSources: [
      source('sdk-method', 'message history and RAG namespace/search/provenance surfaces', ['DB.GetMessages', 'DB.GetMessagesForDate', 'DB.RAGSearch', 'DB.RAGListNamespaces', 'DB.RAGSearchRemote', 'DB.RAGGetProvenance']),
      source('admin-action', 'RAG export/import/delete governance', ['DB.RAGExportNamespace', 'DB.RAGImportNamespace', 'DB.RAGDelete', 'Gateway.AdminActionDraft', 'Gateway.AdminActionConfirm']),
      source('unsupported-degraded', 'raw SQL and replication are intentionally blocked', [])
    ],
    highestPrivacyClass: 'sensitive',
    mutatingMethodType: 'manage',
    adminActionRequired: true,
    fixturePolicy: 'test-only',
    degradedState: 'Export/import/delete controls remain disabled behind AdminAction or explicit data-sharing policy.',
    coverage: ['packages/aurora-ui/tests/shell.test.tsx']
  },
  {
    id: 'backup-restore',
    label: 'Backup and restore',
    navItemIds: ['backups'],
    routeOracles: [routeOracle('backups', ['Backups & Restore'], ['Create backup'])],
    mockReferenceFiles: ['components/aurora/admin/secondary-surface.tsx'],
    mockUxAnchors: ['Restore backup', 'Create backup', 'Restore dry-run complete', 'Restore and rollback require admin confirmation.'],
    componentFiles: ['backup-restore-view.tsx'],
    stateCoverage: ['loading', 'empty', 'error', 'offline', 'permission', 'unsupported', 'admin-action'],
    truthSources: [
      source('sdk-method', 'backup manifest list and verification', ['Backup.List', 'Backup.Create', 'Backup.Verify', 'Backup.RestoreDryRun', 'Backup.RollbackPlan']),
      source('admin-action', 'backup create, restore preview, and rollback', ['Gateway.AdminActionDraft', 'Gateway.AdminActionConfirm'])
    ],
    highestPrivacyClass: 'admin-critical',
    mutatingMethodType: 'manage',
    adminActionRequired: true,
    fixturePolicy: 'test-only',
    degradedState: 'Create, verify, restore, and rollback controls are disabled without backup capability and AdminAction state.',
    coverage: ['packages/aurora-ui/tests/shell.test.tsx']
  },
  {
    id: 'models-runtime',
    label: 'Models and runtime catalog',
    navItemIds: ['models'],
    routeOracles: [routeOracle('models', ['Models and runtime'], ['Provider route policy'])],
    mockReferenceFiles: ['components/aurora/models/models-view.tsx'],
    mockUxAnchors: ['Models & Runtime', 'Model runtime catalog', 'External providers remain policy-gated by Aurora.', 'Usage & Benchmarks'],
    componentFiles: ['models-view.tsx'],
    stateCoverage: ['loading', 'empty', 'error', 'offline', 'permission', 'unsupported', 'admin-action', 'privacy'],
    truthSources: [
      source('sdk-method', 'model runtime catalog and operation status', ['Orchestrator.GetModelCatalog', 'Orchestrator.GetModelRuntime', 'Orchestrator.GetModelOperation']),
      source('admin-action', 'model import, download, benchmark, and selection mutations', ['Orchestrator.ImportModel', 'Orchestrator.DownloadModel', 'Orchestrator.BenchmarkModel', 'Gateway.AdminActionDraft', 'Gateway.AdminActionConfirm']),
      source('capability-graph', 'provider availability and route privacy state', ['Gateway.GetCapabilityCatalog'])
    ],
    highestPrivacyClass: 'personal',
    mutatingMethodType: 'manage',
    adminActionRequired: true,
    fixturePolicy: 'test-only',
    degradedState: 'Import, download, benchmark, and selection controls remain disabled until backend descriptors allow them.',
    coverage: ['packages/aurora-ui/tests/shell.test.tsx']
  },
  {
    id: 'mesh-peers',
    label: 'Mesh peers and pairing lifecycle',
    navItemIds: ['mesh', 'pairing'],
    routeOracles: [
      routeOracle('mesh', ['Mesh peers'], ['Pair new peer']),
      routeOracle('pairing', ['Pairing queue'], ['Pairing queue controls'])
    ],
    mockReferenceFiles: ['components/aurora/mesh/mesh-view.tsx'],
    mockUxAnchors: ['Mesh &amp; Peers', 'Connected peers', 'Pending requests', 'Connect peer'],
    componentFiles: ['mesh-peers-view.tsx', 'pairing-queue-view.tsx'],
    stateCoverage: ['loading', 'empty', 'error', 'offline', 'permission', 'unsupported', 'admin-action'],
    truthSources: [
      source('sdk-method', 'mesh status, persisted peers, and pairing queue', ['Gateway.GetMeshStatus', 'Auth.MeshListPeers', 'Auth.MeshGetPeer', 'Auth.ListPendingPairings']),
      source('admin-action', 'peer approve/deny/remove and pairing approve/deny', ['Auth.MeshApprovePeer', 'Auth.MeshDenyPeer', 'Auth.MeshRemovePeer', 'Auth.PairingApprove', 'Auth.PairingDeny', 'Gateway.AdminActionDraft', 'Gateway.AdminActionConfirm'])
    ],
    highestPrivacyClass: 'credential',
    mutatingMethodType: 'manage',
    adminActionRequired: true,
    fixturePolicy: 'test-only',
    degradedState: 'Presence never counts as pairing success; pending/denied/stale states stay visible until Auth/Gateway state changes.',
    coverage: ['packages/aurora-ui/tests/shell.test.tsx']
  },
  {
    id: 'mesh-diagnostics',
    label: 'Mesh diagnostics',
    navItemIds: ['diagnostics', 'mesh'],
    routeOracles: [routeOracle('diagnostics', ['Native boundary'], ['Live probes'])],
    mockReferenceFiles: ['components/aurora/diagnostics/diagnostics-view.tsx'],
    mockUxAnchors: ['Diagnostics', 'Live probes', 'Redaction preview', 'Timeline'],
    componentFiles: ['mesh-diagnostics-view.tsx', 'mesh-diagnostics-resource.tsx'],
    stateCoverage: ['loading', 'empty', 'error', 'offline', 'permission', 'unsupported'],
    truthSources: [
      source('sdk-method', 'mesh, WebRTC, topology, and redacted support state', ['Gateway.GetMeshStatus', 'Gateway.GetWebRTCDiagnostics', 'Gateway.GetDeploymentTopology', 'Gateway.GetSupportBundle']),
      source('capability-graph', 'provider candidates and route blockers', ['Gateway.GetCapabilityCatalog'])
    ],
    highestPrivacyClass: 'sensitive',
    mutatingMethodType: 'none',
    adminActionRequired: false,
    fixturePolicy: 'test-only',
    degradedState: 'Diagnostics show stale/denied/unavailable reasons instead of treating candidates as executable.',
    coverage: ['packages/aurora-ui/tests/shell.test.tsx']
  },
  {
    id: 'route-policy',
    label: 'Route policy',
    navItemIds: ['mesh', 'settings'],
    mockReferenceFiles: ['components/aurora/assistant/route-sheet.tsx', 'components/aurora/settings/settings-permissions-view.tsx'],
    mockUxAnchors: ['Route policy decisions', 'Route explain scenarios', 'Tool call', 'Scheduler delegation'],
    componentFiles: ['route-policy-view.tsx', 'route-sheet.tsx'],
    stateCoverage: ['loading', 'empty', 'error', 'offline', 'permission', 'unsupported', 'admin-action', 'privacy'],
    truthSources: [
      source('sdk-method', 'route explain and config policy state', ['Gateway.ExplainRoute', 'Config.Get']),
      source('admin-action', 'route policy mutation', ['Config.Set', 'Gateway.AdminActionDraft', 'Gateway.AdminActionConfirm'])
    ],
    highestPrivacyClass: 'admin-critical',
    mutatingMethodType: 'manage',
    adminActionRequired: true,
    fixturePolicy: 'test-only',
    degradedState: 'Explicit selector failure remains a hard failure; fallback is shown only when backend policy says it was used.',
    coverage: ['packages/aurora-ui/tests/shell.test.tsx']
  },
  {
    id: 'resource-diagnostics',
    label: 'Resource diagnostics',
    navItemIds: ['diagnostics'],
    mockReferenceFiles: ['components/aurora/diagnostics/diagnostics-view.tsx'],
    mockUxAnchors: ['Diagnostics', 'Live probes', 'Redaction preview', 'Transport'],
    componentFiles: ['mesh-diagnostics-resource.tsx', 'mesh-diagnostics-view.tsx'],
    stateCoverage: ['loading', 'empty', 'error', 'offline', 'permission', 'unsupported'],
    truthSources: [
      source('capability-graph', 'capability resources and provider candidates', ['Gateway.GetCapabilityCatalog']),
      source('sdk-method', 'route and WebRTC diagnostics', ['Gateway.ExplainRoute', 'Gateway.GetWebRTCDiagnostics'])
    ],
    highestPrivacyClass: 'sensitive',
    mutatingMethodType: 'none',
    adminActionRequired: false,
    fixturePolicy: 'test-only',
    degradedState: 'Resource rows expose unsupported/degraded reasons and never execute from diagnostic graph-only state.',
    coverage: ['packages/aurora-ui/tests/shell.test.tsx']
  },
  {
    id: 'settings-permissions-privacy',
    label: 'Settings, permissions, and privacy',
    navItemIds: ['settings'],
    routeOracles: [routeOracle('settings', ['Settings and permissions'], ['Route and fallback policy'])],
    mockReferenceFiles: ['components/aurora/settings/settings-permissions-view.tsx'],
    mockUxAnchors: ['Privacy defaults, voice behavior, and assistant preferences.', 'Privacy defaults', 'Voice behavior', 'Native permission id'],
    componentFiles: ['settings-permissions-view.tsx'],
    stateCoverage: ['loading', 'empty', 'error', 'offline', 'permission', 'unsupported', 'admin-action', 'privacy', 'native-permission'],
    truthSources: [
      source('sdk-method', 'config and permission state', ['Config.Get', 'Auth.WhoAmI']),
      source('capability-graph', 'route privacy and selector requirements', ['Gateway.GetCapabilityCatalog']),
      source('admin-action', 'settings mutations', ['Config.Set', 'Gateway.AdminActionDraft', 'Gateway.AdminActionConfirm'])
    ],
    highestPrivacyClass: 'secret',
    mutatingMethodType: 'manage',
    adminActionRequired: true,
    fixturePolicy: 'test-only',
    degradedState: 'Settings toggles are disabled until backend capability and AdminAction state is available.',
    coverage: ['packages/aurora-ui/tests/shell.test.tsx']
  },
  {
    id: 'native-capabilities',
    label: 'Native capability surfaces',
    navItemIds: ['native'],
    routeOracles: [routeOracle('native', ['Native platform settings'], ['Native permissions and capabilities'])],
    mockReferenceFiles: ['components/aurora/settings/settings-permissions-view.tsx'],
    mockUxAnchors: ['Privacy defaults, voice behavior, and assistant preferences.', 'NativeIntegrationRow', 'Siri/Shortcuts/App Intents integration', 'nativePolicyNotes'],
    componentFiles: ['settings-permissions-view.tsx'],
    stateCoverage: ['loading', 'empty', 'error', 'offline', 'permission', 'unsupported', 'native-permission'],
    truthSources: [
      source('native-manifest', 'Tauri/mobile native capability manifest', ['Native.GetCapabilityManifest']),
      source('unsupported-degraded', 'platform-limited iOS and desktop/browser surfaces', [])
    ],
    highestPrivacyClass: 'credential',
    mutatingMethodType: 'none',
    adminActionRequired: false,
    fixturePolicy: 'test-only',
    degradedState: 'Not ready native capabilities render as platform limits, not as available backend state.',
    coverage: ['packages/aurora-ui/tests/shell.test.tsx', 'apps/aurora-tauri/src/secure-storage-policy.test.ts']
  },
  {
    id: 'onboarding-auth-pairing',
    label: 'Onboarding, auth, and pairing',
    navItemIds: ['onboarding', 'pairing'],
    routeOracles: [routeOracle('onboarding', ['Connect Aurora'], ['Validate endpoint'])],
    mockReferenceFiles: ['components/aurora/onboarding/onboarding-view.tsx', 'components/aurora/admin/devices-view.tsx'],
    mockUxAnchors: ['Welcome to Aurora', 'setup modes', 'Guided setup', 'Pairing queue'],
    componentFiles: ['onboarding-view.tsx', 'pairing-queue-view.tsx'],
    stateCoverage: ['loading', 'empty', 'error', 'offline', 'permission', 'unsupported', 'admin-action', 'native-permission'],
    truthSources: [
      source('sdk-method', 'session and pairing state', ['Auth.WhoAmI', 'Auth.PairingStart', 'Auth.PairingConnect', 'Auth.PairingExchange', 'Auth.ListPendingPairings']),
      source('admin-action', 'pairing approve and deny review', ['Auth.PairingApprove', 'Auth.PairingDeny', 'Gateway.AdminActionDraft', 'Gateway.AdminActionConfirm']),
      source('native-manifest', 'deployment-mode native state', ['Native.GetCapabilityManifest'])
    ],
    highestPrivacyClass: 'credential',
    mutatingMethodType: 'manage',
    adminActionRequired: true,
    fixturePolicy: 'test-only',
    degradedState: 'Mock transport is labeled as degraded development fallback; pairing success waits for Auth state.',
    coverage: ['packages/aurora-ui/tests/shell.test.tsx', 'apps/aurora-web/app/aurora-client.test.ts', 'apps/aurora-tauri/src/aurora-client.test.tsx']
  }
]


export interface ProductionRouteOracleBinding extends ProductionRouteOracle {
  surfaceId: ProductionSurfaceId
  surfaceLabel: string
}

export const productionRouteOracles: ProductionRouteOracleBinding[] = productionSurfaceContracts.flatMap((surface) =>
  (surface.routeOracles ?? []).map((oracle) => ({
    ...oracle,
    surfaceId: surface.id,
    surfaceLabel: surface.label
  }))
)

export const productionRouteOracleByNavItemId: ReadonlyMap<string, ProductionRouteOracleBinding> = new Map(
  productionRouteOracles.map((oracle) => [oracle.navItemId, oracle])
)

export function getProductionRouteOracle(navItemId: string): ProductionRouteOracleBinding | undefined {
  return productionRouteOracleByNavItemId.get(navItemId)
}

function routeOracle(
  navItemId: string,
  renderedLandmarks: string[],
  routeSpecificControls: string[]
): ProductionRouteOracle {
  return { navItemId, renderedLandmarks, routeSpecificControls }
}

function source(kind: ProductionTruthSourceKind, label: string, methods: string[]): ProductionTruthSource {
  return {
    kind,
    label,
    methods,
    evidence: methods.length > 0 ? methods.join(', ') : 'explicit unsupported/degraded state'
  }
}
