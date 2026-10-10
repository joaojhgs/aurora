'use client'

import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { AuroraClient, AuroraError } from '@aurora/client'
import type { LightweightOrchestrator } from '@aurora/client/lightweight-orchestrator'
import type {
  AssistantApprovalGrantScope,
  AssistantSessionSnapshot,
  AssistantToolCallCard,
} from './assistant-session-persistence'
import type { AssistantStreamState } from './assistant-view'

export interface ResolveAssistantToolApprovalInput {
  readonly client: AuroraClient
  readonly session: AssistantSessionSnapshot
  readonly setSession: Dispatch<SetStateAction<AssistantSessionSnapshot>>
  readonly setStreamState: Dispatch<SetStateAction<AssistantStreamState>>
  readonly setLastError: (message: string | null) => void
  readonly localConfirmationOrchestratorsRef: MutableRefObject<Map<string, LightweightOrchestrator>>
  readonly formatError: (error: AuroraError | Error) => string
  readonly tool: AssistantToolCallCard
  readonly approve: boolean
  readonly grantScope: AssistantApprovalGrantScope
}

export async function resolveAssistantToolApprovalAction({
  client,
  session,
  setSession,
  setStreamState,
  setLastError,
  localConfirmationOrchestratorsRef,
  formatError,
  tool,
  approve,
  grantScope,
}: ResolveAssistantToolApprovalInput): Promise<void> {
  if (!tool.pendingId && !tool.approvalRequestId && !tool.localConfirmationToken) {
    setLastError('This approval needs to be refreshed before Aurora can continue.')
    return
  }
  setLastError(null)
  setSession((current) => ({
    ...current,
    messages: current.messages.map((message) => ({
      ...message,
      toolCalls: message.toolCalls?.map((candidate) =>
        candidate.id === tool.id ? { ...candidate, resolving: true } : candidate
      )
    }))
  }))
  try {
    if (tool.localConfirmationToken) {
      const orchestrator = localConfirmationOrchestratorsRef.current.get(tool.localConfirmationToken)
      if (!orchestrator) throw new Error('This on-device approval has expired.')
      const result = await orchestrator.resumeConfirmation({
        token: tool.localConfirmationToken,
        decision: approve ? 'approve' : 'deny',
        grantScope
      })
      localConfirmationOrchestratorsRef.current.delete(tool.localConfirmationToken)
      const assistantText = result.assistantText.trim()
      setSession((current) => ({
        sessionId: result.conversationId,
        messages: current.messages.map((message) => {
          if (!message.toolCalls?.some((candidate) => candidate.id === tool.id)) return message
          return {
            ...message,
            text: assistantText || (approve
              ? 'Aurora finished the approved action.'
              : 'Aurora stopped this action because it was denied.'),
            status: 'sent',
            toolCalls: message.toolCalls.map((candidate) =>
              candidate.id === tool.id
                ? {
                    ...candidate,
                    resolving: false,
                    status: approve && result.status === 'completed' ? 'completed' : 'failed',
                    summary: approve && result.status === 'completed'
                      ? 'Approved and completed on this device.'
                      : 'Denied on this device.',
                    error: approve && result.status === 'completed' ? null : 'approval_denied'
                  }
                : candidate
            )
          }
        })
      }))
      setStreamState({
        status: 'idle',
        lastEventId: null,
        message: approve && result.status === 'completed'
          ? 'Aurora finished the approved action.'
          : 'The action was denied.'
      })
      return
    }
    const request: Parameters<typeof client.assistant.resumeToolApproval>[0] = {
      approve,
      grant_scope: grantScope,
      session_id: tool.sessionId ?? session.sessionId,
      approver_principal_id: 'aurora-ui',
      reason: approve ? `Approved ${tool.name} from assistant inline card.` : `Denied ${tool.name} from assistant inline card.`
    }
    if (tool.pendingId !== undefined) request.pending_id = tool.pendingId
    if (tool.approvalRequestId !== undefined) request.approval_request_id = tool.approvalRequestId
    const result = await client.assistant.resumeToolApproval(request)
    if (!result.ok) throw result.error
    const response = result.data
    if (!response.ok) throw new Error(response.error ?? 'Tool approval resume failed.')
    const assistantText = typeof response.assistant_text === 'string' ? response.assistant_text : ''
    setSession((current) => ({
      ...current,
      messages: current.messages.map((message) => {
        if (!message.toolCalls?.some((candidate) => candidate.id === tool.id)) return message
        return {
          ...message,
          text: assistantText.trim()
            ? assistantText
            : approve
              ? message.text
              : 'Aurora will continue without this tool because it was denied.',
          status: approve ? 'sent' : 'failed',
          toolCalls: message.toolCalls.map((candidate) =>
            candidate.id === tool.id
              ? {
                  ...candidate,
                  resolving: false,
                  status: approve ? 'completed' : 'failed',
                  summary: approve
                    ? 'Approved inline and executed by Aurora.'
                    : 'Denied inline by the operator.',
                  error: approve ? null : 'approval_denied',
                  resultPreview: approve ? response.tool_result ?? candidate.resultPreview ?? null : candidate.resultPreview ?? null
                }
              : candidate
          )
        }
      })
    }))
  } catch (error) {
    if (tool.localConfirmationToken) {
      localConfirmationOrchestratorsRef.current.delete(tool.localConfirmationToken)
    }
    const message = formatError(error instanceof Error ? error : new Error(String(error)))
    setLastError(message)
    setSession((current) => ({
      ...current,
      messages: current.messages.map((chatMessage) => ({
        ...chatMessage,
        toolCalls: chatMessage.toolCalls?.map((candidate) =>
          candidate.id === tool.id
            ? { ...candidate, resolving: false, status: 'failed', error: message }
            : candidate
        )
      }))
    }))
  }
}
