import {
  Sparkles,
  type LucideIcon
} from 'lucide-react'
import type { AvailabilityState, ContractMethodType, PrivacyClass } from '@aurora/client'
import {
  AURORA_FEATURE_SECTION_LABELS,
  OPERATE_FEATURE_SECTION_LABEL,
  auroraFeatureDefinitions,
  type AuroraFeatureDefinition,
  type AuroraFeatureId,
  type AuroraNavSectionId,
} from './feature-manifest'
import { shouldShowForSurface, type AuroraSurfaceProfile } from './platform-surface'

export {
  auroraFeatureDefinitionById,
  auroraFeatureDefinitions,
  auroraRoutedFeatureDefinitions,
  type AuroraFeatureComponentLoader,
  type AuroraFeatureDefinition,
  type AuroraFeatureId,
} from './feature-manifest'

export interface AuroraNavItem {
  id: string
  label: string
  href: string
  icon: LucideIcon
  capabilityFeatureId: string
  capabilityModule: string
  capabilityMethod?: string
  methodType: ContractMethodType
  privacyClass: PrivacyClass
  fallbackState: AvailabilityState
  mobileLabel?: string
  adminGated?: boolean
  expectedTask: string
}

export type AuroraNavItemSnapshot = Omit<AuroraNavItem, 'icon' | 'capabilityFeatureId'> & { capabilityFeatureId?: string }

export interface AuroraNavSection {
  label: string
  items: AuroraNavItem[]
}

export const OPERATE_NAV_SECTION_LABEL = OPERATE_FEATURE_SECTION_LABEL

const primaryNavSectionIds: readonly AuroraNavSectionId[] = ['assistant', 'operate', 'configure']

export interface AuroraNavProjection {
  navSections: AuroraNavSection[]
  embeddedNavItems: AuroraNavItem[]
  mobileTabs: AuroraNavItem[]
  routeNavItems: AuroraNavItem[]
  productCopyById: ReadonlyMap<string, AuroraFeatureDefinition['productCopy']>
  definitionById: ReadonlyMap<string, AuroraFeatureDefinition>
}

export function projectAuroraNavFromDefinitions(
  definitions: readonly AuroraFeatureDefinition[],
): AuroraNavProjection {
  const navSections = primaryNavSectionIds.map((sectionId) => ({
    label: AURORA_FEATURE_SECTION_LABELS[sectionId],
    items: definitions
      .filter((definition) => definition.nav.section === sectionId)
      .map(navItemFromFeatureDefinition),
  }))
  const embeddedNavItems = definitions
    .filter((definition) => definition.nav.section === 'embedded')
    .map(navItemFromFeatureDefinition)
  return {
    navSections,
    embeddedNavItems,
    mobileTabs: definitions.filter((definition) => definition.hostHints?.mobileTab === true).map(navItemFromFeatureDefinition),
    routeNavItems: definitions.map(navItemFromFeatureDefinition),
    productCopyById: new Map(definitions.map((definition) => [definition.id, definition.productCopy])),
    definitionById: new Map(definitions.map((definition) => [definition.id, definition])),
  }
}

const auroraNavProjection = projectAuroraNavFromDefinitions(auroraFeatureDefinitions)

export const auroraNavSections: AuroraNavSection[] = auroraNavProjection.navSections

export const auroraEmbeddedNavItems: AuroraNavItem[] = auroraNavProjection.embeddedNavItems

export const allAuroraRouteNavItems: AuroraNavItem[] = auroraNavProjection.routeNavItems

export const auroraFeatureProductCopyById: ReadonlyMap<AuroraFeatureId, AuroraFeatureDefinition['productCopy']> =
  auroraNavProjection.productCopyById as ReadonlyMap<AuroraFeatureId, AuroraFeatureDefinition['productCopy']>

export const auroraMobileTabs: AuroraNavItem[] = auroraNavProjection.mobileTabs

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
  ttsStream: item(
    'voice-tts-stream',
    'Spoken replies',
    '/',
    Sparkles,
    'TTS',
    'StreamStart',
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
  mobileTabs: readonly AuroraNavItem[] = auroraMobileTabs,
): AuroraNavItem[] {
  const showLocalSettings = shouldShowForSurface(profile, 'localSettings')
  return mobileTabs.filter((tab) => {
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
    capabilityFeatureId: `method:${capabilityModule}.${capabilityMethod}`,
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

function navItemFromFeatureDefinition(definition: AuroraFeatureDefinition): AuroraNavItem {
  return {
    id: definition.id,
    label: definition.nav.label,
    href: definition.nav.href,
    icon: definition.nav.icon,
    capabilityFeatureId: definition.capabilityFeatureId,
    capabilityModule: definition.routePolicy.capabilityModule,
    capabilityMethod: definition.routePolicy.capabilityMethod,
    methodType: definition.routePolicy.methodType,
    privacyClass: definition.routePolicy.privacyClass,
    fallbackState: definition.routePolicy.fallbackState,
    adminGated: definition.nav.adminGated ?? false,
    expectedTask: definition.routePolicy.expectedTask,
    mobileLabel: definition.nav.mobileLabel ?? definition.nav.label
  }
}

function mobileLabelForNavItem(id: string, label: string): string {
  return id === 'assistant' ? 'Assistant' : label
}
