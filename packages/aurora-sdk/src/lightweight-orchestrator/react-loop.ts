import { buildEnvelopeAad, type ConversationMessageRecord, type ConversationRecord, type EncryptedDataEnvelopeV1, type LocalDataScope } from '../local-data/index.js'
import {
  assertSerializedBound,
  assertTextBound,
  redactedDiagnostic,
  resolveLightweightOrchestratorLimits,
  LightweightOrchestratorError
} from './limits.js'
import { buildOpenAIToolAliases } from './provider.js'
import type {
  LightweightConfirmationInput,
  LightweightOrchestratorOptions,
  LightweightProviderMessage,
  LightweightProviderResponse,
  LightweightRecoveryResult,
  LightweightToolCall,
  LightweightToolExecutionResponse,
  LightweightTurnInput,
  LightweightTurnResult
} from './types.js'
import type { ToolingPrepareExecutionResponse, ToolingProjectionToolInfo } from '../types.js'

interface PendingConfirmation {
  readonly token: string
  readonly conversationId: string
  readonly messages: LightweightProviderMessage[]
  readonly toolCall: LightweightToolCall
  readonly prepared: ToolingPrepareExecutionResponse
  readonly approvalRequestId: string
  readonly providerId: string | null
  readonly modelId: string | null
  readonly controller: AbortController
  readonly timeoutHandle: unknown
  readonly expiresAtMs: number
  readonly startedAtMs: number
  used: boolean
}

const PYTHON_ONLY_HINTS = new Set(['python', 'sidecar', 'rag', 'stt', 'tts', 'scheduler', 'orchestrator'])

export class LightweightOrchestrator {
  private readonly limits
  private readonly nowMs: () => number
  private readonly ids: () => string
  private readonly timers
  private readonly pending = new Map<string, PendingConfirmation>()
  private readonly expiredTokens = new Set<string>()

  constructor(private readonly options: LightweightOrchestratorOptions) {
    this.limits = resolveLightweightOrchestratorLimits(options.limits)
    this.nowMs = options.nowMs ?? (() => Date.now())
    this.ids = options.ids ?? (() => crypto.randomUUID())
    this.timers = options.timers ?? globalTimerPort()
    validateScope(options.scope)
    validateTools(options.availableTools, this.limits)
    buildOpenAIToolAliases(options.availableTools)
  }

  async recoverStalePending(): Promise<LightweightRecoveryResult> {
    const conversations = await this.options.localData.conversations.listConversations()
    const scoped = conversations.filter((conversation) => conversation.profileId === this.options.scope.profileId && conversation.localNodeId === this.options.scope.localNodeId)
    let cancelledMessages = 0
    const conversationIds = new Set<string>()
    for (const conversation of scoped) {
      const messages = await this.options.localData.conversations.listMessages(conversation.id)
      const pending = messages.filter((message) => message.status === 'pending')
      for (const message of pending) {
        await this.options.localData.conversations.appendMessage(await this.messageRecord(conversation.id, nextSequence(messages) + cancelledMessages, 'system', 'cancelled', {}))
        cancelledMessages += 1
        conversationIds.add(message.conversationId)
      }
    }
    return { cancelledMessages, conversationIds: [...conversationIds].sort() }
  }

