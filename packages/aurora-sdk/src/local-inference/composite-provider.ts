import {
  resolveLightweightOrchestratorLimits,
  LightweightOrchestratorError,
  type LightweightOrchestratorLimits
} from '../lightweight-orchestrator/limits.js'
import type {
  LightweightAssistantProvider,
  LightweightProviderRequest,
  LightweightProviderResponse
} from '../lightweight-orchestrator/types.js'
import { createLocalInferenceProvider } from './provider.js'
import type { LocalInferenceSessionPort } from './types.js'

export interface LocalInferenceCompositeProviderOptions {
  readonly client: LocalInferenceSessionPort
  readonly actions?: { readonly modelId: string; readonly sessionId: string }
  readonly chat?: { readonly modelId: string; readonly sessionId: string }
  readonly ids?: () => string
  readonly limits?: Partial<LightweightOrchestratorLimits>
}

type LocalSessionRole = 'actions' | 'chat'

/**
 * Routes one offline provider across action and chat sessions without replaying a failed turn.
 * The stable turnSignal owns affinity for product turns. Legacy direct callers must serialize
 * turns; only their latest session choice is retained and a trailing user message starts a new turn.
 */
export function createLocalCompositeProvider(
  options: LocalInferenceCompositeProviderOptions
): LightweightAssistantProvider {
  const limits = resolveLightweightOrchestratorLimits(options.limits)
  const providers = new Map<LocalSessionRole, LightweightAssistantProvider>()
  if (options.actions) {
    providers.set('actions', createLocalInferenceProvider({
      client: options.client,
      modelId: options.actions.modelId,
      sessionId: options.actions.sessionId,
      ...(options.ids === undefined ? {} : { ids: options.ids }),
      limits
    }))
  }
  if (options.chat) {
    providers.set('chat', createLocalInferenceProvider({
      client: options.client,
      modelId: options.chat.modelId,
      sessionId: options.chat.sessionId,
      ...(options.ids === undefined ? {} : { ids: options.ids }),
      limits
    }))
  }

  const signalAffinities = new WeakMap<AbortSignal, LocalSessionRole>()
  let latestLegacyAffinity: LocalSessionRole | undefined

  return {
    async complete(request: LightweightProviderRequest): Promise<LightweightProviderResponse> {
      const turnSignal = request.turnSignal
      if (request.signal.aborted || turnSignal?.aborted) throw cancelled()
      const hasTurnSignal = turnSignal !== undefined
      const trailingUser = request.messages.at(-1)?.role === 'user'
      if (!hasTurnSignal && trailingUser) latestLegacyAffinity = undefined
      const preferred = hasLocalToolIntent(request) ? 'actions' : 'chat'
      const existing = hasTurnSignal ? signalAffinities.get(turnSignal) : latestLegacyAffinity
      const selected = existing
        ? continueBoundTurn(existing, request, options)
        : await selectReadySession(preferred, request, providers, options)

      if (!existing) {
        if (!hasTurnSignal) latestLegacyAffinity = selected
        else signalAffinities.set(turnSignal, selected)
      }
      const provider = providers.get(selected)
      if (!provider) throw unavailable()

      // A failure retains the chosen session; only a final message closes the turn affinity.
      const response = await provider.complete(request)
      if (response.type === 'message') {
        if (!hasTurnSignal) latestLegacyAffinity = undefined
        else signalAffinities.delete(turnSignal)
      }
      return response
    }
  }
}

function continueBoundTurn(
  role: LocalSessionRole,
  request: LightweightProviderRequest,
  options: LocalInferenceCompositeProviderOptions
): LocalSessionRole {
  const binding = options[role]
  if (!binding) throw unavailable()
  if (request.modelId !== undefined && request.modelId !== null && request.modelId !== binding.modelId) {
    throw unavailable()
  }
  return role
}

async function selectReadySession(
  preferred: LocalSessionRole,
  request: LightweightProviderRequest,
  providers: ReadonlyMap<LocalSessionRole, LightweightAssistantProvider>,
  options: LocalInferenceCompositeProviderOptions
): Promise<LocalSessionRole> {
  const configured = configuredRoles(options).filter((role) => providers.has(role))
  if (configured.length === 0) throw unavailable()

  let candidates = configured
  if (request.modelId !== undefined && request.modelId !== null) {
    candidates = configured.filter((role) => options[role]!.modelId === request.modelId)
    if (candidates.length === 0) throw unavailable()
  }

  const readiness = await Promise.all(candidates.map(async (role) => {
    const binding = options[role]!
    try {
      return await options.client.isReady(binding.modelId, binding.sessionId)
    } catch {
      return false
    }
  }))
  const readyRoles = candidates.filter((_role, index) => readiness[index] === true)
  if (readyRoles.length === 0) throw unavailable()
  if (readyRoles.length === 1) return readyRoles[0]!
  return readyRoles.includes(preferred) ? preferred : readyRoles[0]!
}

function configuredRoles(options: LocalInferenceCompositeProviderOptions): LocalSessionRole[] {
  return [
    ...(options.actions ? ['actions' as const] : []),
    ...(options.chat ? ['chat' as const] : [])
  ]
}

function hasLocalToolIntent(request: LightweightProviderRequest): boolean {
  if (request.tools.some((tool) =>
    tool.execution_location === 'local' &&
    tool.source_type === 'local' &&
    tool.provider_available !== false
  )) return true

  let lastUserIndex = -1
  request.messages.forEach((message, index) => {
    if (message.role === 'user') lastUserIndex = index
  })
  return request.messages.slice(lastUserIndex + 1).some((message) =>
    message.role === 'assistant' && message.toolCalls?.some((toolCall) => toolCall.route === 'local') === true
  )
}

function unavailable(): LightweightOrchestratorError {
  return new LightweightOrchestratorError('unavailable_service', 'Selected on-device assistant is unavailable')
}

function cancelled(): LightweightOrchestratorError {
  return new LightweightOrchestratorError('provider_call_cancelled')
}
