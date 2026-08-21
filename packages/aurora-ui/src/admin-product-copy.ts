import type { AuroraError, AvailabilityState, CapabilitySummary, MethodDescriptor } from '@aurora/client'
import type { RouteAvailability } from './shell-data'
import { findForbiddenProductionCopyTerms } from './product-copy-forbidden-terms'

export interface AdminProductCopy {
  title: string
  detail?: string
  remedy?: string
  ref?: string
}

export function adminErrorCopy(error: unknown, fallback = 'Aurora could not read this item'): AdminProductCopy {
  const code = errorCode(error)
  const ref = safeReference(error)
  if (code === 'auth' || code === 'permission' || code === 'permission_denied') {
    return withRef({ title: 'Permission is needed to use this feature', remedy: 'Review access and try again.' }, ref)
  }
  if (code === 'privacy_blocked') {
    return withRef({ title: 'Permission is needed to use this feature', remedy: 'Approve access before continuing.' }, ref)
  }
  if (code === 'unsupported_feature' || code === 'unavailable_service' || code === 'unsupported') {
    return withRef({ title: 'This Aurora version cannot use that feature yet' }, ref)
  }
  if (code === 'timeout' || code === 'transport_loss' || code === 'connection_lost') {
    return withRef({ title: 'Connection lost. Reconnecting...', remedy: 'Try again after Aurora reconnects.' }, ref)
  }
  return withRef({ title: fallback }, ref)
}

export function adminErrorTitle(error: unknown, fallback?: string): string {
  const copy = adminErrorCopy(error, fallback)
  return copy.ref ? `${copy.title} Ref ${copy.ref}.` : copy.title
}

export function productAdminErrorCopy(error: unknown, fallback?: string): string {
  return adminErrorTitle(error, fallback)
}

export function productAdminReasonCopy(value: string | null | undefined, fallback?: string): string {
  return adminReasonText(value, fallback)
}