  async runTurn(input: LightweightTurnInput): Promise<LightweightTurnResult> {
    const conversationId = input.conversationId ?? `lw-conv-${this.ids()}`
    const controller = this.turnController(input.signal)
    let conversationReady = false
    try {
      assertTextBound(input.text, this.limits.maxPromptBytes, 'prompt_too_large')
      await this.ensureConversation(conversationId)
      conversationReady = true
      const history = await this.loadConversationHistory(conversationId)
      await this.appendState(conversationId, 'user', 'complete', { content: input.text })
      let messages: LightweightProviderMessage[] = [...history, { role: 'user', content: input.text }]
      let assistantText = ''
      let totalTools = 0
      for (let iteration = 0; iteration < this.limits.maxIterations; iteration += 1) {
        throwIfAborted(controller.signal)
        const providerResponse = await this.callProvider(
          messages,
          controller.signal,
          input.providerId ?? null,
          input.modelId ?? null
        )
        if (providerResponse.type === 'message') {
          assertTextBound(providerResponse.content, this.limits.maxProviderResponseBytes, 'provider_response_too_large')
          await this.appendState(conversationId, 'assistant', 'complete', { content: providerResponse.content })
          return { status: 'completed', conversationId, assistantText: providerResponse.content }
        }
        totalTools += providerResponse.toolCalls.length
        if (totalTools > this.limits.maxTotalTools) throw new LightweightOrchestratorError('tool_total_limit_exceeded')
        const preparedMessages = await this.executeToolCalls(
          conversationId,
          messages,
          providerResponse,
          controller,
          input.providerId ?? null,
          input.modelId ?? null
        )
        if ('confirmation' in preparedMessages) {
          return {
            status: 'awaiting_confirmation',
            conversationId,
            assistantText,
            confirmation: preparedMessages.confirmation
          }
        }
        messages = preparedMessages.messages
        assistantText = providerResponse.content ?? assistantText
      }
      throw new LightweightOrchestratorError('iteration_limit_exceeded')
    } catch (error) {
      if (isAbortError(error)) {
        if (conversationReady) await this.appendState(conversationId, 'assistant', 'cancelled')
        return { status: 'cancelled', conversationId, assistantText: '', diagnostics: redactedDiagnostic('turn_cancelled') }
      }
      if (conversationReady) await this.appendState(conversationId, 'assistant', 'failed')
      throw error
    } finally {
      controller.abort()
    }
  }

  async resumeConfirmation(input: LightweightConfirmationInput): Promise<LightweightTurnResult> {
    const pending = this.pending.get(input.token)
    if (!pending || pending.used) {
      throw new LightweightOrchestratorError(this.expiredTokens.has(input.token) ? 'confirmation_token_expired' : 'confirmation_token_replayed')
    }
    if (pending.expiresAtMs <= this.nowMs()) {
      await this.expirePending(input.token)
      throw new LightweightOrchestratorError('confirmation_token_expired')
    }
    pending.used = true
    this.pending.delete(input.token)
    this.timers.clearTimeout(pending.timeoutHandle)
    if (input.decision === 'deny') {
      await this.denyApproval(pending, input.grantScope ?? 'deny_once')
      pending.controller.abort()
      await this.appendState(pending.conversationId, 'tool', 'cancelled', { tool: { type: 'tool_cancelled', toolCall: persistedToolCall(pending.toolCall), secretsRedacted: true } })
      return {
        status: 'cancelled',
        conversationId: pending.conversationId,
        assistantText: '',
        diagnostics: redactedDiagnostic('confirmation_denied')
      }
    }
    const controller = this.turnController(input.signal)
    try {
      const approval = await this.confirmApproval(
        pending,
        controller.signal,
        input.grantScope ?? 'once'
      )
      const result = await this.executePreparedTool(pending.toolCall, pending.prepared, controller.signal, approval.approval_token)
      const messages = [...pending.messages, toolResultMessage(pending.toolCall, result)]
      const providerResponse = await this.callProvider(
        messages,
        controller.signal,
        pending.providerId,
        pending.modelId
      )
      if (providerResponse.type !== 'message') {
        throw new LightweightOrchestratorError('provider_nested_confirmation_not_supported')
      }
      await this.appendState(pending.conversationId, 'tool', result.ok ? 'complete' : 'failed', { tool: persistedToolResult(pending.toolCall, result) })
      await this.appendState(pending.conversationId, 'assistant', 'complete', { content: providerResponse.content })
      return {
        status: 'completed',
        conversationId: pending.conversationId,
        assistantText: providerResponse.content
      }
    } catch (error) {
      if (isAbortError(error)) {
        await this.appendState(pending.conversationId, 'tool', 'cancelled', { tool: { type: 'tool_cancelled', toolCall: persistedToolCall(pending.toolCall), secretsRedacted: true } })
        return { status: 'cancelled', conversationId: pending.conversationId, assistantText: '', diagnostics: redactedDiagnostic('turn_cancelled') }
      }
      await this.appendState(pending.conversationId, 'tool', 'failed', { tool: { type: 'tool_failed', toolCall: persistedToolCall(pending.toolCall), secretsRedacted: true } })
      throw error
    } finally {
      controller.abort()
    }
  }

