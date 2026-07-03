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
  Settings,
  ShieldCheck,
  Sparkles,
  Wrench,
  type LucideIcon
} from 'lucide-react'
import type { AvailabilityState, ContractMethodType, PrivacyClass } from '@aurora/client'

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
  adminGated?: boolean
  expectedTask: string
}

export type AuroraNavItemSnapshot = Omit<AuroraNavItem, 'icon'>

export interface AuroraNavSection {
  label: string
  items: AuroraNavItem[]
}

export const auroraNavSections: AuroraNavSection[] = [
  {
    label: 'Assistant',
    items: [
      item('assistant', 'Assistant', '/', Sparkles, 'Orchestrator', 'ExternalUserInput', 'use', 'personal', 'unsupported', 'service contract'),
      item('memory', 'Memory', '/memory', MessagesSquare, 'DB', 'RAGSearch', 'use', 'personal', 'stale', 'service contract'),
      item('tools', 'Tools', '/tools', Wrench, 'Tooling', 'GetToolCatalog', 'use', 'sensitive', 'unsupported', 'service contract'),
      item('mesh', 'Mesh', '/mesh', Network, 'Gateway', 'GetMeshStatus', 'use', 'personal', 'degraded', 'service contract')
    ]
  },
  {
    label: 'Operate',
    items: [
      item('admin', 'Admin Overview', '/admin', LayoutDashboard, 'Gateway', 'GetCapabilityCatalog', 'use', 'admin-critical', 'available-local', 'service contract', true),
      item('services', 'Services', '/admin/services', Boxes, 'Gateway', 'GetServices', 'use', 'admin-critical', 'available-local', 'service contract', true),
      item('access', 'Access', '/admin/access', ShieldCheck, 'Auth', 'ListPrincipals', 'use', 'admin-critical', 'degraded', 'service contract', true),
      item('tokens', 'Tokens', '/admin/tokens', KeyRound, 'Auth', 'ListTokens', 'use', 'credential', 'unsupported', 'service contract', true),
      item('devices', 'Devices', '/admin/devices', Laptop, 'Auth', 'ListDevices', 'use', 'credential', 'unsupported', 'service contract', true),
      item('config', 'Config', '/admin/config', Settings, 'Config', 'Get', 'use', 'secret', 'unsupported', 'service contract', true),
      item('contracts', 'Contracts', '/admin/contracts', ScrollText, 'Gateway', 'GetRegistry', 'use', 'public', 'available-local', 'service contract', true),
      item('plugins', 'Plugins', '/admin/plugins', Plug, 'Tooling', 'GetToolCatalog', 'use', 'admin-critical', 'unsupported', 'service contract', true),
      item('pairing', 'Pairing', '/admin/pairing', Network, 'Auth', 'ListPendingPairings', 'use', 'credential', 'unsupported', 'service contract', true),
      item('backups', 'Backups', '/admin/backups', DatabaseBackup, 'Backup', 'List', 'use', 'admin-critical', 'unsupported', 'service contract', true),
      item('scheduler', 'Scheduler', '/admin/scheduler', CalendarClock, 'Scheduler', 'ListJobs', 'use', 'admin-critical', 'unsupported', 'service contract', true),
      item('audit', 'Audit Log', '/admin/audit', Activity, 'Auth', 'AuditLog', 'use', 'sensitive', 'unsupported', 'service contract', true)
    ]
  },
  {
    label: 'Runtime',
    items: [
      item('models', 'Models', '/models', Cpu, 'Orchestrator', 'GetModelCatalog', 'use', 'personal', 'unsupported', 'service contract'),
      item('diagnostics', 'Diagnostics', '/diagnostics', Activity, 'Gateway', 'GetWebRTCDiagnostics', 'use', 'sensitive', 'available-local', 'service contract'),
      item('onboarding', 'Onboarding', '/onboarding', Compass, 'Auth', 'StartPairing', 'use', 'credential', 'unsupported', 'service contract'),
      item('settings', 'Settings', '/settings', Settings, 'Config', 'Get', 'use', 'secret', 'unsupported', 'service contract'),
      item('data', 'Data Policy', '/memory/policy', Database, 'DB', 'RAGSearch', 'use', 'sensitive', 'privacy-blocked', 'service contract'),
      item('native', 'Native', '/settings/native', MemoryStick, 'Native', 'GetCapabilityManifest', 'use', 'credential', 'unsupported', 'service contract')
    ]
  }
]

export const auroraMobileTabs = [
  auroraNavSections[0]!.items[0]!,
  auroraNavSections[0]!.items[3]!,
  auroraNavSections[1]!.items[0]!,
  auroraNavSections[2]!.items[1]!,
  auroraNavSections[2]!.items[3]!
]

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
  return undefined
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
    expectedTask
  }
}
