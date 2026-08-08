export type NativeMobileVoicePhase =
  | 'unavailable'
  | 'idle'
  | 'listening'
  | 'processing'
  | 'faulted'

export interface NativeMobileVoiceStatus {
  available: boolean
  phase: NativeMobileVoicePhase
  running: boolean
  captureActive: boolean
  reasonCode: string | null
  redacted: true
}

export interface NativeMobileVoicePort {
  status(): Promise<NativeMobileVoiceStatus>
  start(request: { remoteAudioConsent: boolean }): Promise<NativeMobileVoiceStatus>
  startBackground(request: { remoteAudioConsent: boolean }): Promise<NativeMobileVoiceStatus>
  finish(): Promise<NativeMobileVoiceStatus>
  cancel(): Promise<NativeMobileVoiceStatus>
}
