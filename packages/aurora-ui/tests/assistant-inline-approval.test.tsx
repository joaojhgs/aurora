// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  AuroraClient as Aurora,
  MockAuroraTransport,
  ORCHESTRATOR_METHODS,
  type AuroraTransportRequest
} from '@aurora/client'
import { AssistantView } from '../src/assistant-view'
import { auroraNavSections, navItemSnapshot } from '../src/nav'
import type { RouteAvailability } from '../src/shell-data'

const roots: Root[] = []

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount()
  document.body.innerHTML = ''
})

describe('Assistant inline tool approval', () => {
  it('resumes the exact pending tool call through Orchestrator with the selected grant scope', async () => {
    const calls: Array<{ method: string; payload: unknown }> = []
    const transport = new MockAuroraTransport({ fixtures: false })
      .register(ORCHESTRATOR_METHODS.resumeToolApproval, (request: AuroraTransportRequest) => {
        calls.push({ method: request.method, payload: request.payload })
        return {
          ok: true,
          status: 'executed',
          pending: {
            pending_id: 'thread-1:tool-call-approval',
            approval_request_id: 'approval-123',
            status: 'executed',
            run_id: 'run-1',
            thread_id: 'thread-1',
            message_id: 'assistant-inline-approval-message',
            tool_call_id: 'tool-call-approval',
            tool_name: 'mesh_peer.delete_file',
            created_at: 1
          },
          tool_result: { ok: true, status: 'success', output: 'deleted' },
          assistant_text: 'The approved tool completed successfully.',
          correlation_id: 'corr-inline-approval'
        }
      })
    const client = new Aurora({ transport })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(
        <AssistantView
          client={client}
          route={assistantRoute()}
          initialSession={{
            sessionId: 'different-active-ui-session',
            messages: [
              {
                id: 'assistant-inline-approval-message',
                role: 'assistant',
                text: 'Aurora paused for a tool approval decision.',
                createdAt: '2026-07-05T00:00:00Z',
                status: 'streaming',
                toolCalls: [
                  {
                    id: 'tool-call-approval',
                    name: 'mesh_peer.delete_file',
                    sessionId: 'assistant-inline-approval',
                    status: 'requires_action',
                    riskClass: 'backend-evaluated',
                    target: 'raspi-lab',
                    dataLeavesDevice: false,
                    summary: 'Tool requires operator approval before execution.',
                    auditId: 'corr-inline-approval',
                    payloadPreview: { path: '/tmp/example.txt' },
                    pendingId: 'thread-1:tool-call-approval',
                    approvalRequestId: 'approval-123',
                    approvalExpiresAt: 1_783_200_000
                  }
                ]
              }
            ]
          }}
        />
      )
      await Promise.resolve()
    })

    const sessionButton = findButtonByText(container, 'Session')
    expect(sessionButton).not.toBeNull()
    await act(async () => {
      sessionButton!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(calls).toEqual([
      {
        method: ORCHESTRATOR_METHODS.resumeToolApproval,
        payload: {
          approve: true,
          grant_scope: 'session',
          session_id: 'assistant-inline-approval',
          approver_principal_id: 'aurora-ui',
          reason: 'Approved mesh_peer.delete_file from assistant inline card.',
          pending_id: 'thread-1:tool-call-approval',
          approval_request_id: 'approval-123'
        }
      }
    ])
    expect(container.textContent).toContain('The approved tool completed successfully.')
    expect(container.textContent).toContain('Aurora finished this action.')
  })

  it('binds a fresh streamed turn and its approval resume to the same session', async () => {
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
    let releaseTurn: (() => void) | null = null
    const approvalResolved = new Promise<void>((resolve) => {
      releaseTurn = resolve
    })
    const transport = MockAuroraTransport.empty()
      .stream('assistant', async function* (request) {
        const payload = request.payload as { session_id?: unknown; request_id?: unknown }
        const sessionId = typeof payload.session_id === 'string' ? payload.session_id : null
        const requestId = typeof payload.request_id === 'string' ? payload.request_id : null
        yield {
          id: 'tool-approval-fresh-session',
          kind: 'tool.requires_action',
          payload: {
            session_id: sessionId,
            request_id: requestId,
            tool: {
              tool_call_id: 'tool-call-fresh-session',
              tool_name: 'list_scheduled_tasks_tool',
              status: 'requires_action',
              summary: 'Tool requires operator approval before execution.',
              pending_id: `${sessionId}:tool-call-fresh-session`,
              approval_request_id: 'approval-fresh-session'
            }
          },
          correlation_id: request.correlationId
        }
        await approvalResolved
        yield {
          id: 'assistant-completed-fresh-session',
          kind: 'assistant.completed',
          payload: {
            text: 'There are no scheduled tasks.',
            session_id: sessionId,
            request_id: requestId
          },
          correlation_id: request.correlationId
        }
      })
      .register(ORCHESTRATOR_METHODS.externalUserInput, async (request: AuroraTransportRequest) => {
        const payload = request.payload as Record<string, unknown>
        calls.push({ method: request.method, payload })
        await approvalResolved
        return {
          text: 'There are no scheduled tasks.',
          session_id: payload.session_id,
          request_id: payload.request_id,
          correlation_id: payload.correlation_id
        }
      })
      .register(ORCHESTRATOR_METHODS.resumeToolApproval, (request: AuroraTransportRequest) => {
        const payload = request.payload as Record<string, unknown>
        calls.push({ method: request.method, payload })
        releaseTurn?.()
        return {
          ok: true,
          status: 'executed',
          tool_result: { ok: true, status: 'success', output: [] },
          assistant_text: 'There are no scheduled tasks.',
          correlation_id: payload.correlation_id ?? null
        }
      })
    const client = new Aurora({ transport })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(
        <AssistantView
          client={client}
          route={assistantRoute()}
          initialSession={{ sessionId: null, messages: [] }}
        />
      )
      await Promise.resolve()
    })

    const composer = container.querySelector('textarea')
    expect(composer).not.toBeNull()
    await act(async () => {
      setNativeValue(composer!, 'list all schedules')
      composer!.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })
    const sendButton = findButtonByText(container, 'Send')
    expect(sendButton).not.toBeNull()
    expect(sendButton!.disabled).toBe(false)
    await act(async () => {
      sendButton!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
    await waitUntil(() => container.textContent?.includes('Needs approval') === true)

    expect(countText(container.textContent ?? '', 'Aurora paused for a tool approval decision.')).toBe(1)
    const approveButton = findButtonByText(container, 'Approve once')
    expect(approveButton).not.toBeNull()
    await act(async () => {
      approveButton!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
    await waitUntil(() => calls.some((call) => call.method === ORCHESTRATOR_METHODS.resumeToolApproval))

    const initialCall = calls.find((call) => call.method === ORCHESTRATOR_METHODS.externalUserInput)
    const resumeCall = calls.find((call) => call.method === ORCHESTRATOR_METHODS.resumeToolApproval)
    expect(initialCall?.payload.session_id).toEqual(expect.any(String))
    expect(initialCall?.payload.session_id).toBe(initialCall?.payload.request_id)
    expect(resumeCall?.payload.session_id).toBe(initialCall?.payload.session_id)
  })
})

function assistantRoute(): RouteAvailability {
  const item = auroraNavSections.flatMap((section) => section.items).find((candidate) => candidate.id === 'assistant')
  if (!item) throw new Error('assistant route missing')
  return {
    item: navItemSnapshot(item),
    state: 'available-local',
    explanation: 'Assistant route available from mock status.',
    providerLabel: `local / ${ORCHESTRATOR_METHODS.externalUserInput}`,
    blockers: [],
    repairActions: [],
    candidateProviders: [],
    evidenceSources: [ORCHESTRATOR_METHODS.externalUserInput],
    selectorRequired: false,
    approvalRequired: false,
    routeable: true,
    disabled: false,
    requiresAdminAction: false
  }
}

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement | null {
  return Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.trim() === text) ?? null
}

function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = Object.getPrototypeOf(element) as HTMLElement
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value')
  descriptor?.set?.call(element, value)
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for assistant approval UI state.')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
  }
}

function countText(value: string, needle: string): number {
  return value.split(needle).length - 1
}
