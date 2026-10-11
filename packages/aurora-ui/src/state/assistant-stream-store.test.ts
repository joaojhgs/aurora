import { describe, expect, it } from 'vitest'
import { defaultAssistantStreamScopeId, selectAssistantStreamingText, useAssistantStreamStore } from './assistant-stream-store'

const runtimeA = 'runtime-a'
const runtimeB = 'runtime-b'

describe('assistant stream state', () => {
  it('tracks lifecycle metadata and an in-flight text buffer', () => {
    useAssistantStreamStore.getState().reset()
    useAssistantStreamStore.getState().begin('message-1', { scopeId: defaultAssistantStreamScopeId })
    useAssistantStreamStore.getState().markStreaming({ scopeId: defaultAssistantStreamScopeId })
    useAssistantStreamStore.getState().append('Hello', { scopeId: defaultAssistantStreamScopeId })
    useAssistantStreamStore.getState().append(' Aurora', { scopeId: defaultAssistantStreamScopeId })
    expect(useAssistantStreamStore.getState()).toMatchObject({
      state: 'streaming',
      messageId: 'message-1',
      text: 'Hello Aurora',
      error: null,
    })
    useAssistantStreamStore.getState().reset()
  })

  it('keeps in-flight stream buffers isolated by runtime scope', () => {
    useAssistantStreamStore.getState().reset()

    useAssistantStreamStore.getState().begin('message-a', { scopeId: runtimeA })
    useAssistantStreamStore.getState().markStreaming({ scopeId: runtimeA })
    useAssistantStreamStore.getState().append('A-only', { scopeId: runtimeA })

    useAssistantStreamStore.getState().activateScope(runtimeB)
    expect(useAssistantStreamStore.getState()).toMatchObject({
      state: 'idle',
      messageId: null,
      text: '',
      error: null,
    })
    expect(selectAssistantStreamingText('message-a', runtimeB)(useAssistantStreamStore.getState())).toBeNull()
    expect(selectAssistantStreamingText('message-a', runtimeA)(useAssistantStreamStore.getState())).toBe('A-only')

    useAssistantStreamStore.getState().begin('message-b', { scopeId: runtimeB })
    useAssistantStreamStore.getState().markStreaming({ scopeId: runtimeB })
    useAssistantStreamStore.getState().append('B-only', { scopeId: runtimeB })
    expect(selectAssistantStreamingText('message-b', runtimeB)(useAssistantStreamStore.getState())).toBe('B-only')

    useAssistantStreamStore.getState().clear('message-b', { scopeId: runtimeB })
    expect(selectAssistantStreamingText('message-b', runtimeB)(useAssistantStreamStore.getState())).toBeNull()
    expect(selectAssistantStreamingText('message-a', runtimeA)(useAssistantStreamStore.getState())).toBe('A-only')

    useAssistantStreamStore.getState().activateScope(runtimeA)
    expect(useAssistantStreamStore.getState()).toMatchObject({
      state: 'streaming',
      messageId: 'message-a',
      text: 'A-only',
      error: null,
    })

    useAssistantStreamStore.getState().reset(runtimeA)
    expect(selectAssistantStreamingText('message-a', runtimeA)(useAssistantStreamStore.getState())).toBeNull()
    expect(selectAssistantStreamingText('message-b', runtimeB)(useAssistantStreamStore.getState())).toBeNull()

    useAssistantStreamStore.getState().reset()
  })
})