  cancel(token?: string): void {
    if (token !== undefined) {
      const pending = this.pending.get(token)
      pending?.controller.abort()
      if (pending) this.timers.clearTimeout(pending.timeoutHandle)
      this.pending.delete(token)
      return
    }
    for (const pending of this.pending.values()) {
      pending.controller.abort()
      this.timers.clearTimeout(pending.timeoutHandle)
    }
    this.pending.clear()
  }

  private async executeToolCalls(
    conversationId: string,
    messages: LightweightProviderMessage[],
    providerResponse: Extract<LightweightProviderResponse, { type: 'tool_calls' }>,
    controller: AbortController,
    providerId: string | null,
    modelId: string | null
  ): Promise<{ messages: LightweightProviderMessage[] } | { confirmation: NonNullable<LightweightTurnResult['confirmation']> }> {
    if (providerResponse.toolCalls.length === 0 || providerResponse.toolCalls.length > this.limits.maxToolsPerIteration) {
      throw new LightweightOrchestratorError('tool_iteration_limit_exceeded')
    }
    const seen = new Set<string>()
    const nextMessages: LightweightProviderMessage[] = [
      ...messages,
      {
        role: 'assistant',
        content: providerResponse.content ?? '',
        toolCalls: providerResponse.toolCalls
      }
    ]
    for (const toolCall of providerResponse.toolCalls) {
      this.validateToolCall(toolCall, seen)
      const prepared = await this.prepareTool(toolCall)
      if (requiresApproval(prepared, this.toolInfo(toolCall))) {
        const approval = await this.requestApproval(toolCall, prepared)
        if (!approval.ok || !approval.approval_request_id) {
          nextMessages.push(toolResultMessage(toolCall, { ok: false, error_code: approval.error ?? 'approval_request_failed', status: 'denied' }))
          continue
        }
        const token = `lw-confirm-${this.ids()}`
        const expiresAtMs = this.confirmationExpiresAtMs(prepared, approval.expires_at)
        const pending: PendingConfirmation = {
          token,
          conversationId,
          messages: nextMessages,
          toolCall,
          prepared,
          approvalRequestId: approval.approval_request_id,
          providerId,
          modelId,
          controller,
          timeoutHandle: this.timers.setTimeout(() => {
            void this.expirePending(token)
          }, Math.max(0, expiresAtMs - this.nowMs())),
          expiresAtMs,
          startedAtMs: this.nowMs(),
          used: false
        }
        this.pending.set(token, pending)
        await this.appendState(conversationId, 'tool', 'pending', {
          tool: {
            type: 'tool_call',
            assistantContent: providerResponse.content ?? null,
            toolCall: persistedToolCall(toolCall),
            secretsRedacted: true
          }
        })
        return {
          confirmation: {
            token,
            conversationId,
            toolCall,
            prepared,
            secretsRedacted: true
          }
        }
      }
      if (!prepared.ok || prepared.policy_decision.allowed !== true) {
        nextMessages.push(toolResultMessage(toolCall, { ok: false, error_code: prepared.policy_decision.reason ?? 'policy_denied', status: 'denied' }))
        continue
      }
      const result = await this.executePreparedTool(toolCall, prepared, controller.signal)
      nextMessages.push(toolResultMessage(toolCall, result))
      await this.appendState(conversationId, 'tool', result.ok ? 'complete' : 'failed', { tool: persistedToolResult(toolCall, result) })
    }
    return { messages: nextMessages }
  }

  private async prepareTool(toolCall: LightweightToolCall) {
    assertSerializedBound(toolCall.arguments, this.limits.maxArgsBytes, 'tool_arguments_too_large')
    return await this.options.tools.prepareExecution({
      tool_name: toolCall.toolName,
      arguments: toolCall.arguments,
      resource_selector: toolCall.resourceSelector ?? routeSelector(toolCall),
      mesh_selector: toolCall.meshSelector ?? null,
      correlation_id: `lw-corr-${this.ids()}`
    })
  }

