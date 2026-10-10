import {
  Activity,
  Boxes,
  CalendarClock,
  Compass,
  Cpu,
  Database,
  DatabaseBackup,
  KeyRound,
  Laptop,
  LayoutDashboard,
  MemoryStick,
  MessagesSquare,
  Network,
  Plug,
  ScrollText,
  Server,
  Settings,
  ShieldCheck,
  Sparkles,
  Volume2,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import type { AvailabilityState, ContractMethodType, PrivacyClass } from '@aurora/client'

export type AuroraNavSectionId = 'assistant' | 'operate' | 'configure' | 'embedded'

export interface AuroraFeatureNavDefinition {
  section: AuroraNavSectionId
  label: string
  href: string
  icon: LucideIcon
  mobileLabel?: string
  adminGated?: boolean
}

export interface AuroraFeatureRoutePolicy {
  capabilityModule: string
  capabilityMethod: string
  methodType: ContractMethodType
  privacyClass: PrivacyClass
  fallbackState: AvailabilityState
  expectedTask: string
}

export interface AuroraFeatureProductCopy {
  title: string
  description: string
}

export interface AuroraFeatureComponentLoader {
  exportName: string
  load: () => Promise<unknown>
}

export interface AuroraFeatureHostHints {
  mobileTab?: boolean
  webHidden?: boolean
  tauriEmbedded?: boolean
}

export interface AuroraFeatureDefinition<TId extends string = string> {
  id: TId
  nav: AuroraFeatureNavDefinition
  capabilityFeatureId: string
  routePolicy: AuroraFeatureRoutePolicy
  productCopy: AuroraFeatureProductCopy
  component: AuroraFeatureComponentLoader
  hostHints?: AuroraFeatureHostHints
}

export const OPERATE_FEATURE_SECTION_LABEL = 'Operate · admin only'

export const AURORA_FEATURE_SECTION_LABELS: Record<AuroraNavSectionId, string> = {
  assistant: 'Assistant',
  operate: OPERATE_FEATURE_SECTION_LABEL,
  configure: 'Configure',
  embedded: 'Embedded',
}

const auroraFeatureDefinitionEntries = [
  feature('assistant', 'Assistant', '/', Sparkles, 'Orchestrator', 'ExternalUserInput', 'use', 'personal', 'unsupported', 'service contract', 'assistant', 'AssistantView', () => import('./assistant-view'), { mobileTab: true }),
  feature('memory', 'Memory & Knowledge', '/memory', MessagesSquare, 'DB', 'RAGSearch', 'use', 'personal', 'stale', 'service contract', 'assistant', 'MemoryView', () => import('./memory-view'), { mobileLabel: 'Memory' }),
  feature('tools', 'Tools & Plugins', '/tools', Wrench, 'Tooling', 'GetToolCatalog', 'use', 'sensitive', 'unsupported', 'service contract', 'assistant', 'ToolApprovalPanel', () => import('./tool-approval-panel'), { mobileLabel: 'Tools' }),
  feature('mesh', 'Mesh', '/mesh', Network, 'Gateway', 'GetMeshStatus', 'use', 'personal', 'degraded', 'service contract', 'assistant', 'MeshPeersView', () => import('./mesh-peers-view'), { mobileTab: true }),
  feature('admin', 'Admin Overview', '/admin', LayoutDashboard, 'Gateway', 'GetCapabilityCatalog', 'use', 'admin-critical', 'available-local', 'service contract', 'operate', 'AdminOverviewView', () => import('./admin-overview-view'), { adminGated: true, mobileLabel: 'Admin' }),
  feature('services', 'Services', '/admin/services', Boxes, 'Gateway', 'GetServices', 'use', 'admin-critical', 'available-local', 'service contract', 'operate', 'AdminServicesView', () => import('./admin-services-view'), { adminGated: true }),
  feature('config', 'Server settings', '/admin/config', Server, 'Config', 'Get', 'use', 'secret', 'unsupported', 'service contract', 'operate', 'ConfigEditorView', () => import('./config-editor-view'), { adminGated: true, mobileLabel: 'Server' }),
  feature('spoken-replies', 'Spoken replies', '/admin/voice', Volume2, 'TTS', 'ListVoices', 'use', 'personal', 'unsupported', 'service contract', 'operate', 'VoiceSettingsView', () => import('./voice-settings-view'), { adminGated: true, mobileLabel: 'Speech' }),
  feature('access', 'Access & RBAC', '/admin/access', ShieldCheck, 'Auth', 'ListPrincipals', 'use', 'admin-critical', 'degraded', 'service contract', 'operate', 'AdminRbacView', () => import('./admin-rbac-view'), { adminGated: true }),
  feature('tokens', 'Tokens', '/admin/tokens', KeyRound, 'Auth', 'ListTokens', 'use', 'credential', 'unsupported', 'service contract', 'operate', 'AdminTokensView', () => import('./admin-tokens-view'), { adminGated: true }),
  feature('backups', 'Backups', '/admin/backups', DatabaseBackup, 'Backup', 'List', 'use', 'admin-critical', 'unsupported', 'service contract', 'operate', 'BackupRestoreView', () => import('./backup-restore-view'), { adminGated: true }),
  feature('scheduler', 'Scheduler', '/admin/scheduler', CalendarClock, 'Scheduler', 'ListJobs', 'use', 'admin-critical', 'unsupported', 'service contract', 'operate', 'AdminSchedulerView', () => import('./admin-scheduler-view'), { adminGated: true }),
  feature('audit', 'Audit Log', '/admin/audit', Activity, 'Auth', 'AuditLog', 'use', 'sensitive', 'unsupported', 'service contract', 'operate', 'AdminAuditView', () => import('./admin-audit-view'), { adminGated: true }),
  feature('models', 'Models', '/models', Cpu, 'Orchestrator', 'GetModelCatalog', 'use', 'personal', 'unsupported', 'service contract', 'configure', 'ModelsView', () => import('./models-view')),
  feature('settings', 'Settings', '/settings', Settings, 'Shell', 'Settings', 'use', 'personal', 'available-local', 'shell page', 'configure', 'SettingsView', () => import('./settings-view'), { mobileTab: true }),
  feature('onboarding', 'Onboarding', '/onboarding', Compass, 'Auth', 'StartPairing', 'use', 'credential', 'unsupported', 'first-run gate', 'embedded', 'OnboardingView', () => import('./onboarding-view'), { tauriEmbedded: true }),
  feature('devices', 'Devices', '/admin/devices', Laptop, 'Auth', 'ListDevices', 'use', 'credential', 'unsupported', 'service contract', 'embedded', 'AdminDevicesView', () => import('./admin-devices-view'), { adminGated: true, tauriEmbedded: true }),
  feature('contracts', 'Service actions', '/admin/contracts', ScrollText, 'Gateway', 'GetRegistry', 'use', 'public', 'available-local', 'service contract', 'embedded', 'ServiceRoutingView', () => import('./service-routing-view'), { adminGated: true, tauriEmbedded: true }),
  feature('plugins', 'Plugins', '/admin/plugins', Plug, 'Tooling', 'GetToolCatalog', 'use', 'admin-critical', 'unsupported', 'service contract', 'embedded', 'AdminPluginsView', () => import('./admin-plugins-view'), { adminGated: true, tauriEmbedded: true }),
  feature('pairing', 'Pairing', '/admin/pairing', Network, 'Auth', 'ListPendingPairings', 'use', 'credential', 'unsupported', 'service contract', 'embedded', 'PairingQueueView', () => import('./pairing-queue-view'), { adminGated: true, tauriEmbedded: true }),
  feature('diagnostics', 'Diagnostics', '/diagnostics', Activity, 'Gateway', 'GetWebRTCDiagnostics', 'use', 'sensitive', 'unsupported', 'service contract', 'embedded', 'MeshDiagnosticsResource', () => import('./mesh-diagnostics-resource'), { adminGated: true, mobileLabel: 'Activity', tauriEmbedded: true }),
  feature('data', 'Data Policy', '/memory/policy', Database, 'DB', 'RAGSearch', 'use', 'sensitive', 'privacy-blocked', 'service contract', 'embedded', 'DataPolicyView', () => import('./data-policy-view'), { adminGated: true, tauriEmbedded: true }),
  feature('native', 'Device Features', '/settings/native', MemoryStick, 'Native', 'GetCapabilityManifest', 'use', 'credential', 'unsupported', 'service contract', 'embedded', 'SettingsNativeView', () => import('./settings-native-view'), { adminGated: true, tauriEmbedded: true }),
] as const satisfies readonly AuroraFeatureDefinition[]

export const auroraFeatureDefinitions = Object.freeze(auroraFeatureDefinitionEntries)

export type AuroraFeatureId = (typeof auroraFeatureDefinitions)[number]['id']

export const auroraFeatureDefinitionById: ReadonlyMap<AuroraFeatureId, AuroraFeatureDefinition<AuroraFeatureId>> = new Map(
  auroraFeatureDefinitions.map((definition) => [definition.id, definition]),
)

export const auroraRoutedFeatureDefinitions = auroraFeatureDefinitions

function feature<const TId extends string>(
  id: TId,
  label: string,
  href: string,
  icon: LucideIcon,
  capabilityModule: string,
  capabilityMethod: string,
  methodType: ContractMethodType,
  privacyClass: PrivacyClass,
  fallbackState: AvailabilityState,
  expectedTask: string,
  section: AuroraNavSectionId,
  exportName: string,
  load: () => Promise<unknown>,
  options: {
    adminGated?: boolean
    mobileLabel?: string
    mobileTab?: boolean
    tauriEmbedded?: boolean
    webHidden?: boolean
  } = {},
): AuroraFeatureDefinition<TId> {
  return {
    id,
    nav: {
      section,
      label,
      href,
      icon,
      adminGated: options.adminGated ?? false,
      mobileLabel: options.mobileLabel ?? label,
    },
    capabilityFeatureId: `method:${capabilityModule}.${capabilityMethod}`,
    routePolicy: {
      capabilityModule,
      capabilityMethod,
      methodType,
      privacyClass,
      fallbackState,
      expectedTask,
    },
    productCopy: {
      title: label,
      description: productDescription(label, expectedTask),
    },
    component: {
      exportName,
      load,
    },
    hostHints: {
      ...(options.mobileTab !== undefined ? { mobileTab: options.mobileTab } : {}),
      ...(options.webHidden !== undefined ? { webHidden: options.webHidden } : {}),
      ...(options.tauriEmbedded !== undefined ? { tauriEmbedded: options.tauriEmbedded } : {}),
    },
  }
}

function productDescription(label: string, expectedTask: string): string {
  if (expectedTask === 'first-run gate') return `${label} helps set up this device.`
  if (expectedTask === 'shell page') return `${label} is provided by this app.`
  return 'This feature is available through Aurora.'
}
