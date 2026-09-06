'use client'

export type AuroraReactProfilerPhase = 'mount' | 'update' | 'nested-update'

export interface AuroraReactProfilerSample {
  id: string
  phase: AuroraReactProfilerPhase
  actualDuration: number
  baseDuration: number
  startTime: number
  commitTime: number
  streamMessageId?: string
  streamRevision?: number
}

export interface AuroraReactProfilerHandle {
  readonly version: 1
  enabled: boolean
  maxSamples: number
  samples: AuroraReactProfilerSample[]
  reset: () => void
}

declare global {
  interface Window {
    /** Opt-in production React commit samples for QA/performance evidence. */
    __AURORA_REACT_PROFILER__?: AuroraReactProfilerHandle
  }
}

export function ensureAuroraReactProfiler(): AuroraReactProfilerHandle | null {
  if (typeof window === 'undefined') return null
  const existing = window.__AURORA_REACT_PROFILER__
  if (existing) return existing

  const handle: AuroraReactProfilerHandle = {
    version: 1,
    enabled: false,
    maxSamples: 5_000,
    samples: [],
    reset() {
      handle.samples.length = 0
    }
  }
  window.__AURORA_REACT_PROFILER__ = handle
  return handle
}

export function recordAuroraReactProfilerSample(
  sample: AuroraReactProfilerSample
): void {
  const handle = ensureAuroraReactProfiler()
  if (!handle?.enabled) return
  if (handle.samples.length >= handle.maxSamples) {
    handle.samples.splice(0, handle.samples.length - handle.maxSamples + 1)
  }
  handle.samples.push(sample)
}

// The assistant route is part of the initial Tauri bundle, so the opt-in
// handle is available before QA starts a stream and can be enabled through
// WebView CDP without rebuilding the APK.
ensureAuroraReactProfiler()