  private async executePreparedTool(
    toolCall: LightweightToolCall,
    prepared: ToolingPrepareExecutionResponse,
    signal: AbortSignal,
    approvalToken: string | null = null
  ): Promise<LightweightToolExecutionResponse> {
    throwIfAborted(signal)
    const result = await this.options.tools.execute({
      tool_name: toolCall.toolName,
      arguments: toolCall.arguments,
      expected_args_schema_hash: prepared.args_schema_hash ?? null,
      resource_selector: toolCall.resourceSelector ?? routeSelector(toolCall),
      mesh_selector: toolCall.meshSelector ?? null,
      ...(approvalToken ? { confirmed: true } : {}),
      approval_token: approvalToken,
      correlation_id: prepared.correlation_id
    })
    assertSerializedBound((result as LightweightToolExecutionResponse).data ?? null, this.limits.maxResultBytes, 'tool_result_too_large')
    return result as LightweightToolExecutionResponse
  }

  private async requestApproval(toolCall: LightweightToolCall, prepared: ToolingPrepareExecutionResponse) {
    return await this.options.tools.requestApproval({
      tool_name: prepared.global_tool_id || toolCall.toolName,
      arguments: toolCall.arguments,
      expected_args_schema_hash: prepared.args_schema_hash ?? null,
      resource_selector: toolCall.resourceSelector ?? routeSelector(toolCall),
      mesh_selector: toolCall.meshSelector ?? null,
      correlation_id: prepared.correlation_id,
      caller_principal_id: this.options.approvalPrincipalId ?? this.options.scope.profileId
    })
  }

  private async confirmApproval(
    pending: PendingConfirmation,
    signal: AbortSignal,
    grantScope: import('../types.js').ToolingApprovalGrantScope
  ) {
    throwIfAborted(signal)
    const response = await this.options.tools.confirmExecution({
      approval_request_id: pending.approvalRequestId,
      approver_principal_id: this.options.approvalPrincipalId ?? this.options.scope.profileId,
      approve: true,
      grant_scope: grantScope,
      reason: 'lightweight_assistant_confirmation',
      correlation_id: pending.prepared.correlation_id
    })
    if (!response.ok || !response.approval_token) {
      throw new LightweightOrchestratorError(response.error ?? 'approval_token_required')
    }
    return response
  }

  private async denyApproval(
    pending: PendingConfirmation,
    grantScope: import('../types.js').ToolingApprovalGrantScope
  ): Promise<void> {
    const response = await this.options.tools.confirmExecution({
      approval_request_id: pending.approvalRequestId,
      approver_principal_id: this.options.approvalPrincipalId ?? this.options.scope.profileId,
      approve: false,
      grant_scope: grantScope,
      reason: 'lightweight_assistant_confirmation_denied',
      correlation_id: pending.prepared.correlation_id
    })
    if (response.ok) {
      throw new LightweightOrchestratorError('approval_denial_malformed')
    }
  }

  private confirmationExpiresAtMs(prepared: ToolingPrepareExecutionResponse, backendExpiresAtSeconds: number | null): number {
    const localMaxExpiresAt = this.nowMs() + this.limits.confirmationTokenTimeoutMs
    const backendExpiresAt = typeof backendExpiresAtSeconds === 'number' && Number.isFinite(backendExpiresAtSeconds)
      ? backendExpiresAtSeconds * 1000
      : null
    const ttlSeconds = prepared.policy_decision.token_ttl_seconds
    const policyExpiresAt = typeof ttlSeconds === 'number' && Number.isFinite(ttlSeconds)
      ? this.nowMs() + Math.max(0, ttlSeconds * 1000)
      : null
    return Math.min(localMaxExpiresAt, backendExpiresAt ?? localMaxExpiresAt, policyExpiresAt ?? localMaxExpiresAt)
  }

  private async expirePending(token: string): Promise<void> {
    const pending = this.pending.get(token)
    if (!pending || pending.used) return
    pending.used = true
    pending.controller.abort()
    this.pending.delete(token)
    this.expiredTokens.add(token)
    this.timers.clearTimeout(pending.timeoutHandle)
    await this.appendState(pending.conversationId, 'tool', 'cancelled', { tool: { type: 'tool_cancelled', toolCall: persistedToolCall(pending.toolCall), secretsRedacted: true } })
  }

