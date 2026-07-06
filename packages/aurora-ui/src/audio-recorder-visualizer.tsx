'use client'

import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { Mic, RotateCcw, SendHorizontal, StopCircle } from 'lucide-react'
import type { VoiceCaptureStatus } from './assistant-view'

type RecorderVariant = 'compact' | 'panel'

type RecorderAction = 'start' | 'stop' | 'reset' | 'send'

export interface AudioRecorderVisualizerProps {
  status: VoiceCaptureStatus
  bars?: number[] | undefined
  elapsedSeconds?: number | undefined
  disabled?: boolean | undefined
  className?: string | undefined
  variant?: RecorderVariant | undefined
  showControls?: boolean | undefined
  title?: ReactNode
  detail?: ReactNode
  sourceLabel?: string | undefined
  onToggle?: (() => void) | undefined
  onReset?: (() => void) | undefined
  onSend?: (() => void) | undefined
}

const inactiveBars = Array.from({ length: 48 }, () => 0)

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

function pad(num: number): string {
  return String(num).padStart(2, '0')
}

function timerParts(totalSeconds: number): [string, string, string] {
  const safe = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const seconds = safe % 60
  return [pad(hours), pad(minutes), pad(seconds)]
}

function recorderAction(status: VoiceCaptureStatus): RecorderAction {
  if (status === 'listening' || status === 'processing' || status === 'speaking') return 'stop'
  return 'start'
}

function statusText(status: VoiceCaptureStatus): string {
  if (status === 'listening') return 'Listening'
  if (status === 'processing') return 'Processing voice'
  if (status === 'speaking') return 'Speaking'
  if (status === 'permission-denied') return 'Microphone permission denied'
  if (status === 'no-device') return 'No microphone available'
  if (status === 'error') return 'Voice capture error'
  return 'Ready for voice'
}

function normalizeBars(bars: number[] | undefined, count: number): number[] {
  const source = bars && bars.length > 0 ? bars : inactiveBars
  if (source.length === count) return source
  return Array.from({ length: count }, (_, index) => {
    const sourceIndex = Math.floor((index / Math.max(1, count - 1)) * Math.max(0, source.length - 1))
    return source[sourceIndex] ?? 0
  })
}

export function AudioRecorderVisualizer({
  status,
  bars,
  elapsedSeconds = 0,
  disabled = false,
  className,
  variant = 'compact',
  showControls = true,
  title,
  detail,
  sourceLabel,
  onToggle,
  onReset,
  onSend
}: AudioRecorderVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const action = recorderAction(status)
  const active = status === 'listening' || status === 'processing' || status === 'speaking'
  const unavailable = status === 'permission-denied' || status === 'no-device' || status === 'error'
  const visualBars = useMemo(() => normalizeBars(bars, variant === 'panel' ? 96 : 64), [bars, variant])
  const [hours, minutes, seconds] = timerParts(elapsedSeconds)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const ratio = typeof window === 'undefined' ? 1 : Math.max(1, Math.min(2, window.devicePixelRatio || 1))
    const rect = canvas.getBoundingClientRect()
    const width = Math.max(1, Math.floor((rect.width || 320) * ratio))
    const height = Math.max(1, Math.floor((rect.height || 48) * ratio))
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height

    ctx.clearRect(0, 0, width, height)
    const centerY = height / 2
    const gap = Math.max(1, Math.floor(2 * ratio))
    const barWidth = Math.max(1, Math.floor(width / visualBars.length) - gap)
    const maxBarHeight = height * 0.72
    const color = unavailable ? 'rgba(248, 113, 113, 0.78)' : active ? 'rgba(94, 234, 212, 0.92)' : 'rgba(148, 163, 184, 0.35)'
    const glow = active ? 'rgba(94, 234, 212, 0.22)' : 'rgba(148, 163, 184, 0.08)'

    ctx.fillStyle = glow
    ctx.fillRect(0, centerY - ratio, width, 2 * ratio)
    ctx.fillStyle = color
    for (let index = 0; index < visualBars.length; index += 1) {
      const normalized = Math.max(0, Math.min(100, visualBars[index] ?? 0)) / 100
      const shaped = Math.pow(normalized, active ? 1.15 : 1.4)
      const barHeight = Math.max(active ? 3 * ratio : 1.5 * ratio, shaped * maxBarHeight)
      const x = index * (barWidth + gap)
      const y = centerY - barHeight / 2
      if (ctx.roundRect) {
        ctx.beginPath()
        ctx.roundRect(x, y, barWidth, barHeight, Math.max(1, barWidth / 2))
        ctx.fill()
      } else {
        ctx.fillRect(x, y, barWidth, barHeight)
      }
    }
  }, [active, unavailable, variant, visualBars])

  return (
    <div
      className={cx('aui-audio-recorder', `aui-audio-recorder-${variant}`, active && 'aui-audio-recorder-active', unavailable && 'aui-audio-recorder-unavailable', className)}
      data-voice-state={status}
      aria-label="Audio recorder and live microphone visualizer"
    >
      <div className="aui-audio-recorder-main">
        <div className="aui-audio-recorder-copy">
          <span className="aui-audio-recorder-title">{title ?? statusText(status)}</span>
          <span className="aui-audio-recorder-detail">{detail ?? (sourceLabel ? `${sourceLabel} audio` : 'Live microphone level')}</span>
        </div>
        <div className="aui-audio-recorder-timer" aria-label={`Recording timer ${hours}:${minutes}:${seconds}`}>
          <span>{hours}</span><b>:</b><span>{minutes}</span><b>:</b><span>{seconds}</span>
        </div>
      </div>
      <canvas ref={canvasRef} className="aui-audio-recorder-canvas" aria-hidden />
      {showControls ? (
        <div className="aui-audio-recorder-controls">
          {onReset ? (
            <button type="button" className="aui-audio-recorder-button aui-audio-recorder-reset" onClick={onReset} disabled={disabled || !active} aria-label="Reset voice recording">
              <RotateCcw size={15} aria-hidden />
            </button>
          ) : null}
          <button
            type="button"
            className="aui-audio-recorder-button aui-audio-recorder-primary"
            onClick={onToggle}
            disabled={disabled}
            aria-label={action === 'stop' ? 'Stop listening' : 'Push to talk'}
          >
            {action === 'stop' ? <StopCircle size={16} aria-hidden /> : <Mic size={15} aria-hidden />}
            <span className="aui-sr-only">{action === 'stop' ? 'Stop listening' : 'Push to talk'}</span>
          </button>
          {onSend ? (
            <button type="button" className="aui-audio-recorder-button aui-audio-recorder-send" onClick={onSend} disabled={disabled || !active} aria-label="Send voice recording">
              <SendHorizontal size={15} aria-hidden />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
