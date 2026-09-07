import {
  GeneratedContractClient,
  type GeneratedBackendClientMethodId,
  type GeneratedBackendMethodInput,
  type GeneratedBackendMethodOutput,
  type GeneratedContractRequestOptions
} from './generated-contracts.js'
import type { AuroraResponse } from './transport.js'

type SpeechMethodId = Extract<
  GeneratedBackendClientMethodId,
  | `TTS.${string}`
  | `STTCoordinator.${string}`
  | `WakeWord.${string}`
  | `Transcription.${string}`
  | `VAD.${string}`
>

type SpeechInput<TMethodId extends SpeechMethodId> = GeneratedBackendMethodInput<TMethodId>
type SpeechResult<TMethodId extends SpeechMethodId> = Promise<
  AuroraResponse<GeneratedBackendMethodOutput<TMethodId>>
>

class SpeechNamespaceClient {
  constructor(protected readonly contracts: GeneratedContractClient) {}

  protected request<TMethodId extends SpeechMethodId>(
    methodId: TMethodId,
    input: SpeechInput<TMethodId>,
    options: GeneratedContractRequestOptions = {}
  ): SpeechResult<TMethodId> {
    return this.contracts.requestResult(methodId, input, options)
  }
}

/** Generated-contract TTS operations, including voice discovery and management. */
export class TtsClient extends SpeechNamespaceClient {
  /** Load the active TTS capabilities. */
  getCapabilities(
    input: SpeechInput<'TTS.GetCapabilities'> = {},
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'TTS.GetCapabilities'> {
    return this.request('TTS.GetCapabilities', input, options)
  }

  /** List voices available for synthesis. */
  listVoices(
    input: SpeechInput<'TTS.ListVoices'> = {},
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'TTS.ListVoices'> {
    return this.request('TTS.ListVoices', input, options)
  }

  /** List managed voice profiles. */
  listVoiceProfiles(
    input: SpeechInput<'TTS.ListVoiceProfiles'> = {},
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'TTS.ListVoiceProfiles'> {
    return this.request('TTS.ListVoiceProfiles', input, options)
  }

  /** Load one managed voice profile. */
  getVoiceProfile(
    input: SpeechInput<'TTS.GetVoiceProfile'>,
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'TTS.GetVoiceProfile'> {
    return this.request('TTS.GetVoiceProfile', input, options)
  }

  /** Update a managed voice profile. */
  updateVoiceProfile(
    input: SpeechInput<'TTS.UpdateVoiceProfile'>,
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'TTS.UpdateVoiceProfile'> {
    return this.request('TTS.UpdateVoiceProfile', input, options)
  }

  /** Install a managed voice profile. */
  installVoiceProfile(
    input: SpeechInput<'TTS.InstallVoiceProfile'>,
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'TTS.InstallVoiceProfile'> {
    return this.request('TTS.InstallVoiceProfile', input, options)
  }

  /** Remove an installed voice profile. */
  removeVoiceProfile(
    input: SpeechInput<'TTS.RemoveVoiceProfile'>,
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'TTS.RemoveVoiceProfile'> {
    return this.request('TTS.RemoveVoiceProfile', input, options)
  }

  /** Select the default voice. */
  setDefaultVoice(
    input: SpeechInput<'TTS.SetDefaultVoice'>,
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'TTS.SetDefaultVoice'> {
    return this.request('TTS.SetDefaultVoice', input, options)
  }

  /** Begin a bounded voice import. */
  startVoiceImport(
    input: SpeechInput<'TTS.VoiceImportStart'>,
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'TTS.VoiceImportStart'> {
    return this.request('TTS.VoiceImportStart', input, options)
  }

  /** Append one validated chunk to a voice import. */
  appendVoiceImportChunk(
    input: SpeechInput<'TTS.VoiceImportChunk'>,
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'TTS.VoiceImportChunk'> {
    return this.request('TTS.VoiceImportChunk', input, options)
  }

  /** Finish a voice import. */
  finishVoiceImport(
    input: SpeechInput<'TTS.VoiceImportEnd'>,
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'TTS.VoiceImportEnd'> {
    return this.request('TTS.VoiceImportEnd', input, options)
  }

  /** Abort a voice import. */
  abortVoiceImport(
    input: SpeechInput<'TTS.VoiceImportAbort'>,
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'TTS.VoiceImportAbort'> {
    return this.request('TTS.VoiceImportAbort', input, options)
  }

  /** Create a voice profile from a sealed local import. */
  createVoiceProfile(
    input: SpeechInput<'TTS.CreateVoiceProfile'>,
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'TTS.CreateVoiceProfile'> {
    return this.request('TTS.CreateVoiceProfile', input, options)
  }

  /** Delete a voice profile. */
  deleteVoiceProfile(
    input: SpeechInput<'TTS.DeleteVoiceProfile'>,
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'TTS.DeleteVoiceProfile'> {
    return this.request('TTS.DeleteVoiceProfile', input, options)
  }

  /** Export a cloned voice profile as a bounded derived-state bundle. */
  exportVoiceProfile(
    input: SpeechInput<'TTS.ExportVoiceProfile'>,
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'TTS.ExportVoiceProfile'> {
    return this.request('TTS.ExportVoiceProfile', input, options)
  }

  /** Import a bounded derived-state bundle as a cloned voice profile. */
  importVoiceProfile(
    input: SpeechInput<'TTS.ImportVoiceProfile'>,
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'TTS.ImportVoiceProfile'> {
    return this.request('TTS.ImportVoiceProfile', input, options)
  }

  /** Request immediate speech playback. */
  requestPlayback(
    input: SpeechInput<'TTS.Request'>,
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'TTS.Request'> {
    return this.request('TTS.Request', input, options)
  }

  /** Start an ordered text stream. */
  startStream(
    input: SpeechInput<'TTS.StreamStart'>,
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'TTS.StreamStart'> {
    return this.request('TTS.StreamStart', input, options)
  }

  /** Append text to an ordered stream. */
  appendStreamChunk(
    input: SpeechInput<'TTS.StreamChunk'>,
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'TTS.StreamChunk'> {
    return this.request('TTS.StreamChunk', input, options)
  }

  /** End an ordered text stream. */
  endStream(
    input: SpeechInput<'TTS.StreamEnd'>,
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'TTS.StreamEnd'> {
    return this.request('TTS.StreamEnd', input, options)
  }

  /** Admit a caller-owned stream before sending text frames. */
  prepareStream(
    input: SpeechInput<'TTS.StreamPrepareV1'>,
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'TTS.StreamPrepareV1'> {
    return this.request('TTS.StreamPrepareV1', input, options)
  }

  /** Read the bounded status of an admitted caller-owned stream. */
  streamStatus(
    input: SpeechInput<'TTS.StreamStatus'>,
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'TTS.StreamStatus'> {
    return this.request('TTS.StreamStatus', input, options)
  }

  /** Cancel a caller-owned stream without taking server playback ownership. */
  cancelStream(
    input: SpeechInput<'TTS.StreamCancel'>,
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'TTS.StreamCancel'> {
    return this.request('TTS.StreamCancel', input, options)
  }

  /** Return terminal metadata for a caller-owned stream. */
  resultStream(
    input: SpeechInput<'TTS.StreamResult'>,
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'TTS.StreamResult'> {
    return this.request('TTS.StreamResult', input, options)
  }

  /** Synthesize speech without starting playback. */
  synthesize(
    input: SpeechInput<'TTS.Synthesize'>,
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'TTS.Synthesize'> {
    return this.request('TTS.Synthesize', input, options)
  }
}

/** Focused listening-session controls backed by generated contracts. */
export class SttClient extends SpeechNamespaceClient {
  /** Start a focused listening session. */
  listen(
    input: SpeechInput<'STTCoordinator.Listen'> = {},
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'STTCoordinator.Listen'> {
    return this.request('STTCoordinator.Listen', input, options)
  }

  /** Stop the current focused listening session. */
  stopListening(
    input: SpeechInput<'STTCoordinator.StopListening'> = {},
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'STTCoordinator.StopListening'> {
    return this.request('STTCoordinator.StopListening', input, options)
  }
}

/** Explicit wake-word detection without continuous remote capture. */
export class WakeWordClient extends SpeechNamespaceClient {
  /** Detect a wake word in a caller-provided bounded audio sample. */
  detect(
    input: SpeechInput<'WakeWord.Detect'>,
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'WakeWord.Detect'> {
    return this.request('WakeWord.Detect', input, options)
  }

  startStream(
    input: SpeechInput<'WakeWord.StreamStart'>,
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'WakeWord.StreamStart'> {
    return this.request('WakeWord.StreamStart', input, options)
  }

  appendStreamChunk(
    input: SpeechInput<'WakeWord.StreamChunk'>,
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'WakeWord.StreamChunk'> {
    return this.request('WakeWord.StreamChunk', input, options)
  }

  endStream(
    input: SpeechInput<'WakeWord.StreamEnd'>,
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'WakeWord.StreamEnd'> {
    return this.request('WakeWord.StreamEnd', input, options)
  }

  cancelStream(
    input: SpeechInput<'WakeWord.StreamCancel'>,
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'WakeWord.StreamCancel'> {
    return this.request('WakeWord.StreamCancel', input, options)
  }

  streamStatus(
    input: SpeechInput<'WakeWord.StreamStatus'>,
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'WakeWord.StreamStatus'> {
    return this.request('WakeWord.StreamStatus', input, options)
  }

  resultStream(
    input: SpeechInput<'WakeWord.StreamResult'>,
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'WakeWord.StreamResult'> {
    return this.request('WakeWord.StreamResult', input, options)
  }
}

/** Bounded audio transcription operations backed by generated contracts. */
export class TranscriptionClient extends SpeechNamespaceClient {
  /** Transcribe a bounded audio payload. */
  transcribe(
    input: SpeechInput<'Transcription.Transcribe'>,
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'Transcription.Transcribe'> {
    return this.request('Transcription.Transcribe', input, options)
  }

  startStream(
    input: SpeechInput<'Transcription.StreamStart'>,
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'Transcription.StreamStart'> {
    return this.request('Transcription.StreamStart', input, options)
  }

  appendStreamChunk(
    input: SpeechInput<'Transcription.StreamChunk'>,
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'Transcription.StreamChunk'> {
    return this.request('Transcription.StreamChunk', input, options)
  }

  endStream(
    input: SpeechInput<'Transcription.StreamEnd'>,
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'Transcription.StreamEnd'> {
    return this.request('Transcription.StreamEnd', input, options)
  }

  cancelStream(
    input: SpeechInput<'Transcription.StreamCancel'>,
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'Transcription.StreamCancel'> {
    return this.request('Transcription.StreamCancel', input, options)
  }

  streamStatus(
    input: SpeechInput<'Transcription.StreamStatus'>,
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'Transcription.StreamStatus'> {
    return this.request('Transcription.StreamStatus', input, options)
  }

  resultStream(
    input: SpeechInput<'Transcription.StreamResult'>,
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'Transcription.StreamResult'> {
    return this.request('Transcription.StreamResult', input, options)
  }
}

/** Bounded finite and foreground streaming voice-activity operations. */
export class VadClient extends SpeechNamespaceClient {
  detect(
    input: SpeechInput<'VAD.Detect'>,
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'VAD.Detect'> {
    return this.request('VAD.Detect', input, options)
  }

  startStream(
    input: SpeechInput<'VAD.StreamStart'>,
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'VAD.StreamStart'> {
    return this.request('VAD.StreamStart', input, options)
  }

  appendStreamChunk(
    input: SpeechInput<'VAD.StreamChunk'>,
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'VAD.StreamChunk'> {
    return this.request('VAD.StreamChunk', input, options)
  }

  endStream(
    input: SpeechInput<'VAD.StreamEnd'>,
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'VAD.StreamEnd'> {
    return this.request('VAD.StreamEnd', input, options)
  }

  cancelStream(
    input: SpeechInput<'VAD.StreamCancel'>,
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'VAD.StreamCancel'> {
    return this.request('VAD.StreamCancel', input, options)
  }

  streamStatus(
    input: SpeechInput<'VAD.StreamStatus'>,
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'VAD.StreamStatus'> {
    return this.request('VAD.StreamStatus', input, options)
  }

  resultStream(
    input: SpeechInput<'VAD.StreamResult'>,
    options?: GeneratedContractRequestOptions
  ): SpeechResult<'VAD.StreamResult'> {
    return this.request('VAD.StreamResult', input, options)
  }
}

/** Generated-contract speech client grouped by service responsibility. */
export class SpeechClient {
  readonly tts: TtsClient
  readonly stt: SttClient
  readonly wakeWord: WakeWordClient
  readonly transcription: TranscriptionClient
  readonly vad: VadClient

  constructor(contracts: GeneratedContractClient) {
    this.tts = new TtsClient(contracts)
    this.stt = new SttClient(contracts)
    this.wakeWord = new WakeWordClient(contracts)
    this.transcription = new TranscriptionClient(contracts)
    this.vad = new VadClient(contracts)
  }
}