  private async callProvider(
    messages: LightweightProviderMessage[],
    parentSignal: AbortSignal,
    providerId: string | null,
    modelId: string | null
  ): Promise<LightweightProviderResponse> {
    assertSerializedBound(messages.slice(-this.limits.maxHistoryMessages), this.limits.maxPromptBytes, 'history_too_large')
    const controller = this.timeoutController(parentSignal, this.limits.providerCallTimeoutMs, 'provider_call_timeout')
    try {
      const response = await this.options.provider.complete({
        messages: messages.slice(-this.limits.maxHistoryMessages),
        tools: this.options.availableTools,
        maxToolCalls: this.limits.maxToolsPerIteration,
        providerId,
        modelId,
        signal: controller.signal
      })
      assertSerializedBound(response, this.limits.maxProviderResponseBytes, 'provider_response_too_large')
      return response
    } finally {
      controller.abort()
    }
  }

  private validateToolCall(toolCall: LightweightToolCall, seen: Set<string>): void {
    if (seen.has(toolCall.id)) throw new LightweightOrchestratorError('duplicate_tool_call_id')
    seen.add(toolCall.id)
    this.toolInfo(toolCall)
    assertSerializedBound(toolCall.arguments, this.limits.maxArgsBytes, 'tool_arguments_too_large')
  }

  private toolInfo(toolCall: LightweightToolCall) {
    const matches = this.options.availableTools.filter((tool) =>
      tool.name === toolCall.toolName ||
      tool.local_name === toolCall.toolName ||
      tool.global_tool_id === toolCall.toolName
    )
    if (matches.length !== 1) throw new LightweightOrchestratorError(matches.length === 0 ? 'unknown_tool_id' : 'ambiguous_tool_route')
    const tool = matches[0]!
    if (toolCall.route === 'local' && tool.execution_location !== 'local') {
      throw new LightweightOrchestratorError('python_only_tool_not_local')
    }
    if (toolCall.route === 'remote' && tool.execution_location !== 'remote') {
      throw new LightweightOrchestratorError('local_tool_not_remote')
    }
    return tool
  }

  private async ensureConversation(conversationId: string): Promise<void> {
    const now = this.nowMs()
    const existing = (await this.options.localData.conversations.listConversations())
      .find((conversation) => conversation.id === conversationId)
    if (existing) {
      if (
        existing.profileId !== this.options.scope.profileId
        || existing.localNodeId !== this.options.scope.localNodeId
      ) {
        throw new LightweightOrchestratorError('conversation_scope_mismatch')
      }
      await this.options.localData.conversations.upsertConversation({
        ...existing,
        updatedAtMs: Math.max(existing.updatedAtMs, now)
      })
      return
    }
    const record: ConversationRecord = {
      id: conversationId,
      profileId: this.options.scope.profileId,
      localNodeId: this.options.scope.localNodeId,
      titleEnvelope: null,
      createdAtMs: now,
      updatedAtMs: now,
      archivedAtMs: null
    }
    await this.options.localData.conversations.upsertConversation(record)
  }

  private async loadConversationHistory(conversationId: string): Promise<LightweightProviderMessage[]> {
    const records = await this.options.localData.conversations.listMessages(conversationId)
    const historyLimit = Math.max(0, this.limits.maxHistoryMessages - 1)
    if (historyLimit === 0) return []
    const candidates = records
      .filter((record) => record.status === 'complete' && record.role !== 'tool' && record.contentEnvelope !== null)
      .slice(-historyLimit)
    const messages: LightweightProviderMessage[] = []
    for (const record of candidates) {
      const envelope = record.contentEnvelope
      if (!envelope) continue
      const crypto = this.options.localDataCrypto
      if (!crypto) throw new LightweightOrchestratorError('history_decrypt_unavailable')
      try {
        const plaintext = await crypto.decrypt(
          envelope,
          buildEnvelopeAad({
            table: 'aurora_messages',
            recordId: record.id,
            field: 'content_envelope_json',
            profileId: this.options.scope.profileId,
            localNodeId: this.options.scope.localNodeId
          })
        )
        const content = new TextDecoder('utf-8', { fatal: true }).decode(plaintext)
        assertTextBound(content, this.limits.maxPromptBytes, 'history_message_too_large')
        messages.push({ role: record.role, content })
      } catch (error) {
        if (error instanceof LightweightOrchestratorError) throw error
        throw new LightweightOrchestratorError('history_decrypt_failed')
      }
    }
    assertSerializedBound(messages, this.limits.maxProviderRequestBytes, 'history_too_large')
    return messages
  }

