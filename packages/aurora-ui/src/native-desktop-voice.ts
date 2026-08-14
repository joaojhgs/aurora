/** Product-safe phases reported by the installed desktop voice host. */
export type NativeDesktopVoicePhase =
  | 'unavailable'
  | 'idle'
  | 'starting'
  | 'listening'
  | 'processing'
  | 'speaking'
  | 'stopping'
  | 'faulted'

export type NativeDesktopVoiceTrigger =
  | 'focused_push_to_talk'
  | 'tray_push_to_talk'
  | 'wake_word'
  | 'background_wake'

export type NativeDesktopVoiceStopReason =
  | 'user_request'
  | 'window_hidden'
  | 'permission_revoked'
  | 'shutdown'

export type NativeDesktopVoiceConnection =
  | 'this_device'
  | 'connected_device'
  | 'unavailable'

/**
 * Bounded status shared with the WebView.
 *
 * This shape intentionally excludes audio, transcript/response text, endpoint
 * data, credentials, model paths, and capture-lease identifiers.
 */
export interface NativeDesktopVoiceStatus {
  available: boolean
  phase: NativeDesktopVoicePhase
  generation: number | null
  backgroundEligible: boolean
  connection: NativeDesktopVoiceConnection
  reasonCode: string | null
  redacted: true
}

export interface NativeDesktopVoiceStartRequest {
  trigger: NativeDesktopVoiceTrigger
  remoteAudioConsent: boolean
}

export interface NativeDesktopVoiceControlRequest {
  generation: number
  reason: NativeDesktopVoiceStopReason
}

/** Monotonic status event; it never carries raw or reconstructed speech data. */
export interface NativeDesktopVoiceEvent {
  sequence: number
  status: NativeDesktopVoiceStatus
}

/** UI-neutral control port implemented only by an installed desktop shell. */
export interface NativeDesktopVoicePort {
  status(): Promise<NativeDesktopVoiceStatus>
  start(request: NativeDesktopVoiceStartRequest): Promise<NativeDesktopVoiceStatus>
  finish(request: NativeDesktopVoiceControlRequest): Promise<NativeDesktopVoiceStatus>
  cancel(request: NativeDesktopVoiceControlRequest): Promise<NativeDesktopVoiceStatus>
  subscribe(listener: (event: NativeDesktopVoiceEvent) => void): Promise<() => void>
}
