import { eventFromUnknown, normalizeEventSubjects, type AuroraStreamRequest, type NativeEventSubjectFilter } from './events.js'
import type { AuditReceipt, AuroraEvent, JsonObject } from './types.js'

export const NATIVE_EVENT_SOURCE = 'native'
const NATIVE_EVENT_ID_PREFIX = 'native:'
const NATIVE_EVENT_GAP_ID_PREFIX = 'native:gap:'

export interface NativeEventSubscribeRequest<TPayload = unknown> extends AuroraStreamRequest<TPayload> {
  source: typeof NATIVE_EVENT_SOURCE
  subjects: string[]
  lastSequenceId?: number | string | null | undefined
}

export function isNativeEventSubscribeRequest<TPayload>(
  request: AuroraStreamRequest<TPayload>
): request is NativeEventSubscribeRequest<TPayload> {
  return request.source === NATIVE_EVENT_SOURCE
}

export function prepareNativeEventSubscribeRequest<TPayload>(
  request: AuroraStreamRequest<TPayload>
): NativeEventSubscribeRequest<TPayload> {
  return {
    ...request,
    source: NATIVE_EVENT_SOURCE,
    subjects: normalizeEventSubjects(request.subject, request.subjects ?? []),
    lastSequenceId: request.lastSequenceId ?? nativeSequenceFromEventId(request.lastEventId ?? request.replayFrom)
  }
}

export function normalizeNativeAuroraEvent<TPayload = unknown>(raw: unknown): AuroraEvent<TPayload> {
  const event = eventFromUnknown<TPayload>(withNativeEventId(raw), {
    kind: 'native.event',
    transport: NATIVE_EVENT_SOURCE,
    audit: { transport: NATIVE_EVENT_SOURCE }
  })
  const audit: AuditReceipt = {
    ...event.audit,
    transport: NATIVE_EVENT_SOURCE
  }
  return {
    ...event,
    id: event.id ?? nativeSequenceId(raw),
    audit,
    redaction: audit.redaction
  }
}

export function createNativeEventGap(
  firstMissingSequence: number,
  previousEventId: string | null,
  reason = 'client_queue_overflow'
): AuroraEvent<{
  source: typeof NATIVE_EVENT_SOURCE
  firstMissingSequence: number
  previousEventId: string | null
  recovery: 'resubscribe'
  reason: string
}> {
  return normalizeNativeAuroraEvent({
    id: `${NATIVE_EVENT_GAP_ID_PREFIX}${firstMissingSequence}`,
    kind: 'native.events.gap',
    payload: {
      source: NATIVE_EVENT_SOURCE,
      firstMissingSequence,
      previousEventId,
      recovery: 'resubscribe',
      reason
    },
    status: reason,
    secrets_redacted: true
  })
}

export function nativeEventSequenceNumber(eventId: string | null | undefined): number | null {
  if (!eventId) return null
  if (eventId.startsWith(NATIVE_EVENT_GAP_ID_PREFIX)) {
    const firstMissingSequence = Number(eventId.slice(NATIVE_EVENT_GAP_ID_PREFIX.length))
    return Number.isSafeInteger(firstMissingSequence) && firstMissingSequence >= 0 ? firstMissingSequence : null
  }
  if (eventId.startsWith(NATIVE_EVENT_ID_PREFIX)) {
    const nativeSequence = Number(eventId.slice(NATIVE_EVENT_ID_PREFIX.length))
    return Number.isSafeInteger(nativeSequence) && nativeSequence >= 0 ? nativeSequence : null
  }
  const numeric = Number(eventId)
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null
}

function withNativeEventId(raw: unknown): unknown {
  if (!isObject(raw) || hasString(raw.id) || hasString(raw.event_id) || hasString(raw.eventId)) return raw
  const sequenceId = nativeSequenceId(raw)
  return sequenceId ? { ...raw, id: sequenceId } : raw
}

function nativeSequenceId(raw: unknown): string | null {
  if (!isObject(raw)) return null
  const sequence = raw.sequence ?? raw.sequence_id ?? raw.sequenceId ?? raw.seq
  if (typeof sequence === 'number' && Number.isFinite(sequence)) return `${NATIVE_EVENT_ID_PREFIX}${sequence}`
  if (typeof sequence === 'string' && sequence.trim()) {
    return sequence.startsWith(NATIVE_EVENT_ID_PREFIX) ? sequence : `${NATIVE_EVENT_ID_PREFIX}${sequence}`
  }
  return null
}

function nativeSequenceFromEventId(eventId: string | null | undefined): number | string | null {
  if (!eventId) return null
  if (eventId.startsWith(NATIVE_EVENT_GAP_ID_PREFIX)) {
    const firstMissingSequence = nativeEventSequenceNumber(eventId)
    return firstMissingSequence !== null && Number.isSafeInteger(firstMissingSequence) && firstMissingSequence > 0
      ? firstMissingSequence - 1
      : null
  }
  return nativeEventSequenceNumber(eventId)
}

function hasString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type { NativeEventSubjectFilter }