  private async appendState(
    conversationId: string,
    role: ConversationMessageRecord['role'],
    status: ConversationMessageRecord['status'],
    persisted: { readonly content?: string | null; readonly tool?: unknown } = {}
  ): Promise<void> {
    const messages = await this.options.localData.conversations.listMessages(conversationId)
    await this.options.localData.conversations.appendMessage(await this.messageRecord(conversationId, nextSequence(messages), role, status, persisted))
  }

  private async messageRecord(
    conversationId: string,
    sequence: number,
    role: ConversationMessageRecord['role'],
    status: ConversationMessageRecord['status'],
    persisted: { readonly content?: string | null; readonly tool?: unknown }
  ): Promise<ConversationMessageRecord> {
    const id = `lw-msg-${this.ids()}`
    return {
      id,
      conversationId,
      sequence,
      role,
      contentEnvelope: await this.encryptMessageField(id, 'content_envelope_json', persisted.content ?? null),
      toolEnvelope: await this.encryptMessageField(id, 'tool_envelope_json', persisted.tool === undefined ? null : stableJson(persisted.tool)),
      status,
      createdAtMs: this.nowMs()
    }
  }

  private async encryptMessageField(
    messageId: string,
    field: 'content_envelope_json' | 'tool_envelope_json',
    plaintext: string | null
  ): Promise<EncryptedDataEnvelopeV1 | null> {
    if (plaintext === null) return null
    const crypto = this.options.localDataCrypto
    if (crypto === undefined) return null
    return await crypto.encrypt(
      'local-structured-data',
      new TextEncoder().encode(plaintext),
      buildEnvelopeAad({
        table: 'aurora_messages',
        recordId: messageId,
        field,
        profileId: this.options.scope.profileId,
        localNodeId: this.options.scope.localNodeId
      })
    )
  }

  private turnController(signal: AbortSignal | undefined): AbortController {
    return this.timeoutController(signal, this.limits.turnTimeoutMs, 'turn_timeout')
  }

  private timeoutController(parentSignal: AbortSignal | undefined, ms: number, reason: string): AbortController {
    const controller = new AbortController()
    const abort = () => controller.abort(new DOMException(reason, 'AbortError'))
    const handle = this.timers.setTimeout(abort, ms)
    if (parentSignal?.aborted === true) abort()
    else parentSignal?.addEventListener('abort', abort, { once: true })
    controller.signal.addEventListener('abort', () => {
      this.timers.clearTimeout(handle)
      parentSignal?.removeEventListener('abort', abort)
    }, { once: true })
    return controller
  }
}

export function createLightweightOrchestrator(options: LightweightOrchestratorOptions): LightweightOrchestrator {
  return new LightweightOrchestrator(options)
}

function validateScope(scope: LocalDataScope): void {
  if (!scope.profileId || !scope.localNodeId) throw new LightweightOrchestratorError('invalid_scope')
}

