import type { LocalDataSession, LocalDataScope } from '../local-data/index.js'
import type {
  JsonObject,
  JsonValue,
  ToolingPrepareExecutionRequest,
  ToolingPrepareExecutionResponse,
  ToolingProjectionToolInfo
} from '../types.js'
import type { LightweightOrchestratorLimits } from './limits.js'

export type LightweightToolRoute = 'local' | 'remote'

export interface LightweightToolCall {
  readonly id: string
  readonly toolName: string
  readonly arguments: JsonObject
  readonly route: LightweightToolRoute
  readonly resourceSelector?: JsonObject | null
  readonly meshSelector?: JsonObject | null
}

export interface LightweightProviderMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  readonly content: string
  readonly toolCallId?: string | null
  readonly name?: string | null
}

export interface LightweightProviderRequest {
  readonly messages: readonly LightweightProviderMessage[]
  readonly tools: readonly ToolingProjectionToolInfo[]
  readonly maxToolCalls: number
  readonly signal: AbortSignal
}

export type LightweightProviderResponse =
  | {
      readonly type: 'message'
      readonly content: string
    }
  | {
      readonly type: 'tool_calls'
      readonly content?: string | null
      readonly toolCalls: readonly LightweightToolCall[]
    }

export interface LightweightAssistantProvider {
  complete(request: LightweightProviderRequest): Promise<LightweightProviderResponse>
}

export interface LightweightToolClientPort {
  prepareExecution(payload: ToolingPrepareExecutionRequest): Promise<ToolingPrepareExecutionResponse>
  execute(payload: ToolingPrepareExecutionRequest): Promise<LightweightToolExecutionResponse>
}

export interface LightweightToolExecutionResponse {
  readonly ok: boolean
  readonly data?: JsonValue | null
  readonly error?: string | null
  readonly error_code?: string | null
  readonly status?: 'denied' | 'dry_run' | 'failed' | 'not_found' | 'success' | string | null
  readonly correlation_id?: string | null
  readonly provider_peer_id?: string | null
  readonly global_tool_id?: string | null
}

export interface LightweightTimerPort {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface LightweightOrchestratorOptions {
  readonly provider: LightweightAssistantProvider
  readonly tools: LightweightToolClientPort
  readonly localData: LocalDataSession
  readonly scope: LocalDataScope
  readonly availableTools: readonly ToolingProjectionToolInfo[]
  readonly nowMs?: () => number
  readonly ids?: () => string
  readonly timers?: LightweightTimerPort
  readonly limits?: Partial<LightweightOrchestratorLimits>
}

export interface LightweightTurnInput {
  readonly text: string
  readonly conversationId?: string | null
  readonly signal?: AbortSignal
}

export type LightweightTurnStatus =
  | 'completed'
  | 'awaiting_confirmation'
  | 'cancelled'
  | 'error'

export interface LightweightConfirmationEvent {
  readonly token: string
  readonly conversationId: string
  readonly toolCall: LightweightToolCall
  readonly prepared: ToolingPrepareExecutionResponse
  readonly secretsRedacted: true
}

export interface LightweightTurnResult {
  readonly status: LightweightTurnStatus
  readonly conversationId: string
  readonly assistantText: string
  readonly confirmation?: LightweightConfirmationEvent
  readonly diagnostics?: JsonObject
}

export type LightweightConfirmationDecision = 'approve' | 'deny'

export interface LightweightConfirmationInput {
  readonly token: string
  readonly decision: LightweightConfirmationDecision
  readonly signal?: AbortSignal
}

export interface LightweightRecoveryResult {
  readonly cancelledMessages: number
  readonly conversationIds: readonly string[]
}
