// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  AuroraClient,
  DB_METHODS,
  ORCHESTRATOR_METHODS,
  createEventSubscription,
  type AuroraEventSubscription,
  type AuroraEvent,
  type AuroraStreamRequest,
  type AuroraTransport,
  type AuroraTransportRequest,
  type AuroraTransportResponse,
  type DBSessionRecord
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

describe('Assistant persisted sessions', () => {
  it('loads, activates, creates, and switches the session rail with the auth principal', async () => {
    const transport = new SessionTransport()
    const client = new AuroraClient({ transport })
    client.auth.setAuthenticated('user-a', ['DB.use', 'Orchestrator.use'])
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(<AssistantView client={client} route={assistantRoute()} />)
    })
    await waitUntil(() => container.textContent?.includes('Alpha message') === true)

    expect(container.textContent).toContain('First thread')
    expect(container.textContent).toContain('Second thread')
    expect(container.textContent).not.toContain('Other principal thread')
    expect(conversationTitles(container)).toEqual(['First thread', 'Second thread'])

    const secondThread = findButtonContaining(container, 'Second thread')
    expect(secondThread).not.toBeNull()
    await act(async () => {
      secondThread!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await waitUntil(() => container.textContent?.includes('Beta message') === true)

    expect(conversationTitles(container)).toEqual(['First thread', 'Second thread'])
    expect(transport.calls).toContainEqual({
      method: DB_METHODS.getSession,
      payload: { session_id: 'chat-a-2', activate: true }
    })

    const newConversation = findButtonContaining(container, 'New conversation')
    expect(newConversation).not.toBeNull()
    await act(async () => {
      newConversation!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await waitUntil(() => transport.calls.some((call) => call.method === DB_METHODS.createSession))
    expect(transport.calls).toContainEqual({
      method: DB_METHODS.createSession,
      payload: { type: 'chat' }
    })
    expect(transport.calls.filter((call) => call.method === 'Orchestrator.GetModelCatalog'))
      .toEqual([{
        method: 'Orchestrator.GetModelCatalog',
        payload: {
          include_unavailable: true,
          include_operations: false,
          include_remote: true
        }
      }])

    transport.principalId = 'user-b'
    await act(async () => {
      client.auth.setAuthenticated('user-b', ['DB.use', 'Orchestrator.use'])
    })
    await waitUntil(() => container.textContent?.includes('Other principal message') === true)

    expect(container.textContent).toContain('Other principal thread')
    expect(container.textContent).not.toContain('First thread')
    expect(container.textContent).not.toContain('Beta message')
  })

  it('opens the same real session list from the mobile conversations sheet', async () => {
    const transport = new SessionTransport()
    const client = new AuroraClient({ transport })
    client.auth.setAuthenticated('user-a', ['DB.use', 'Orchestrator.use'])
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(<AssistantView client={client} route={assistantRoute()} />)
    })
    await waitUntil(() => container.textContent?.includes('Alpha message') === true)

    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Open conversations"]')
    expect(trigger).not.toBeNull()
    await act(async () => {
      trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
    await waitUntil(() => document.body.querySelector('[data-slot="sheet-content"]') !== null)

    const sheet = document.body.querySelector<HTMLElement>('[data-slot="sheet-content"]')
    expect(sheet?.textContent).toContain('Conversations')
    expect(sheet?.textContent).toContain('First thread')
    expect(sheet?.textContent).toContain('Second thread')
    expect(sheet?.querySelector('[data-slot="sheet-title"]')).not.toBeNull()

    const secondThread = [...(sheet?.querySelectorAll<HTMLButtonElement>('.aui-thread-row-button') ?? [])]
      .find((button) => button.textContent?.includes('Second thread'))
    expect(secondThread).toBeDefined()
    await act(async () => {
      secondThread!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
    await waitUntil(() => container.textContent?.includes('Beta message') === true)
    await waitUntil(() => document.body.querySelector('[data-slot="sheet-content"]') === null)
  })
})

class SessionTransport implements AuroraTransport {
  readonly kind = 'http'
  principalId = 'user-a'
  readonly calls: Array<{ method: string; payload: unknown }> = []
  private createdCount = 0
  private readonly sessions: Record<string, DBSessionRecord[]> = {
    'user-a': [
      sessionRecord('chat-a-1', 'user-a', 'First thread', '2026-07-11T12:02:00+00:00', 1),
      sessionRecord('chat-a-2', 'user-a', 'Second thread', '2026-07-11T12:01:00+00:00', 1)
    ],
    'user-b': [
      sessionRecord('chat-b-1', 'user-b', 'Other principal thread', '2026-07-11T12:03:00+00:00', 1)
    ]
  }

  async request<TData = unknown, TPayload = unknown>(
    request: AuroraTransportRequest<TPayload>
  ): Promise<AuroraTransportResponse<TData>> {
    this.calls.push({ method: request.method, payload: request.payload })
    const principalSessions = this.sessions[this.principalId] ?? []
    let data: unknown
    switch (request.method) {
      case DB_METHODS.listSessions:
        data = {
          sessions: principalSessions,
          active_session_id: principalSessions[0]?.id ?? null,
          total: principalSessions.length
        }
        break
      case DB_METHODS.getSession: {
        const sessionId = (request.payload as { session_id: string }).session_id
        const session = principalSessions.find((candidate) => candidate.id === sessionId)
        if (!session) throw new Error('session not found for principal')
        data = {
          session,
          messages: [persistedMessage(session.id)]
        }
        break
      }
      case DB_METHODS.createSession: {
        this.createdCount += 1
        const session = sessionRecord(
          `created-${this.principalId}-${this.createdCount}`,
          this.principalId,
          null,
          '2026-07-11T12:04:00+00:00',
          0
        )
        principalSessions.unshift(session)
        data = { session }
        break
      }
      case 'Orchestrator.GetModelRuntime':
        data = { provider: null, providers: [] }
        break
      case 'Orchestrator.GetModelCatalog':
        data = {
          generated_at: '2026-08-01T00:00:00Z',
          selected_provider_id: null,
          providers: [],
          provider_index: {},
          unavailable: [],
          internal_only: [],
          secrets_redacted: true
        }
        break
      default:
        throw new Error(`unexpected method ${request.method}`)
    }
    return { data: data as TData }
  }

  subscribe<TEventPayload = unknown, TPayload = unknown>(
    _request: AuroraStreamRequest<TPayload>
  ): AuroraEventSubscription<TEventPayload> {
    return createEventSubscription(emptyEvents<TEventPayload>())
  }
}

async function* emptyEvents<T>(): AsyncIterable<AuroraEvent<T>> {
  return
}

function sessionRecord(
  id: string,
  principalId: string,
  title: string | null,
  lastActiveAt: string,
  messageCount: number
): DBSessionRecord {
  return {
    id,
    principal_id: principalId,
    type: 'chat',
    title,
    created_at: '2026-07-11T12:00:00+00:00',
    updated_at: lastActiveAt,
    last_active_at: lastActiveAt,
    message_count: messageCount
  }
}

function persistedMessage(sessionId: string): Record<string, unknown> {
  const content = sessionId === 'chat-a-1'
    ? 'Alpha message'
    : sessionId === 'chat-a-2'
      ? 'Beta message'
      : 'Other principal message'
  return {
    id: `message-${sessionId}`,
    role: 'user',
    content,
    message_type: 'USER_TEXT',
    timestamp: '2026-07-11T12:00:00+00:00',
    session_id: sessionId,
    metadata: {},
    source_type: 'Text'
  }
}

function assistantRoute(): RouteAvailability {
  const item = auroraNavSections
    .flatMap((section) => section.items)
    .find((candidate) => candidate.id === 'assistant')
  if (!item) throw new Error('assistant route missing')
  return {
    item: navItemSnapshot(item),
    state: 'available-local',
    explanation: 'Assistant route available from the local server.',
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

function findButtonContaining(container: HTMLElement, text: string): HTMLButtonElement | null {
  return Array.from(container.querySelectorAll('button'))
    .find((button) => button.textContent?.includes(text)) ?? null
}

function conversationTitles(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>('[aria-label="Assistant conversation list"] .aui-thread-row-button strong')
  ).map((title) => title.textContent ?? '')
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for persisted session UI state.')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
  }
}
