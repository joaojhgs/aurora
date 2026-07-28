import type { AuroraError, AvailabilityState, CapabilitySummary, MethodDescriptor } from '@aurora/client'
import type { RouteAvailability } from './shell-data'

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
  if (/(Auth|Gateway|Scheduler|Config|Tooling|Orchestrator|Backup)\.[A-Za-z0-9_.-]+/u.test(text)) return fallback
  if (/(AdminAction|SDK|backend|capability|catalog|contract|registry|route|transport|manifest|schema|provider)/iu.test(text)) return fallback
  return sanitizeAdminText(text)
}

export function adminActionLabel(input: string | Pick<MethodDescriptor, 'module' | 'name' | 'busTopic'>): string {
  if (typeof input === 'string') return humanizeAction(input)
  return `${adminModuleLabel(input.module)} ${humanizeAction(input.name || input.busTopic)}`
}

export function adminModuleLabel(module: string): string {
  if (/gateway/i.test(module)) return 'Connection'
  if (/auth/i.test(module)) return 'Access'
  if (/orchestrator/i.test(module)) return 'Assistant'
  if (/tooling/i.test(module)) return 'Tools'
  if (/config/i.test(module)) return 'Settings'
  if (/scheduler/i.test(module)) return 'Scheduler'
  if (/backup/i.test(module)) return 'Backups'
  return humanizeAction(module)
}

export function sanitizeAdminText(value: string): string {
  return value
    .replace(/(Auth|Gateway|Scheduler|Config|Tooling|Orchestrator|Backup)\.([A-Za-z0-9_.-]+)/gu, (_match, module, action) => `${adminModuleLabel(String(module))} ${humanizeAction(String(action))}`)
    .replace(/\bAdminAction\b/giu, 'admin approval')
    .replace(/\bSDK\b/gu, 'Aurora')
    .replace(/\bbackend\b/giu, 'Aurora')
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
