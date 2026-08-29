import type { AuroraError, AuroraErrorCode, AvailabilityState } from '@aurora/client'
import { backupErrorMessage } from '@aurora/ui'

const GENERIC_READ_ERROR = 'Aurora could not read this information. Try again.'
const GENERIC_ACTION_ERROR = 'Aurora could not complete that action. Try again.'
type QueueHealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unavailable' | 'unknown'
type BundleItemStatus = 'available' | 'healthy' | 'ok' | 'unavailable' | 'metadata_only' | 'unknown'

const KNOWN_ERROR_CODES = new Set<AuroraErrorCode>([
  'auth',
  'permission',
  'validation',
  'timeout',
  'unavailable_service',
  'unsupported_feature',
  'privacy_blocked',
  'native_permission_missing',
  'transport_loss',
  'unknown'
])

const READ_ERROR_COPY: Record<AuroraErrorCode, string> = {
  auth: 'Permission is needed to view this information.',
  permission: 'Permission is needed to view this information.',
  validation: GENERIC_READ_ERROR,
  timeout: 'Aurora took too long to respond. Try again.',
  unavailable_service: 'This information is unavailable right now. Check the affected device, then try again.',
  unsupported_feature: 'This information is unavailable right now. Check the affected device, then try again.',
  privacy_blocked: 'Permission is needed to view this information.',
  native_permission_missing: 'Permission is needed to view this information.',
  transport_loss: 'This information is unavailable right now. Check the affected device, then try again.',
  unknown: GENERIC_READ_ERROR
}

const ACTION_ERROR_COPY: Record<AuroraErrorCode, string> = {
  auth: 'Permission is needed to complete this action.',
  permission: 'Permission is needed to complete this action.',
  validation: GENERIC_ACTION_ERROR,
  timeout: 'Aurora took too long to complete this action. Try again.',
  unavailable_service: 'This action is unavailable right now. Check the affected device, then try again.',
  unsupported_feature: 'This action is unavailable right now. Check the affected device, then try again.',
  privacy_blocked: 'Permission is needed to complete this action.',
  native_permission_missing: 'Permission is needed to complete this action.',
  transport_loss: 'This action is unavailable right now. Check the affected device, then try again.',
  unknown: GENERIC_ACTION_ERROR
}

const ERROR_STATE: Record<AuroraErrorCode, AvailabilityState> = {
  auth: 'denied',
  permission: 'denied',
  validation: 'degraded',
  timeout: 'degraded',
  unavailable_service: 'unsupported',
  unsupported_feature: 'unsupported',
  privacy_blocked: 'privacy-blocked',
  native_permission_missing: 'denied',
  transport_loss: 'offline',
  unknown: 'degraded'
}

const AVAILABILITY_COPY: Record<AvailabilityState, string> = {
  'available-local': 'Available',
  'available-remote': 'Available',
  pending: 'Checking',
  offline: 'Needs attention',
  denied: 'Permission needed',
  degraded: 'Needs attention',
  stale: 'Needs attention',
  'privacy-blocked': 'Permission needed',
  unsupported: 'Unavailable'
}

const QUEUE_STATUS_COPY: Record<QueueHealthStatus, string> = {
  healthy: 'Available',
  degraded: 'Needs attention',
  unhealthy: 'Needs attention',
  unavailable: 'Unavailable',
  unknown: 'Unavailable'
}

const QUEUE_STATUS_STATE: Record<QueueHealthStatus, AvailabilityState> = {
  healthy: 'available-local',
  degraded: 'degraded',
  unhealthy: 'degraded',
  unavailable: 'unsupported',
  unknown: 'unsupported'
}

const BUNDLE_ITEM_AVAILABLE: Record<BundleItemStatus, boolean> = {
  available: true,
  healthy: true,
  ok: true,
  unavailable: false,
  metadata_only: false,
  unknown: false
}

export function productErrorText(error: unknown, fallback = GENERIC_READ_ERROR): string {
  const code = errorCode(error)
  return withSafeReference(code ? READ_ERROR_COPY[code] : fallback, error)
}

export function productActionErrorText(error: unknown): string {
  const code = errorCode(error)
  return withSafeReference(code ? ACTION_ERROR_COPY[code] : GENERIC_ACTION_ERROR, error)
}

export function productBackupErrorText(error: AuroraError): string {
  return backupErrorMessage(error)
}

export function productErrorState(error: unknown): AvailabilityState {
  const code = errorCode(error)
  return code ? ERROR_STATE[code] : 'degraded'
}

export function productAvailabilityText(state: AvailabilityState): string {
  return AVAILABILITY_COPY[state]
}

export function productQueueStatusText(status: string | null | undefined): string {
  return QUEUE_STATUS_COPY[queueHealthStatus(status)]
}

export function productQueueStatusState(status: string | null | undefined): AvailabilityState {
  return QUEUE_STATUS_STATE[queueHealthStatus(status)]
}

export function productBundleItemAvailable(status: string | null | undefined): boolean {
  return BUNDLE_ITEM_AVAILABLE[bundleItemStatus(status)]
}

export function yesNo(value: unknown): string {
  if (value === true) return 'Yes'
  if (value === false) return 'No'
  return 'Unknown'
}

export function countText(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

function errorCode(error: unknown): AuroraErrorCode | null {
  if (typeof error !== 'object' || error === null) return null
  const code = 'code' in error ? (error as { code?: unknown }).code : null
  return typeof code === 'string' && KNOWN_ERROR_CODES.has(code as AuroraErrorCode) ? code as AuroraErrorCode : null
}

function queueHealthStatus(status: string | null | undefined): QueueHealthStatus {
  const code = normalizedCode(status)
  if (code === 'healthy') return 'healthy'
  if (code === 'degraded') return 'degraded'
  if (code === 'unhealthy') return 'unhealthy'
  if (code === 'unavailable') return 'unavailable'
  return 'unknown'
}

function bundleItemStatus(status: string | null | undefined): BundleItemStatus {
  const code = normalizedCode(status)
  if (code === 'available') return 'available'
  if (code === 'healthy') return 'healthy'
  if (code === 'ok') return 'ok'
  if (code === 'unavailable') return 'unavailable'
  if (code === 'metadataonly') return 'metadata_only'
  return 'unknown'
}

function normalizedCode(value: string | null | undefined): string {
  return value?.trim().toLowerCase().replace(/[^a-z0-9]+/gu, '') ?? ''
}

function withSafeReference(message: string, source: unknown): string {
  const reference = safeReference(source)
  return reference ? `${message} Reference ${reference}.` : message
}

function safeReference(source: unknown): string | null {
  if (typeof source !== 'object' || source === null) return null
  for (const key of ['correlationId', 'requestId', 'request_id', 'referenceId']) {
    const raw = key in source ? (source as Record<string, unknown>)[key] : null
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim()
    if (/^[A-Z0-9][A-Z0-9._-]{2,31}$/iu.test(trimmed)) return trimmed
  }
  return null
}
