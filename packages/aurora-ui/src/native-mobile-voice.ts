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
  backgroundActive?: boolean
  reasonCode: string | null
  redacted: true
}

export interface NativeMobileVoicePort {
  status(): Promise<NativeMobileVoiceStatus>
  start(request: { remoteAudioConsent: boolean }): Promise<NativeMobileVoiceStatus>
  finish(): Promise<NativeMobileVoiceStatus>
  cancel(): Promise<NativeMobileVoiceStatus>
  backgroundStatus?(): Promise<NativeMobileVoiceStatus>
  startBackground?(request: { remoteAudioConsent: boolean }): Promise<NativeMobileVoiceStatus>
  stopBackground?(): Promise<NativeMobileVoiceStatus>
}
