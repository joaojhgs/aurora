'use client'

import { useEffect, type RefObject } from 'react'

import type { AuroraOverlayLevel, AuroraVoiceOverlayState } from './types'

type VisualizerOptions = {
  iconRef: RefObject<HTMLImageElement | null>
  sweepRef: RefObject<HTMLDivElement | null>
  state: AuroraVoiceOverlayState
  level?: AuroraOverlayLevel | null | undefined
}

export function useAuroraOrbVisualizer({ iconRef, sweepRef, state, level }: VisualizerOptions) {
  useEffect(() => {
    let frame = 0

    const tick = (timestamp: number) => {
      frame = window.requestAnimationFrame(tick)
      const liveLevel = liveVisualLevel(level, state)
      const visualLevel = clampVisualLevel(liveLevel ?? syntheticLevel(timestamp, state))
      const icon = iconRef.current
      if (icon) {
        const glowPrefix = state === 'muted'
          ? 'rgba(120,124,128,'
          : state === 'speaking'
            ? 'rgba(55,170,227,'
            : state === 'error'
              ? 'rgba(230,66,76,'
              : 'rgba(26,209,209,'
        const grayscale = state === 'muted' ? 'grayscale(1) ' : ''
        const speakingBoost = state === 'speaking' ? 1.45 : 1
        icon.style.filter = `${grayscale}brightness(${1 + visualLevel * 0.7 * speakingBoost}) saturate(${1 + visualLevel * 0.9 * speakingBoost}) drop-shadow(0 0 ${10 + visualLevel * 48 * speakingBoost}px ${glowPrefix}${0.38 + visualLevel * 0.58}))`
        icon.style.transform = `translate(-50%,-50%) scale(${1 + visualLevel * (state === 'speaking' ? 0.28 : 0.18) * speakingBoost})`
      }

      const sweep = sweepRef.current
      if (sweep) {
        sweep.style.opacity = state === 'muted' ? '0.1' : `${state === 'speaking' ? 0.72 + visualLevel * 1 : 0.5 + visualLevel * 0.65}`
      }
    }

    frame = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frame)
  }, [iconRef, sweepRef, state, level])
}

function liveVisualLevel(level: AuroraOverlayLevel | null | undefined, state: AuroraVoiceOverlayState): number | null {
  if (!level) return null
  const liveLevel = normalizedLevel(level.level)
  if (liveLevel !== null) return perceptualLevel(liveLevel, level.source, state)
  const peakLevel = normalizedLevel(level.peak)
  if (peakLevel !== null) return perceptualLevel(peakLevel, level.source, state)
  const barsLevel = averageLevel(level.bars)
  return barsLevel === null ? null : perceptualLevel(barsLevel, level.source, state)
}

function averageLevel(values: number[] | null | undefined): number | null {
  if (!Array.isArray(values)) return null
  const normalized = values
    .map(normalizedLevel)
    .filter((value): value is number => value !== null)
  if (normalized.length === 0) return null
  return normalized.reduce((sum, value) => sum + value, 0) / normalized.length
}

function normalizedLevel(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return clampVisualLevel(value > 1 ? value / 100 : value)
}

function clampVisualLevel(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function perceptualLevel(
  rawLevel: number,
  source: AuroraOverlayLevel['source'],
  state: AuroraVoiceOverlayState
): number {
  const normalized = clampVisualLevel(rawLevel)
  if (source === 'synthetic') return normalized

  const gain = source === 'output' ? 4.1 : 2.45
  const compressed = Math.sqrt(clampVisualLevel(normalized * gain))
  const activeFloor = state === 'speaking' && source === 'output'
    ? 0.56
    : state === 'listening' && source === 'input'
      ? 0.22
      : state === 'processing'
        ? 0.18
        : 0
  return clampVisualLevel(Math.max(activeFloor, compressed))
}

function syntheticLevel(timestamp: number, state: AuroraVoiceOverlayState): number {
  if (state === 'muted') return 0.04
  if (state === 'error') return 0.18
  if (state === 'listening' || state === 'speaking' || state === 'processing') {
    const speed = state === 'speaking' ? 0.006 : 0.0038
    const envelope =
      0.32 +
      0.34 * Math.abs(Math.sin(timestamp * speed)) +
      0.28 * Math.max(0, Math.sin(timestamp * speed * 3.3)) * (0.6 + 0.4 * Math.abs(Math.sin(timestamp * speed * 1.7)))
    return Math.min(1, envelope)
  }
  return 0.08 + 0.04 * Math.sin(timestamp * 0.0015)
}
