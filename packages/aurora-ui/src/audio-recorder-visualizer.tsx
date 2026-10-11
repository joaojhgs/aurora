'use client'

import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { Mic, RotateCcw, SendHorizontal, StopCircle } from 'lucide-react'
import type { VoiceCaptureStatus } from './assistant-view'
import { cn } from './shadcn-lib/utils'

type RecorderVariant = 'compact' | 'panel' | 'composer'

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

const RECORDER_ROOT_CLASS =
  'grid w-full grid-cols-[minmax(0,1fr)_auto] grid-rows-[auto_minmax(2.2rem,1fr)] items-center gap-x-[0.65rem] gap-y-[0.45rem] rounded-[1rem] border border-[color:color-mix(in_srgb,var(--aui-border)_76%,transparent)] bg-[linear-gradient(135deg,rgb(255_255_255_/_0.055),rgb(255_255_255_/_0.025))] p-[0.65rem] text-foreground shadow-[inset_0_1px_0_rgb(255_255_255_/_0.06),0_1rem_2.5rem_rgb(0_0_0_/_0.16)] [@media(max-width:720px)]:grid-cols-[minmax(0,1fr)]'
const RECORDER_ACTIVE_CLASS =
  'border-[color:color-mix(in_srgb,var(--aui-primary)_44%,var(--aui-border))] shadow-[inset_0_1px_0_rgb(255_255_255_/_0.08),0_0_2.5rem_color-mix(in_srgb,var(--aui-primary)_13%,transparent)]'
const RECORDER_UNAVAILABLE_CLASS = 'border-[color:color-mix(in_srgb,#fb7185_44%,var(--aui-border))]'
const RECORDER_PANEL_CLASS = 'min-h-[7.5rem] grid-cols-[minmax(0,1fr)_auto] p-[0.85rem]'
const RECORDER_COMPOSER_CLASS =
  'grid-cols-[minmax(0,1fr)] grid-rows-[auto_1.35rem] gap-[0.2rem] rounded-[0.95rem] px-[0.65rem] pb-[0.46rem] pt-[0.4rem] box-border w-full backdrop-blur-[14px]'
const RECORDER_MAIN_CLASS = 'flex min-w-0 items-center justify-between gap-3'
const RECORDER_MAIN_COMPOSER_CLASS = 'min-h-[1.15rem] items-start w-full max-w-none'
const RECORDER_COPY_CLASS = 'grid min-w-0 gap-[0.12rem]'
const RECORDER_TITLE_CLASS = 'overflow-hidden text-ellipsis whitespace-nowrap text-[0.8rem] font-[850] tracking-[0.01em] text-foreground'
const RECORDER_DETAIL_CLASS = 'overflow-hidden text-ellipsis whitespace-nowrap text-[0.68rem] font-[650] text-muted-foreground'
const RECORDER_TIMER_CLASS = 'inline-flex items-center gap-[0.13rem] [font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace] text-[0.72rem] font-[850] text-muted-foreground'
const RECORDER_TIMER_CELL_CLASS =
  'min-w-[1.15rem] rounded-[0.35rem] border border-[color-mix(in_srgb,var(--aui-border)_78%,transparent)] bg-muted/60 px-[0.2rem] py-[0.16rem] text-center'
const RECORDER_CANVAS_CLASS =
  'col-start-1 h-[2.35rem] w-full rounded-[0.65rem] [background:radial-gradient(circle_at_20%_20%,color-mix(in_srgb,var(--aui-primary)_10%,transparent),transparent_45%),rgb(0_0_0_/_0.18)] [@media(max-width:720px)]:col-start-1'
const RECORDER_CONTROLS_CLASS =
  'col-start-2 row-start-1 row-span-2 flex items-center gap-[0.35rem] [@media(max-width:720px)]:col-start-1 [@media(max-width:720px)]:row-auto [@media(max-width:720px)]:justify-stretch'
const RECORDER_BUTTON_CLASS =
  'inline-flex size-[2.35rem] items-center justify-center rounded-[0.85rem] border border-border bg-muted/60 text-foreground enabled:hover:border-[color:color-mix(in_srgb,var(--aui-primary)_45%,var(--aui-border))] enabled:hover:text-primary disabled:cursor-not-allowed disabled:opacity-45 [@media(max-width:720px)]:w-auto [@media(max-width:720px)]:flex-1'
const RECORDER_PRIMARY_CLASS =
  'border-[color:color-mix(in_srgb,var(--aui-primary)_45%,transparent)] bg-[color-mix(in_srgb,var(--aui-primary)_16%,rgb(255_255_255_/_0.04))] text-primary'

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
  const composerPanel = variant === 'composer' || (className?.split(/\s+/).includes('aui-composer-recorder-panel') ?? false)
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
      className={cn(
        RECORDER_ROOT_CLASS,
        variant === 'panel' && RECORDER_PANEL_CLASS,
        active && RECORDER_ACTIVE_CLASS,
        unavailable && RECORDER_UNAVAILABLE_CLASS,
        composerPanel && RECORDER_COMPOSER_CLASS,
        className
      )}
      data-voice-state={status}
      aria-label="Audio recorder and live microphone visualizer"
    >
      <div className={cn(RECORDER_MAIN_CLASS, composerPanel && RECORDER_MAIN_COMPOSER_CLASS)}>
        <div className={RECORDER_COPY_CLASS}>
          <span className={RECORDER_TITLE_CLASS}>{title ?? statusText(status)}</span>
          <span className={cn(RECORDER_DETAIL_CLASS, composerPanel && 'text-[0.72rem]')}>{detail ?? (sourceLabel ? `${sourceLabel} audio` : 'Live microphone level')}</span>
        </div>
        <div className={RECORDER_TIMER_CLASS} aria-label={`Recording timer ${hours}:${minutes}:${seconds}`}>
          <span className={RECORDER_TIMER_CELL_CLASS}>{hours}</span><b>:</b><span className={RECORDER_TIMER_CELL_CLASS}>{minutes}</span><b>:</b><span className={RECORDER_TIMER_CELL_CLASS}>{seconds}</span>
        </div>
      </div>
      <canvas
        ref={canvasRef}
        className={cn(RECORDER_CANVAS_CLASS, variant === 'panel' && 'h-[4.2rem]', composerPanel && 'h-[1.35rem] min-h-[1.35rem] w-full max-w-none')}
        aria-hidden
      />
      {showControls ? (
        <div className={RECORDER_CONTROLS_CLASS}>
          {onReset ? (
            <button type="button" className={cn(RECORDER_BUTTON_CLASS, 'enabled:text-destructive')} onClick={onReset} disabled={disabled || !active} aria-label="Reset voice recording">
              <RotateCcw size={15} aria-hidden />
            </button>
          ) : null}
          <button
            type="button"
            className={cn(RECORDER_BUTTON_CLASS, RECORDER_PRIMARY_CLASS, active && 'bg-primary text-primary-foreground')}
            onClick={onToggle}
            disabled={disabled}
            aria-label={action === 'stop' ? 'Stop listening' : 'Push to talk'}
          >
            {action === 'stop' ? <StopCircle size={16} aria-hidden /> : <Mic size={15} aria-hidden />}
            <span className="sr-only">{action === 'stop' ? 'Stop listening' : 'Push to talk'}</span>
          </button>
          {onSend ? (
            <button type="button" className={cn(RECORDER_BUTTON_CLASS, 'enabled:text-primary')} onClick={onSend} disabled={disabled || !active} aria-label="Send voice recording">
              <SendHorizontal size={15} aria-hidden />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
