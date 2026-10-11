// @vitest-environment jsdom
import { act, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuroraClient, MockAuroraTransport } from '@aurora/client'

import type { AssistantExecutionOption, AssistantSessionSnapshot, AssistantStreamState } from './assistant-view'
import { useAssistantSessionActions, type AssistantSessionActions } from './use-assistant-session-actions'
import type { RouteAvailability } from './shell-data'

const roots: Root[] = []

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount()
  document.body.innerHTML = ''
})

describe('useAssistantSessionActions', () => {
  it.each([
    { latestAssistantStatus: 'sent' as const, expectedAction: 'send' as const },
    { latestAssistantStatus: 'failed' as const, expectedAction: 'retry' as const },
  ])('selects $expectedAction when the latest assistant turn is $latestAssistantStatus', async ({
    latestAssistantStatus,
    expectedAction,
  }) => {
    let actions: AssistantSessionActions | undefined
    const startAssistantTurn = vi.fn(async () => true)
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)

    function Harness() {
      const [session, setSession] = useState<AssistantSessionSnapshot>({
        sessionId: 'same-conversation',
        messages: [
          {
            id: 'older-user',
            role: 'user',
            text: 'older request',
            createdAt: '2026-10-06T12:00:00.000Z',
            status: 'sent',
          },
          {
            id: 'older-failed-assistant',
            role: 'assistant',
            text: 'An older request failed.',
            createdAt: '2026-10-06T12:00:01.000Z',
            status: 'failed',
          },
          {
            id: 'newer-user',
            role: 'user',
            text: 'new successful request',
            createdAt: '2026-10-06T12:01:00.000Z',
            status: 'sent',
          },
          {
            id: 'newer-complete-assistant',
            role: 'assistant',
            text: 'The newer response completed.',
            createdAt: '2026-10-06T12:01:01.000Z',
            status: latestAssistantStatus,
          },
        ],
      })
      const [streamState, setStreamState] = useState<AssistantStreamState>({ status: 'idle', lastEventId: null, message: null })
      const [text, setText] = useState('')
      actions = useAssistantSessionActions({
        client: new AuroraClient({ transport: MockAuroraTransport.empty() }),
        route: { disabled: false } as RouteAvailability,
        cancellationRoute: undefined,
        selectedExecution: {
          id: 'home',
          mode: 'dispatch',
          runner: 'aurora-route',
          label: 'Home Aurora',
          description: '',
          routePolicy: {},
          executionPeerId: null,
          transportHost: false,
          modelCatalogHost: 'connected-device',
        } satisfies AssistantExecutionOption,
        localOrchestrator: null,
        session,
        setSession,
        supportsPersistedSessions: false,
        usesLocalConversationHistory: false,
        sessionIndexLoading: false,
        setSessionIndexLoading: () => undefined,
        hasContextUpload: false,
        attachmentsLength: 0,
        ingestPendingAttachments: async () => 'ready',
        activeAssistantPendingId: null,
        voiceCaptureStatus: 'idle',
        voiceResponsePendingId: null,
        lastPrompt: 'new successful request',
        streamState,
        setStreamState,
        setLastError: () => undefined,
        startAssistantTurn,
        activePendingIdRef: useRef<string | null>(null),
        cancelledPendingIdsRef: useRef(new Set<string>()),
        abortRef: useRef<AbortController | null>(null),
        assistantStreamScopeId: 'same-conversation',
        assistantStreamScope: { scopeId: 'same-conversation' },
        setActiveAssistantPendingId: () => undefined,
        usesNativeDesktopVoice: false,
        usesFocusedBrowserVoiceRuntime: false,
        browserVoiceOperationTokenRef: useRef(0),
        activeVoiceSessionRef: useRef<string | null>(null),
        ownedVoiceSessionIdsRef: useRef(new Set<string>()),
        setVoiceCaptureStatus: () => undefined,
        toggleLocalCapture: async () => undefined,
        cancelNativeDesktopVoice: async () => false,
        settleBrowserVoiceTurn: async () => ({ claimed: false, succeeded: false, current: false }),
        createPersistedChatSession: async () => null,
        resetConversationUi: () => undefined,
        setMobileHistoryOpen: () => undefined,
        textAreaRef: useRef<HTMLTextAreaElement | null>(null),
        text,
        setText,
        localConfirmationOrchestratorsRef: useRef(new Map()),
        productAssistantErrorCopy: (error) => error.message,
      })
      return null
    }

    await act(async () => {
      root.render(<Harness />)
      await Promise.resolve()
    })

    expect(actions?.primaryComposerAction).toBe(expectedAction)
    expect(actions?.primaryComposerLabel).toBe(expectedAction === 'send' ? 'Send' : 'Retry')
  })
})