function validateTools(tools: LightweightOrchestratorOptions['availableTools'], limits: ReturnType<typeof resolveLightweightOrchestratorLimits>): void {
  if (tools.length > limits.maxToolSchemas) throw new LightweightOrchestratorError('tool_schema_count_limit_exceeded')
  assertSerializedBound(tools.map((tool) => ({ name: tool.name, args_schema: tool.args_schema, schema: tool.schema })), limits.maxToolSchemasBytes, 'tool_schema_bytes_limit_exceeded')
  const ids = new Map<string, ToolingIdentityOwner>()
  for (const tool of tools) {
    const owner: ToolingIdentityOwner = {
      name: tool.name,
      localName: tool.local_name,
      globalToolId: tool.global_tool_id
    }
    for (const id of [tool.name, tool.local_name, tool.global_tool_id]) {
      if (!id || id === '*' || id.includes('..')) throw new LightweightOrchestratorError('unsafe_tool_metadata')
      const existing = ids.get(id)
      if (existing && !sameToolingIdentity(existing, owner)) throw new LightweightOrchestratorError('ambiguous_tool_route')
      ids.set(id, owner)
    }
    if (tool.execution_location === 'local' && pythonOnlyHint(tool)) {
      throw new LightweightOrchestratorError('python_only_tool_not_local')
    }
  }
}

interface ToolingIdentityOwner {
  readonly name: string
  readonly localName: string
  readonly globalToolId: string
}

function sameToolingIdentity(left: ToolingIdentityOwner, right: ToolingIdentityOwner): boolean {
  return left.name === right.name && left.localName === right.localName && left.globalToolId === right.globalToolId
}

function pythonOnlyHint(tool: LightweightOrchestratorOptions['availableTools'][number]): boolean {
  const haystack = [
    tool.name,
    tool.local_name,
    tool.global_tool_id,
    tool.provider_service_instance_id,
    tool.provenance?.source,
    tool.provenance?.provider_kind,
    ...tool.privacy_hints
  ].join(' ').toLowerCase()
  return [...PYTHON_ONLY_HINTS].some((hint) => haystack.includes(hint))
}

function routeSelector(toolCall: LightweightToolCall) {
  return toolCall.route === 'local'
    ? { execution_location: 'local' as const }
    : { execution_location: 'remote' as const }
}

function requiresApproval(prepared: ToolingPrepareExecutionResponse, tool: ToolingProjectionToolInfo): boolean {
  if (prepared.policy_decision.share === false) return false
  if (prepared.policy_decision.approval_required === true) {
    return prepared.policy_decision.reason === null
      || prepared.policy_decision.reason === undefined
      || prepared.policy_decision.reason === 'approval_token_required'
  }
  return tool.confirmation_required === true
}

function toolResultMessage(toolCall: LightweightToolCall, result: LightweightToolExecutionResponse): LightweightProviderMessage {
  return {
    role: 'tool',
    toolCallId: toolCall.id,
    name: toolCall.providerToolName ?? toolCall.toolName,
    content: JSON.stringify({
      ok: result.ok,
      status: result.status ?? null,
      data: result.ok ? result.data ?? null : null,
      error_code: result.ok ? null : result.error_code ?? 'tool_failed',
      secretsRedacted: true
    })
  }
}

function persistedToolCall(toolCall: LightweightToolCall): Record<string, unknown> {
  return {
    id: toolCall.id,
    toolName: toolCall.toolName,
    providerToolName: toolCall.providerToolName ?? null,
    route: toolCall.route,
    arguments: toolCall.arguments,
    resourceSelector: toolCall.resourceSelector ?? null,
    meshSelector: toolCall.meshSelector ?? null
  }
}

function persistedToolResult(toolCall: LightweightToolCall, result: LightweightToolExecutionResponse): Record<string, unknown> {
  return {
    type: 'tool_result',
    toolCall: persistedToolCall(toolCall),
    ok: result.ok,
    status: result.status ?? null,
    data: result.ok ? result.data ?? null : null,
    errorCode: result.ok ? null : result.error_code ?? 'tool_failed',
    correlationId: result.correlation_id ?? null,
    providerPeerId: result.provider_peer_id ?? null,
    globalToolId: result.global_tool_id ?? null,
    secretsRedacted: true
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(value) ?? 'null'
}

function nextSequence(messages: readonly ConversationMessageRecord[]): number {
  return messages.reduce((max, message) => Math.max(max, message.sequence + 1), 0)
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Lightweight assistant turn cancelled', 'AbortError')
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function globalTimerPort() {
  return {
    setTimeout(callback: () => void, ms: number) {
      return globalThis.setTimeout(callback, ms)
    },
    clearTimeout(handle: unknown) {
      globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)
    }
  }
}
