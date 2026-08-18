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
  Wrench,
  type LucideIcon
} from 'lucide-react'
import type { AvailabilityState, ContractMethodType, PrivacyClass } from '@aurora/client'
import { shouldShowForSurface, type AuroraSurfaceProfile } from './platform-surface'

export interface AuroraNavItem {
  id: string
  label: string
  href: string
  icon: LucideIcon
  capabilityModule: string
  capabilityMethod?: string
  methodType: ContractMethodType
  privacyClass: PrivacyClass
  fallbackState: AvailabilityState
  mobileLabel?: string
  adminGated?: boolean
  expectedTask: string
}

export type AuroraNavItemSnapshot = Omit<AuroraNavItem, 'icon'>

export interface AuroraNavSection {
  label: string
  items: AuroraNavItem[]
}

export const OPERATE_NAV_SECTION_LABEL = 'Operate · admin only'

export const auroraNavSections: AuroraNavSection[] = [
  {
    label: 'Assistant',
    items: [
      item('assistant', 'Assistant', '/', Sparkles, 'Orchestrator', 'ExternalUserInput', 'use', 'personal', 'unsupported', 'service contract'),
      item('memory', 'Memory & Knowledge', '/memory', MessagesSquare, 'DB', 'RAGSearch', 'use', 'personal', 'stale', 'service contract'),
      item('tools', 'Tools & Plugins', '/tools', Wrench, 'Tooling', 'GetToolCatalog', 'use', 'sensitive', 'unsupported', 'service contract'),
      item('mesh', 'Mesh', '/mesh', Network, 'Gateway', 'GetMeshStatus', 'use', 'personal', 'degraded', 'service contract')
    ]
  },
  {
    label: OPERATE_NAV_SECTION_LABEL,
    items: [
      item('admin', 'Admin Overview', '/admin', LayoutDashboard, 'Gateway', 'GetCapabilityCatalog', 'use', 'admin-critical', 'available-local', 'service contract', true),
      item('services', 'Services', '/admin/services', Boxes, 'Gateway', 'GetServices', 'use', 'admin-critical', 'available-local', 'service contract', true),
      item('config', 'Server settings', '/admin/config', Server, 'Config', 'Get', 'use', 'secret', 'unsupported', 'service contract', true),
      item('access', 'Access & RBAC', '/admin/access', ShieldCheck, 'Auth', 'ListPrincipals', 'use', 'admin-critical', 'degraded', 'service contract', true),
      item('tokens', 'Tokens', '/admin/tokens', KeyRound, 'Auth', 'ListTokens', 'use', 'credential', 'unsupported', 'service contract', true),
      item('backups', 'Backups', '/admin/backups', DatabaseBackup, 'Backup', 'List', 'use', 'admin-critical', 'unsupported', 'service contract', true),
      item('scheduler', 'Scheduler', '/admin/scheduler', CalendarClock, 'Scheduler', 'ListJobs', 'use', 'admin-critical', 'unsupported', 'service contract', true),
      item('audit', 'Audit Log', '/admin/audit', Activity, 'Auth', 'AuditLog', 'use', 'sensitive', 'unsupported', 'service contract', true)
    ]
  },
  {
    label: 'Configure',
    items: [
      item('models', 'Models', '/models', Cpu, 'Orchestrator', 'GetModelCatalog', 'use', 'personal', 'unsupported', 'service contract'),
      item('settings', 'Settings', '/settings', Settings, 'Shell', 'Settings', 'use', 'personal', 'available-local', 'shell page')
    ]
  }
]

export const auroraEmbeddedNavItems: AuroraNavItem[] = [
  item('onboarding', 'Onboarding', '/onboarding', Compass, 'Auth', 'StartPairing', 'use', 'credential', 'unsupported', 'first-run gate'),
  item('devices', 'Devices', '/admin/devices', Laptop, 'Auth', 'ListDevices', 'use', 'credential', 'unsupported', 'service contract', true),
  item('contracts', 'Service Catalog', '/admin/contracts', ScrollText, 'Gateway', 'GetRegistry', 'use', 'public', 'available-local', 'service contract', true),
  item('plugins', 'Plugins', '/admin/plugins', Plug, 'Tooling', 'GetToolCatalog', 'use', 'admin-critical', 'unsupported', 'service contract', true),
  item('pairing', 'Pairing', '/admin/pairing', Network, 'Auth', 'ListPendingPairings', 'use', 'credential', 'unsupported', 'service contract', true),
  item('diagnostics', 'Diagnostics', '/diagnostics', Activity, 'Gateway', 'GetWebRTCDiagnostics', 'use', 'sensitive', 'unsupported', 'service contract', true),
  item('data', 'Data Policy', '/memory/policy', Database, 'DB', 'RAGSearch', 'use', 'sensitive', 'privacy-blocked', 'service contract', true),
  item('native', 'Device Features', '/settings/native', MemoryStick, 'Native', 'GetCapabilityManifest', 'use', 'credential', 'unsupported', 'service contract', true)
]


