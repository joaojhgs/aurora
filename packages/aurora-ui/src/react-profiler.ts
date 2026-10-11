'use client'

export type AuroraReactProfilerPhase = 'mount' | 'update' | 'nested-update'

export interface AuroraReactProfilerSample {
  label: string
  phase: AuroraReactProfilerPhase
  actualDuration: number
  baseDuration: number
  startTime: number
  commitTime: number
  revision?: number
}

export interface AuroraReactProfilerInstallOptions {
  enabled?: boolean | undefined
  maxSamples?: number | undefined
}

export interface AuroraReactProfilerHandle {
  readonly version: 1
  enabled: boolean
  maxSamples: number
  samples: AuroraReactProfilerSample[]
  reset: () => void
  configure: (options: AuroraReactProfilerInstallOptions) => void
}

declare global {
  interface Window {
    /** Explicit opt-in React commit samples for bounded QA profiling. */
    __AURORA_REACT_PROFILER__?: AuroraReactProfilerHandle | undefined
  }
}

const DEFAULT_MAX_SAMPLES = 1_000
const HARD_MAX_SAMPLES = 10_000
const UNKNOWN_LABEL = 'unknown'
const STABLE_LABEL_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*(?::[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*)?$/u

export function installAuroraReactProfilerBridge(
  options: AuroraReactProfilerInstallOptions = {}
): AuroraReactProfilerHandle | null {
  if (typeof window === 'undefined') return null
  const existing = window.__AURORA_REACT_PROFILER__
  if (existing) {
    existing.configure(options)
    return existing
  }

  const handle: AuroraReactProfilerHandle = {
    version: 1,
    enabled: options.enabled === true,
    maxSamples: normalizeMaxSamples(options.maxSamples),
    samples: [],
    reset() {
      handle.samples.length = 0
    },
    configure(nextOptions) {
      if (typeof nextOptions.enabled === 'boolean') handle.enabled = nextOptions.enabled
      if (typeof nextOptions.maxSamples !== 'undefined') {
        handle.maxSamples = normalizeMaxSamples(nextOptions.maxSamples)
        trimSamples(handle)
      }
    },
  }
  window.__AURORA_REACT_PROFILER__ = handle
  return handle
}

export function getAuroraReactProfilerBridge(): AuroraReactProfilerHandle | null {
  if (typeof window === 'undefined') return null
  return window.__AURORA_REACT_PROFILER__ ?? null
}

export function recordAuroraReactProfilerSample(sample: AuroraReactProfilerSample): void {
  const handle = getAuroraReactProfilerBridge()
  if (!handle?.enabled || handle.maxSamples <= 0) return
  const normalized = normalizeSample(sample)
  if (!normalized) return
  handle.samples.push(normalized)
  trimSamples(handle)
}

export function createAuroraReactProfilerOnRender(
  label: string,
  getRevision?: (() => number | null | undefined) | undefined
) {
  const stableLabel = normalizeLabel(label)
  return function onAuroraReactProfilerRender(
    _id: string,
    phase: AuroraReactProfilerPhase,
    actualDuration: number,
    baseDuration: number,
    startTime: number,
    commitTime: number,
  ): void {
    const sample: AuroraReactProfilerSample = {
      label: stableLabel,
      phase,
      actualDuration,
      baseDuration,
      startTime,
      commitTime,
    }
    const revision = normalizeRevision(getRevision?.())
    if (typeof revision !== 'undefined') sample.revision = revision
    recordAuroraReactProfilerSample(sample)
  }
}

function normalizeSample(sample: AuroraReactProfilerSample): AuroraReactProfilerSample | null {
  const actualDuration = normalizeTiming(sample.actualDuration)
  const baseDuration = normalizeTiming(sample.baseDuration)
  const startTime = normalizeTiming(sample.startTime)
  const commitTime = normalizeTiming(sample.commitTime)
  if (actualDuration === null || baseDuration === null || startTime === null || commitTime === null) return null
  const normalized: AuroraReactProfilerSample = {
    label: normalizeLabel(sample.label),
    phase: normalizePhase(sample.phase),
    actualDuration,
    baseDuration,
    startTime,
    commitTime,
  }
  const revision = normalizeRevision(sample.revision)
  if (typeof revision !== 'undefined') normalized.revision = revision
  return normalized
}

function normalizePhase(phase: AuroraReactProfilerPhase): AuroraReactProfilerPhase {
  return phase === 'mount' || phase === 'nested-update' ? phase : 'update'
}

function normalizeLabel(label: string): string {
  const trimmed = label.trim()
  if (trimmed.length === 0 || trimmed.length > 80) return UNKNOWN_LABEL
  return STABLE_LABEL_PATTERN.test(trimmed) ? trimmed : UNKNOWN_LABEL
}

function normalizeTiming(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? value : null
}

function normalizeRevision(value: number | null | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const revision = Math.floor(value)
  return revision >= 0 && revision <= Number.MAX_SAFE_INTEGER ? revision : undefined
}

function normalizeMaxSamples(value: number | undefined): number {
  if (typeof value === 'undefined') return DEFAULT_MAX_SAMPLES
  if (!Number.isFinite(value)) return DEFAULT_MAX_SAMPLES
  return Math.max(0, Math.min(HARD_MAX_SAMPLES, Math.floor(value)))
}

function trimSamples(handle: AuroraReactProfilerHandle): void {
  const overflow = handle.samples.length - handle.maxSamples
  if (overflow > 0) handle.samples.splice(0, overflow)
}
