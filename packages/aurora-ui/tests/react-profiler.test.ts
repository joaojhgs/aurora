// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'

import {
  createAuroraReactProfilerOnRender,
  getAuroraReactProfilerBridge,
  installAuroraReactProfilerBridge,
  recordAuroraReactProfilerSample,
} from '../src/react-profiler'

describe('Aurora React profiler bridge', () => {
  afterEach(() => {
    delete window.__AURORA_REACT_PROFILER__
  })

  it('does not create samples until the bridge is explicitly installed and enabled', () => {
    recordAuroraReactProfilerSample({
      label: 'assistant.thread',
      phase: 'update',
      actualDuration: 1,
      baseDuration: 2,
      startTime: 3,
      commitTime: 4,
      revision: 1,
    })
    expect(getAuroraReactProfilerBridge()).toBeNull()

    const handle = installAuroraReactProfilerBridge()
    recordAuroraReactProfilerSample({
      label: 'assistant.thread',
      phase: 'update',
      actualDuration: 1,
      baseDuration: 2,
      startTime: 3,
      commitTime: 4,
      revision: 1,
    })

    expect(handle?.enabled).toBe(false)
    expect(handle?.samples).toEqual([])
  })

  it('records only bounded numeric samples with stable subtree labels', () => {
    const handle = installAuroraReactProfilerBridge({ enabled: true, maxSamples: 3 })
    const onRender = createAuroraReactProfilerOnRender('assistant.message', () => 7)

    onRender('message-id-that-must-not-be-recorded', 'mount', 1.25, 2.5, 3.75, 4)
    recordAuroraReactProfilerSample({
      label: 'assistant.composer',
      phase: 'update',
      actualDuration: 5,
      baseDuration: 6,
      startTime: 7,
      commitTime: 8,
      revision: 8,
    })
    recordAuroraReactProfilerSample({
      label: 'user prompt text should be rejected',
      phase: 'nested-update',
      actualDuration: 9,
      baseDuration: 10,
      startTime: 11,
      commitTime: 12,
      revision: 9,
    })

    expect(handle?.samples).toEqual([
      {
        label: 'assistant.message',
        phase: 'mount',
        actualDuration: 1.25,
        baseDuration: 2.5,
        startTime: 3.75,
        commitTime: 4,
        revision: 7,
      },
      {
        label: 'assistant.composer',
        phase: 'update',
        actualDuration: 5,
        baseDuration: 6,
        startTime: 7,
        commitTime: 8,
        revision: 8,
      },
      {
        label: 'unknown',
        phase: 'nested-update',
        actualDuration: 9,
        baseDuration: 10,
        startTime: 11,
        commitTime: 12,
        revision: 9,
      },
    ])
    expect(JSON.stringify(handle?.samples)).not.toContain('message-id-that-must-not-be-recorded')
  })

  it('resets samples and clamps sample limits', () => {
    const handle = installAuroraReactProfilerBridge({ enabled: true, maxSamples: 1.8 })
    recordAuroraReactProfilerSample({ label: 'assistant.thread', phase: 'update', actualDuration: 1, baseDuration: 1, startTime: 1, commitTime: 1 })
    recordAuroraReactProfilerSample({ label: 'assistant.composer', phase: 'update', actualDuration: 2, baseDuration: 2, startTime: 2, commitTime: 2 })

    expect(handle?.maxSamples).toBe(1)
    expect(handle?.samples.map((sample) => sample.label)).toEqual(['assistant.composer'])

    handle?.reset()
    expect(handle?.samples).toEqual([])

    handle?.configure({ maxSamples: 0 })
    recordAuroraReactProfilerSample({ label: 'assistant.thread', phase: 'update', actualDuration: 1, baseDuration: 1, startTime: 1, commitTime: 1 })
    expect(handle?.samples).toEqual([])
  })

  it('drops invalid timing samples and omits invalid revisions', () => {
    const handle = installAuroraReactProfilerBridge({ enabled: true })
    const onRender = createAuroraReactProfilerOnRender('assistant.thread', () => Number.NaN)

    onRender('dynamic-id', 'update', 1, 2, 3, 4)
    recordAuroraReactProfilerSample({ label: 'assistant.thread', phase: 'update', actualDuration: -1, baseDuration: 2, startTime: 3, commitTime: 4 })

    expect(handle?.samples).toEqual([
      {
        label: 'assistant.thread',
        phase: 'update',
        actualDuration: 1,
        baseDuration: 2,
        startTime: 3,
        commitTime: 4,
      },
    ])
  })
})
