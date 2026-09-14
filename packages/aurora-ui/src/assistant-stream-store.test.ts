import { afterEach, describe, expect, it, vi } from 'vitest'

import { AssistantStreamTextStore } from './assistant-stream-store'

describe('AssistantStreamTextStore', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('notifies only the active message and clears its snapshot', () => {
    vi.useFakeTimers()
    const store = new AssistantStreamTextStore()
    const firstListener = { calls: 0 }
    const secondListener = { calls: 0 }
    store.begin('first')
    store.begin('second')
    store.subscribe('first', () => { firstListener.calls += 1 })
    store.subscribe('second', () => { secondListener.calls += 1 })

    store.append('first', 'hello')
    vi.advanceTimersByTime(50)

    expect(store.getSnapshot('first')).toBe('hello')
    expect(store.getSnapshot('second')).toBeNull()
    expect(firstListener.calls).toBe(1)
    expect(secondListener.calls).toBe(0)

    store.clear('first')
    expect(store.getSnapshot('first')).toBeNull()
    expect(firstListener.calls).toBe(2)
  })

  it('coalesces burst deltas while retaining the latest snapshot and revision', () => {
    vi.useFakeTimers()
    const store = new AssistantStreamTextStore()
    let calls = 0
    store.begin('active')
    store.subscribe('active', () => { calls += 1 })

    store.append('active', 'one')
    store.append('active', 'two')

    expect(store.getSnapshot('active')).toBe('onetwo')
    expect(store.getRevision('active')).toBe(2)
    expect(calls).toBe(0)

    vi.advanceTimersByTime(49)
    expect(calls).toBe(0)
    vi.advanceTimersByTime(1)
    expect(calls).toBe(1)
  })

  it('cancels a pending notification when the stream reaches a terminal state', () => {
    vi.useFakeTimers()
    const store = new AssistantStreamTextStore()
    let calls = 0
    store.begin('active')
    store.subscribe('active', () => { calls += 1 })

    store.append('active', 'partial')
    store.clear('active')
    vi.advanceTimersByTime(100)

    expect(calls).toBe(1)
    expect(store.getSnapshot('active')).toBeNull()
  })
})
