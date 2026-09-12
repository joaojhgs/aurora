import { describe, expect, it } from 'vitest'

import { AssistantStreamTextStore } from './assistant-stream-store'

describe('AssistantStreamTextStore', () => {
  it('notifies only the active message and clears its snapshot', () => {
    const store = new AssistantStreamTextStore()
    const firstListener = { calls: 0 }
    const secondListener = { calls: 0 }
    store.begin('first')
    store.begin('second')
    store.subscribe('first', () => { firstListener.calls += 1 })
    store.subscribe('second', () => { secondListener.calls += 1 })

    store.append('first', 'hello')

    expect(store.getSnapshot('first')).toBe('hello')
    expect(store.getSnapshot('second')).toBeNull()
    expect(firstListener.calls).toBe(1)
    expect(secondListener.calls).toBe(0)

    store.clear('first')
    expect(store.getSnapshot('first')).toBeNull()
    expect(firstListener.calls).toBe(2)
  })
})
