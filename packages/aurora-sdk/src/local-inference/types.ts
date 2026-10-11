import type { JsonObject, OrchestratorChatMessage } from '../types.js'

/** Uses the shared orchestrator wire message shape emitted by serializeProviderMessages. */
export type LocalInferenceChatMessage = OrchestratorChatMessage

export interface LocalInferenceToolDeclaration {
  readonly type: 'function'
  readonly function: {
    readonly name: string
    readonly description: string
    readonly parameters: JsonObject
  }
}

export interface LocalInferenceCompletionOptions {
  readonly maxTokens?: number
  readonly temperature?: number
  readonly forceTools?: boolean
  readonly toolRagTopK?: number
  readonly stopSequences?: readonly string[]
}

export interface LocalInferenceCompletionRequest {
  readonly modelId: string
  readonly sessionId: string
  readonly messages: readonly LocalInferenceChatMessage[]
  readonly tools?: readonly LocalInferenceToolDeclaration[]
  readonly options?: LocalInferenceCompletionOptions
}

export interface LocalInferenceToolCallResult {
  readonly name: string
  readonly arguments: JsonObject
}

export type LocalInferenceCompletionResponse =
  | {
      readonly type: 'message'
      readonly content: string
      readonly confidence?: number | null
      readonly usage?: Readonly<Record<string, number | undefined>>
    }
  | {
      readonly type: 'tool_calls'
      readonly content: string
      readonly toolCalls: readonly LocalInferenceToolCallResult[]
      readonly confidence?: number | null
      readonly usage?: Readonly<Record<string, number | undefined>>
    }

export type LocalInferenceEngineKind = 'cactus' | 'llamacpp' | 'litert' | 'needle2'
export type LocalInferenceSurface = 'android' | 'ios' | 'desktop'
export type LocalInferenceModelState = 'absent' | 'downloading' | 'verifying' | 'ready' | 'corrupt' | 'incompatible'

export interface LocalInferenceEngineDescriptor {
  readonly engine: LocalInferenceEngineKind
  readonly surface: LocalInferenceSurface
  readonly version: string
  readonly accelerators: readonly ('cpu' | 'gpu' | 'npu')[]
  readonly maxConcurrentModels: number
}

export interface LocalInferenceModelStatus {
  readonly modelId: string
  readonly state: LocalInferenceModelState
  readonly bytesOnDisk?: number
  readonly downloadProgress01?: number
  readonly lastError?: string | null
}

export interface LocalInferenceCatalogEntry {
  readonly modelId: string
  readonly displayLabel: string
  readonly bytes: number
  readonly capabilities: {
    readonly chat: boolean
    readonly tools: boolean
  }
}

export interface LocalInferenceSessionDescriptor {
  readonly modelId: string
  readonly sessionId: string
  /** Exact allocated bytes when the native engine reports them; null means unavailable. */
  readonly contextBytes: number | null
  /** Actual context capacity in tokens when reported by the native engine. */
  readonly contextTokens?: number
}

/** A session-bound engine adapter. Readiness is reported by the native owner, never inferred here. */
export interface LocalInferenceSessionPort {
  isReady(modelId: string, sessionId: string): boolean | Promise<boolean>
  complete(request: LocalInferenceCompletionRequest, signal: AbortSignal): Promise<LocalInferenceCompletionResponse>
}
