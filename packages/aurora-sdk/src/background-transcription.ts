import { sanitizeAuroraNodeConfigDocumentV2, type AuroraNodeConfigDocumentV2 } from './node-config.js'

export type BackgroundTranscriptionCapability = 'supported' | 'foreground_only' | 'unsupported'
export type BackgroundTranscriptionPermission = 'granted' | 'denied' | 'not_requested'
export type BackgroundTranscriptionReason = 'disabled' | 'unsupported' | 'foreground_required' |
  'permission_required' | 'permission_denied' | 'speech_unavailable' | 'storage_unavailable' | null

export interface BackgroundTranscriptionFacts {
  readonly capability: BackgroundTranscriptionCapability
  readonly permission: BackgroundTranscriptionPermission
  readonly foreground: boolean
  readonly sttAvailable: boolean
  readonly archiveAvailable: boolean
  /** Reported by the capture owner; a saved preference never implies recording. */
  readonly captureMode: 'ambient' | 'notification' | null
}

export interface BackgroundTranscriptionState {
  readonly ambientRequested: boolean
  readonly capability: BackgroundTranscriptionCapability
  readonly permission: BackgroundTranscriptionPermission
  readonly canStartAmbient: boolean
  readonly canStartNotification: boolean
  readonly recording: boolean
  readonly reason: BackgroundTranscriptionReason
  readonly retentionDays: number
}

/** Project current native facts separately from revisioned saved preferences. */
export function resolveBackgroundTranscriptionState(
  document: AuroraNodeConfigDocumentV2,
  facts: BackgroundTranscriptionFacts
): BackgroundTranscriptionState {
  const policy = sanitizeAuroraNodeConfigDocumentV2(document).backgroundTranscription
  let reason: BackgroundTranscriptionReason = null
  if (!policy.enabled || (!policy.ambient && !policy.notification)) reason = 'disabled'
  else if (facts.capability === 'unsupported') reason = 'unsupported'
  else if (facts.capability === 'foreground_only' && policy.ambient) reason = 'unsupported'
  else if (facts.capability === 'foreground_only' && !facts.foreground) reason = 'foreground_required'
  else if (facts.permission === 'denied') reason = 'permission_denied'
  else if (facts.permission !== 'granted') reason = 'permission_required'
  else if (!facts.sttAvailable) reason = 'speech_unavailable'
  else if (!facts.archiveAvailable) reason = 'storage_unavailable'
  const canStartAmbient = reason === null && policy.ambient && facts.capability === 'supported'
  const canStartNotification = reason === null && policy.notification && !policy.ambient
  return {
    ambientRequested: policy.enabled && policy.ambient,
    capability: facts.capability,
    permission: facts.permission,
    canStartAmbient,
    canStartNotification,
    recording: facts.captureMode === 'ambient' ? canStartAmbient :
      facts.captureMode === 'notification' ? canStartNotification : false,
    reason,
    retentionDays: policy.retentionDays
  }
}