export function productAdminCountCopy(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? singular : plural}`
}

export function productAdminPairCountCopy(
  firstCount: number,
  firstSingular: string,
  secondCount: number,
  secondSingular: string
): string {
  return `${productAdminCountCopy(firstCount, firstSingular)} across ${productAdminCountCopy(secondCount, secondSingular)}`
}

export function productAdminDeviceFeatureCopy(platform: string, featureCount: number): string {
  return `${sanitizeAdminText(platform)}; ${productAdminCountCopy(featureCount, 'feature')}`
}

export function adminAvailabilityReason(state: AvailabilityState, input: { approvalRequired?: boolean; blockers?: readonly string[] } = {}): string {
  if (state === 'available-local' || state === 'available-remote') {
    return input.approvalRequired ? 'Admin approval is required before this action can run.' : 'Ready'
  }
  if (state === 'offline' || state === 'stale') return 'This device is offline'
  if (state === 'denied' || state === 'privacy-blocked') return 'Permission is needed to use this feature'
  if (state === 'unsupported') return 'This Aurora version cannot use that feature yet'
  if (input.blockers?.length) return 'This action needs attention before it can run.'
  return 'Checking Aurora'
}

export function adminCapabilityReason(capability: CapabilitySummary): string {
  return adminAvailabilityReason(capability.availability, {
    approvalRequired: capability.raw.policy.approval_required,
    blockers: capability.routeBlockers,
  })
}

export function adminRouteCopy(route: Pick<RouteAvailability, 'state' | 'disabled' | 'routeable' | 'requiresAdminAction' | 'blockers' | 'explanation'>): string {
  if (route.disabled) return adminAvailabilityReason(route.state, { approvalRequired: route.requiresAdminAction, blockers: route.blockers })
  if (!route.routeable) return 'This action is not ready from the current connection.'
  if (route.requiresAdminAction) return 'Admin approval is required before this action can run.'
  if (route.blockers.length > 0) return 'This action needs attention before it can run.'
  return sanitizeAdminText(route.explanation || 'Ready')
}

export function adminReasonText(value: string | null | undefined, fallback = 'This action needs attention before it can run.'): string {
  const text = value?.trim()
  if (!text) return fallback
  if (hasUnsafeAdminCopy(text)) return fallback
  const softened = sanitizeAdminText(text, fallback)
  return isAllowedAdminReasonCopy(softened) ? softened : fallback
}

export function adminActionLabel(input: string | Pick<MethodDescriptor, 'module' | 'name' | 'busTopic'>): string {
  if (typeof input === 'string') return humanizeAction(input)
  const action = input.name || input.busTopic.split('.').at(-1) || input.busTopic
  const knownLabel = PRODUCT_ACTION_LABELS[`${input.module}.${action}`.toLowerCase()]
  return knownLabel ?? `${adminModuleLabel(input.module)} ${humanizeAction(action)}`
}

export function adminModuleLabel(module: string): string {
  if (/gateway/i.test(module)) return 'Connection'
  if (/auth/i.test(module)) return 'Access'
  if (/orchestrator/i.test(module)) return 'Assistant'
  if (/tooling/i.test(module)) return 'Tools'
  if (/^tts$/i.test(module)) return 'Spoken replies'
  if (/^(?:stt|sttcoordinator|stttranscription)$/i.test(module)) return 'Voice input'
  if (/wakeword/i.test(module)) return 'Hands-free listening'
  if (/^db$/i.test(module)) return 'Local data'
  if (/config/i.test(module)) return 'Settings'
  if (/scheduler/i.test(module)) return 'Scheduler'
  if (/backup/i.test(module)) return 'Backups'
  return humanizeAction(module)
}

const PRODUCT_ACTION_LABELS: Record<string, string> = {
  'tts.synthesize': 'Speak a reply',
  'tts.stop': 'Stop speaking',
  'tts.listvoices': 'Available voices',
  'tts.listvoiceprofiles': 'Voice profiles',
  'tts.getcapabilities': 'Spoken reply availability',
  'wakeword.processaudio': 'Listen for the wake phrase',
  'wakeword.control': 'Hands-free listening controls',
}

export function sanitizeAdminText(value: string, fallback = 'This item needs attention.'): string {
  if (hasUnsafeAdminCopy(value)) return fallback
  const softened = value
    .replace(/(Auth|Gateway|Scheduler|Config|Tooling|Orchestrator|Backup)\.([A-Za-z0-9_.-]+)/gu, (_match, module, action) => `${adminModuleLabel(String(module))} ${humanizeAction(String(action))}`)
    .replace(/\bAdminAction\b/giu, 'admin approval')
    .replace(/\bSDK\b/gu, 'Aurora')
    .replace(/\bbackend\b/giu, 'Aurora')
    .replace(/\bproof\b/giu, 'status')
    .replace(/\bevidence\b/giu, 'status')
    .replace(/\bfixtures?\b/giu, 'sample')
    .replace(/\bassertions?\b/giu, 'checks')
    .replace(/\bimplement(?:ation|ed|ing)?\b/giu, 'setup')
    .replace(/\btested\b/giu, 'checked')
    .replace(/\bdebug(?:ging)?\b/giu, 'support')
    .replace(/\bfallback\b/giu, 'backup option')
    .replace(/\bprotocol\b/giu, 'connection method')
    .replace(/\bmigrations?\b/giu, 'updates')
    .replace(/\bsqlite\b/giu, 'local storage')
    .replace(/\bindexeddb\b/giu, 'browser storage')
    .replace(/\bopfs\b/giu, 'private browser storage')
    .replace(/\bsidecar\b/giu, 'desktop helper')
    .replace(/\bthin\b/giu, 'connected')
    .replace(/\bsignaling\b/giu, 'connection setup')
    .replace(/\bdatachannel\b/giu, 'secure session')
    .replace(/\broom[_ -]?password\b/giu, 'protected room setting')
    .replace(/\bGateway\b/gu, 'Connection')
    .replace(/\bAuth\b/gu, 'Access')
    .replace(/\bConfig\b/gu, 'Settings')
    .replace(/\bTooling\b/gu, 'Tools')
    .replace(/\bOrchestrator\b/gu, 'Assistant')
    .replace(/\bScheduler\b/gu, 'Schedules')
    .replace(/\bBackup\b/gu, 'Backups')
    .replace(/\bregistry\b/giu, 'service list')
    .replace(/\bcontracts?\b/giu, 'actions')
    .replace(/\bcapability(?:ies)?\b/giu, 'feature')
    .replace(/\bmanifest\b/giu, 'feature list')
    .replace(/\bschemas?\b/giu, 'details')
    .replace(/\btransport\b/giu, 'connection')
    .replace(/\bprovider\b/giu, 'source')
    .replace(/\broute(?:able|s|d)?\b/giu, 'path')
  return hasUnsafeAdminCopy(softened) ? fallback : softened
}

const ADMIN_METHOD_PATTERN = /\b(?:Auth|Gateway|Scheduler|Config|Tooling|Orchestrator|Backup)\.[A-Za-z0-9_.-]+\b/u
const ADMIN_KEY_PATH_PATTERN = /\b(?:services|gateway|auth|config|orchestrator|tts|stt|db|tooling|scheduler)\.[a-z0-9_.]+\b/iu
const ADMIN_SLASH_PATH_PATTERN = /(?:^|\s)\/(?:api|admin|services|gateway|auth|config|orchestrator|tooling|scheduler)\b/iu
const ADMIN_SECRET_LIKE_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{6,}|(?:api[_ -]?key|token|secret|credential|password|room[_ -]?password)\b\s*[:=]\s*\S+|(?:AKIA|ghp_|xox[baprs]-|eyJ)[A-Za-z0-9._-]{8,})/iu
const ADMIN_NORMALIZED_INTERNAL_TERMS = [
  'adminaction',
  'backend',
  'capability',
  'catalog',
  'contract',
  'datachannel',
  'debug',
  'fallback',
  'fixture',
  'implementation',
  'indexeddb',
  'manifest',
  'migration',
  'opfs',
  'protocol',
  'provider',
  'roompassword',
  'runtime',
  'schema',
  'sidecar',
  'signaling',
  'sqlite',
  'tested',
  'transport',
] as const
const ADMIN_NORMALIZED_INTERNAL_PREFIXES = [
  'services',
  'gateway',
  'auth',
  'config',
  'orchestrator',
  'tooling',
  'scheduler',
] as const

function hasUnsafeAdminCopy(value: string): boolean {
  return findForbiddenProductionCopyTerms(value).length > 0 ||
    ADMIN_METHOD_PATTERN.test(value) ||
    ADMIN_KEY_PATH_PATTERN.test(value) ||
    ADMIN_SLASH_PATH_PATTERN.test(value) ||
    ADMIN_SECRET_LIKE_PATTERN.test(value) ||
    hasNormalizedInternalAdminCopy(value)
}

function isAllowedAdminReasonCopy(value: string): boolean {
  if (hasUnsafeAdminCopy(value)) return false
  if (
    /^(?:devices|tokens|pending pairings|mesh peers|capability catalog|platform features): (?:Connection lost\. Reconnecting\.\.\.|This Aurora version cannot use that feature yet|Permission is needed to use this feature)$/iu.test(
      value
    )
  ) {
    return true
  }
  return /^(?:Ready|none)$/iu.test(value) ||
    /^(?:This action|This device|This Aurora version|Permission is needed|Admin approval is required|Connection lost|Checking Aurora|Status needs attention|Available after admin confirmation)\b[\w\s.,'/-]*$/iu.test(value) ||
    /^(?:Source|Tool source|Backup list|Backup action|Device update|Settings update|Review|Rollback|Audit status|Device\/session status|RBAC status|Configuration editor)\b[\w\s.,'/-]*$/iu.test(value)
}

function hasNormalizedInternalAdminCopy(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/gu, '')
  if (ADMIN_NORMALIZED_INTERNAL_TERMS.some((term) => normalized.includes(term))) return true
  return ADMIN_NORMALIZED_INTERNAL_PREFIXES.some((prefix) =>
    ADMIN_NORMALIZED_INTERNAL_TERMS.some((term) => normalized.includes(`${prefix}${term}`))
  )
}

function humanizeAction(value: string): string {
  const cleaned = value.includes('.') ? value.split('.').at(-1) ?? value : value
  return cleaned
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/[._:-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const code = 'code' in error ? (error as Partial<AuroraError>).code : null
  return typeof code === 'string' ? code : null
}

function safeReference(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const raw = 'correlationId' in error ? (error as { correlationId?: unknown }).correlationId : undefined
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return /^[A-Z0-9][A-Z0-9._-]{2,31}$/iu.test(trimmed) ? trimmed : undefined
}

function withRef(copy: AdminProductCopy, ref: string | undefined): AdminProductCopy {
  return ref ? { ...copy, ref } : copy
}
