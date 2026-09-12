import { describe, expect, it, vi } from 'vitest'

import {
  ensureAuroraReactProfiler,
  recordAuroraReactProfilerSample,
} from './react-profiler'

describe('Aurora React profiler bridge', () => {
  it('keeps production profiling opt-in while exposing bounded React commit samples', () => {
    vi.stubGlobal('window', {})
    const handle = ensureAuroraReactProfiler()
    expect(handle).not.toBeNull()
    expect(handle?.enabled).toBe(false)

    handle!.enabled = true
    recordAuroraReactProfilerSample({
      id: 'assistant-message:pending',
      phase: 'update',
      actualDuration: 1.25,
      baseDuration: 4.5,
      startTime: 10,
      commitTime: 12,
      streamMessageId: 'pending',
      streamRevision: 4
    })

    expect(handle!.samples).toEqual([
      expect.objectContaining({
        id: 'assistant-message:pending',
        phase: 'update',
        streamRevision: 4
      })
    ])
    handle!.reset()
    expect(handle!.samples).toHaveLength(0)
    vi.unstubAllGlobals()
  })
})
