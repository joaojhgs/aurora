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
            sessionId: 'assistant-inline-approval',
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
    expect(container.textContent).toContain('Approved inline and executed by Aurora.')
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