export const auroraMobileTabs = ['assistant', 'mesh', 'settings'].map((id) => {
  const match = getAuroraNavItem(id)
  if (!match) throw new Error(`Missing mobile nav item: ${id}`)
  return match
})

export const auroraAssistantCancellationItem = item(
  'assistant-cancel',
  'Assistant cancellation',
  '/',
  Sparkles,
  'Orchestrator',
  'Interrupt',
  'use',
  'personal',
  'unsupported',
  'service contract'
)

export const auroraAssistantVoiceItems = {
  transcription: item(
    'voice-transcription',
    'Remote transcription',
    '/',
    Sparkles,
    'Transcription',
    'Transcribe',
    'use',
    'raw-audio',
    'unsupported',
    'service contract'
  ),
  wakeProcess: item(
    'voice-wake-process',
    'Wake audio processing',
    '/',
    Sparkles,
    'WakeWord',
    'ProcessAudio',
    'use',
    'raw-audio',
    'unsupported',
    'service contract'
  ),
  wakeControl: item(
    'voice-wake-control',
    'Wake foreground control',
    '/',
    Sparkles,
    'WakeWord',
    'Control',
    'use',
    'raw-audio',
    'unsupported',
    'service contract'
  ),
  ttsSynthesize: item(
    'voice-tts-synthesize',
    'TTS synthesis',
    '/',
    Sparkles,
    'TTS',
    'Synthesize',
    'use',
    'personal',
    'unsupported',
    'service contract'
  ),
  ttsStop: item(
    'voice-tts-stop',
    'TTS playback stop',
    '/',
    Sparkles,
    'TTS',
    'Stop',
    'use',
    'personal',
    'unsupported',
    'service contract'
  )
} as const

export function getAuroraNavItem(id: string): AuroraNavItem | undefined {
  for (const section of auroraNavSections) {
    const match = section.items.find((item) => item.id === id)
    if (match) return match
  }
  return auroraEmbeddedNavItems.find((item) => item.id === id)
}

export function visibleAuroraNavSections(
  profile: AuroraSurfaceProfile,
  sessionIsAdmin: boolean,
): AuroraNavSection[] {
  const showLocalSettings = shouldShowForSurface(profile, 'localSettings')
  return auroraNavSections.flatMap((section) => {
    if (!sessionIsAdmin && section.label === OPERATE_NAV_SECTION_LABEL) return []
    const items = section.items.filter((candidate) => candidate.id !== 'settings' || showLocalSettings)
    if (items.length === 0) return []
    return [{ ...section, items }]
  })
}

export function visibleAuroraMobileTabs(
  profile: AuroraSurfaceProfile,
  sessionIsAdmin: boolean,
): AuroraNavItem[] {
  const showLocalSettings = shouldShowForSurface(profile, 'localSettings')
  return auroraMobileTabs.filter((tab) => {
    if (tab.adminGated && !sessionIsAdmin) return false
    if (tab.id === 'settings') return showLocalSettings
    return true
  })
}

export function navItemSnapshot(item: AuroraNavItem): AuroraNavItemSnapshot {
  const { icon: _icon, ...snapshot } = item
  return snapshot
}

function item(
  id: string,
  label: string,
  href: string,
  icon: LucideIcon,
  capabilityModule: string,
  capabilityMethod: string,
  methodType: ContractMethodType,
  privacyClass: PrivacyClass,
  fallbackState: AvailabilityState,
  expectedTask: string,
  adminGated = false
): AuroraNavItem {
  return {
    id,
    label,
    href,
    icon,
    capabilityModule,
    capabilityMethod,
    methodType,
    privacyClass,
    fallbackState,
    adminGated,
    expectedTask,
    mobileLabel: mobileLabelForNavItem(id, label)
  }
}

function mobileLabelForNavItem(id: string, label: string): string {
  switch (id) {
    case 'memory':
      return 'Memory'
    case 'tools':
      return 'Tools'
    case 'diagnostics':
      return 'Activity'
    case 'mesh':
      return 'Mesh'
    case 'admin':
      return 'Admin'
    case 'settings':
      return 'Settings'
    case 'config':
      return 'Server'
    case 'assistant':
      return 'Assistant'
    default:
      return label
  }
}
