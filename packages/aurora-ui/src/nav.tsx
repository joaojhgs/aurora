import {
  Activity,
  Boxes,
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
      item('assistant', 'Assistant', '/', Sparkles, 'Orchestrator', 'ExternalUserInput', 'use', 'personal', 'unsupported', 'UIA-001'),
      item('memory', 'Memory', '/memory', MessagesSquare, 'DB', 'RAGSearch', 'use', 'personal', 'stale', 'UIA-006'),
      item('tools', 'Tools', '/tools', Wrench, 'Tooling', 'GetToolCatalog', 'use', 'sensitive', 'unsupported', 'UIA-003'),
      item('mesh', 'Mesh', '/mesh', Network, 'Gateway', 'GetMeshStatus', 'use', 'personal', 'degraded', 'MESH-001')
    ]
  },
  {
    label: 'Operate',
    items: [
      item('admin', 'Admin Overview', '/admin', LayoutDashboard, 'Gateway', 'GetCapabilityCatalog', 'use', 'admin-critical', 'available-local', 'ADM-001', true),
      item('services', 'Services', '/admin/services', Boxes, 'Gateway', 'GetServices', 'use', 'admin-critical', 'available-local', 'ADM-002', true),
      item('access', 'Access', '/admin/access', ShieldCheck, 'Auth', 'ListRoles', 'manage', 'admin-critical', 'unsupported', 'ADM-003', true),
      item('tokens', 'Tokens', '/admin/tokens', KeyRound, 'Auth', 'ListTokens', 'manage', 'credential', 'unsupported', 'ADM-004', true),
      item('devices', 'Devices', '/admin/devices', Laptop, 'Auth', 'ListDevices', 'manage', 'credential', 'unsupported', 'ADM-005', true),
      item('config', 'Config', '/admin/config', Settings, 'Config', 'Get', 'manage', 'secret', 'unsupported', 'ADM-006', true),
      item('contracts', 'Contracts', '/admin/contracts', ScrollText, 'Gateway', 'GetRegistry', 'use', 'public', 'available-local', 'ADM-002', true),
      item('plugins', 'Plugins', '/admin/plugins', Plug, 'Tooling', 'GetToolCatalog', 'manage', 'admin-critical', 'unsupported', 'ADM-007', true),
      item('pairing', 'Pairing', '/admin/pairing', Network, 'Auth', 'ListPendingPairings', 'manage', 'credential', 'unsupported', 'ADM-011', true),
      item('backups', 'Backups', '/admin/backups', DatabaseBackup, 'DB', 'Backup', 'manage', 'admin-critical', 'unsupported', 'ADM-010', true),
      item('audit', 'Audit Log', '/admin/audit', Activity, 'Auth', 'AuditLog', 'use', 'sensitive', 'unsupported', 'ADM-008', true)
    ]
  },
  {
    label: 'Runtime',
    items: [
      item('models', 'Models', '/models', Cpu, 'Orchestrator', 'GetModelCatalog', 'use', 'personal', 'unsupported', 'UIA-007'),
      item('diagnostics', 'Diagnostics', '/diagnostics', Activity, 'Gateway', 'GetCapabilityCatalog', 'use', 'sensitive', 'available-local', 'ADM-009'),
      item('onboarding', 'Onboarding', '/onboarding', Compass, 'Auth', 'StartPairing', 'use', 'credential', 'unsupported', 'UI-003'),
      item('settings', 'Settings', '/settings', Settings, 'Config', 'Get', 'manage', 'secret', 'unsupported', 'UI-004'),
      item('data', 'Data Policy', '/memory/policy', Database, 'DB', 'RAGSearch', 'use', 'sensitive', 'privacy-blocked', 'BE-017'),
      item('native', 'Native', '/settings/native', MemoryStick, 'Native', 'GetCapabilityManifest', 'use', 'credential', 'unsupported', 'TAURI-004')
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
  'UIA-002'
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
    'UIA-004'
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
    'UIA-004'
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
    'UIA-004'
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
    'UIA-004'
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
    'UIA-004'
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
