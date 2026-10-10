'use client'

import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'

export type AuroraAssistantStreamStatus = 'idle' | 'requested' | 'streaming' | 'completed' | 'error'
export type AssistantStreamScopeId = string

export interface AssistantStreamSnapshot {
  state: AuroraAssistantStreamStatus
  messageId: string | null
  text: string
  lastEventAt: number | null
  error: string | null
}

export interface AssistantStreamScopeOptions {
  scopeId?: AssistantStreamScopeId | undefined
}

export interface AssistantStreamStoreState extends AssistantStreamSnapshot {
  activeScopeId: AssistantStreamScopeId
  streams: Record<AssistantStreamScopeId, AssistantStreamSnapshot>
  activateScope: (scopeId: AssistantStreamScopeId) => void
  begin: (messageId: string, options?: AssistantStreamScopeOptions) => void
  append: (delta: string, options?: AssistantStreamScopeOptions) => void
  setText: (text: string, options?: AssistantStreamScopeOptions) => void
  markStreaming: (options?: AssistantStreamScopeOptions) => void
  complete: (options?: AssistantStreamScopeOptions) => void
  fail: (error: string, options?: AssistantStreamScopeOptions) => void
  clear: (messageId: string, options?: AssistantStreamScopeOptions) => void
  reset: (scopeId?: AssistantStreamScopeId) => void
}

export const defaultAssistantStreamScopeId = 'default'

const initialAssistantStreamSnapshot: AssistantStreamSnapshot = {
  state: 'idle',
  messageId: null,
  text: '',
  lastEventAt: null,
  error: null,
}

const assistantSnapshotForScope = (
  streams: Record<AssistantStreamScopeId, AssistantStreamSnapshot>,
  scopeId: AssistantStreamScopeId,
): AssistantStreamSnapshot => streams[scopeId] ?? initialAssistantStreamSnapshot

const assistantStateForScope = (
  scopeId: AssistantStreamScopeId,
  streams: Record<AssistantStreamScopeId, AssistantStreamSnapshot>,
): Pick<AssistantStreamStoreState, 'activeScopeId' | 'state' | 'messageId' | 'text' | 'lastEventAt' | 'error'> => ({
  activeScopeId: scopeId,
  ...assistantSnapshotForScope(streams, scopeId),
})

const updateScopedAssistantSnapshot = (
  current: AssistantStreamStoreState,
  options: AssistantStreamScopeOptions | undefined,
  update: (snapshot: AssistantStreamSnapshot) => AssistantStreamSnapshot,
): Partial<AssistantStreamStoreState> => {
  const scopeId = options?.scopeId ?? current.activeScopeId
  const nextSnapshot = update(assistantSnapshotForScope(current.streams, scopeId))
  const streams = {
    ...current.streams,
    [scopeId]: nextSnapshot,
  }

  if (scopeId !== current.activeScopeId) {
    return { streams }
  }

  return {
    streams,
    ...nextSnapshot,
  }
}

export const useAssistantStreamStore = create<AssistantStreamStoreState>()(
  subscribeWithSelector((set) => ({
    ...initialAssistantStreamSnapshot,
    activeScopeId: defaultAssistantStreamScopeId,
    streams: {
      [defaultAssistantStreamScopeId]: initialAssistantStreamSnapshot,
    },
    activateScope: (scopeId) => set((current) => assistantStateForScope(scopeId, current.streams)),
    begin: (messageId, options) => set((current) => updateScopedAssistantSnapshot(current, options, () => ({
      state: 'requested',
      messageId,
      text: '',
      lastEventAt: Date.now(),
      error: null,
    }))),
    append: (delta, options) => set((current) => updateScopedAssistantSnapshot(current, options, (snapshot) => ({
      ...snapshot,
      text: snapshot.text + delta,
      lastEventAt: Date.now(),
    }))),
    setText: (text, options) => set((current) => updateScopedAssistantSnapshot(current, options, (snapshot) => ({
      ...snapshot,
      text,
      lastEventAt: Date.now(),
    }))),
    markStreaming: (options) => set((current) => updateScopedAssistantSnapshot(current, options, (snapshot) => ({
      ...snapshot,
      state: 'streaming',
      lastEventAt: Date.now(),
      error: null,
    }))),
    complete: (options) => set((current) => updateScopedAssistantSnapshot(current, options, (snapshot) => ({
      ...snapshot,
      state: 'completed',
      lastEventAt: Date.now(),
      error: null,
    }))),
    fail: (error, options) => set((current) => updateScopedAssistantSnapshot(current, options, (snapshot) => ({
      ...snapshot,
      state: 'error',
      lastEventAt: Date.now(),
      error,
    }))),
    clear: (messageId, options) => set((current) => updateScopedAssistantSnapshot(current, options, (snapshot) => (
      snapshot.messageId === messageId ? initialAssistantStreamSnapshot : snapshot
    ))),
    reset: (scopeId) => set((current) => {
      if (!scopeId) {
        return {
          ...initialAssistantStreamSnapshot,
          activeScopeId: defaultAssistantStreamScopeId,
          streams: {
            [defaultAssistantStreamScopeId]: initialAssistantStreamSnapshot,
          },
        }
      }

      const streams = {
        ...current.streams,
        [scopeId]: initialAssistantStreamSnapshot,
      }

      if (scopeId !== current.activeScopeId) {
        return { streams }
      }

      return {
        streams,
        ...initialAssistantStreamSnapshot,
      }
    }),
  })),
)

export const selectAssistantStreamScope = (scopeId?: AssistantStreamScopeId) => (
  state: AssistantStreamStoreState,
): AssistantStreamSnapshot => assistantSnapshotForScope(state.streams, scopeId ?? state.activeScopeId)

export const selectAssistantStreamState = (state: AssistantStreamStoreState): AuroraAssistantStreamStatus => state.state

export const selectAssistantStreamingText = (messageId: string, scopeId?: AssistantStreamScopeId) => (
  state: AssistantStreamStoreState,
): string | null => {
  const snapshot = assistantSnapshotForScope(state.streams, scopeId ?? state.activeScopeId)
  return snapshot.messageId === messageId && snapshot.text.length > 0 ? snapshot.text : null
}
