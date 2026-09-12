'use client'

import { useCallback, type CSSProperties, type FocusEvent, type ReactNode } from 'react'

import { AuroraTextOverlay } from './aurora-text-overlay'
import { AuroraVoiceOrb } from './aurora-voice-orb'
import { useDraggableOverlay } from './use-draggable-overlay'
import type { AuroraOverlayLevel, AuroraOverlayMessage, AuroraOverlayMode, AuroraVoiceOverlayState } from './types'
import type { AuroraOverlayMoveResult } from './use-draggable-overlay'

export interface AuroraOverlayShellProps {
  mode: AuroraOverlayMode
  owlSrc: string
  voiceState: AuroraVoiceOverlayState
  level?: AuroraOverlayLevel | null | undefined
  messages?: AuroraOverlayMessage[] | undefined
  thinking?: boolean | undefined
  pinned?: boolean | undefined
  children?: ReactNode | undefined
  onCloseVoice?: (() => void) | undefined
  onCloseText?: (() => void) | undefined
  onTextSubmit?: ((text: string) => void) | undefined
  onVoiceClick?: (() => void) | undefined
  onTogglePin?: (() => void) | undefined
  onPointerPassthroughChange?: ((enabled: boolean) => void) | undefined
  onStartDrag?: (() => Promise<AuroraOverlayMoveResult> | AuroraOverlayMoveResult) | undefined
  onMoveBy?: ((dx: number, dy: number) => void | Promise<unknown>) | undefined
}

export function AuroraOverlayShell({
  mode,
  owlSrc,
  voiceState,
  level,
  messages,
  thinking,
  pinned,
  children,
  onCloseVoice,
  onCloseText,
  onTextSubmit,
  onVoiceClick,
  onTogglePin,
  onPointerPassthroughChange,
  onStartDrag,
  onMoveBy
}: AuroraOverlayShellProps) {
  const dragOptions = { initialOffset: { x: 0, y: 0 }, onStartDrag, onMoveBy }
  const voiceDrag = useDraggableOverlay(dragOptions)
  const textDrag = useDraggableOverlay(dragOptions)
  const disablePassthrough = useCallback(() => {
    onPointerPassthroughChange?.(false)
  }, [onPointerPassthroughChange])
  const enablePassthrough = useCallback(() => {
    if (mode !== 'text') onPointerPassthroughChange?.(true)
  }, [mode, onPointerPassthroughChange])
  const enablePassthroughOnBlur = useCallback((event: FocusEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return
    if (mode !== 'text') onPointerPassthroughChange?.(true)
  }, [mode, onPointerPassthroughChange])

  return (
    <div style={stageStyle}>
      <style>{overlayKeyframes}</style>
      {mode === 'voice' ? (
        <div
          style={voicePositionStyle(voiceDrag.offset, voiceDrag.isDragging)}
          onPointerEnter={disablePassthrough}
          onPointerLeave={enablePassthrough}
          onPointerDown={disablePassthrough}
          onMouseDown={voiceDrag.startDrag}
          onFocusCapture={disablePassthrough}
          onBlurCapture={enablePassthroughOnBlur}
        >
          <AuroraVoiceOrb
            owlSrc={owlSrc}
            state={voiceState}
            level={level}
            onClose={onCloseVoice}
            onOrbClick={onVoiceClick}
            onDragStart={voiceDrag.startDrag}
          />
        </div>
      ) : null}
      {mode === 'text' ? (
        <div
          style={textPositionStyle(textDrag.offset, textDrag.isDragging)}
          onPointerEnter={disablePassthrough}
          onPointerLeave={enablePassthrough}
          onPointerDown={disablePassthrough}
          onMouseDown={textDrag.startDrag}
          onFocusCapture={disablePassthrough}
          onBlurCapture={enablePassthroughOnBlur}
        >
          <AuroraTextOverlay
            messages={messages}
            thinking={thinking}
            pinned={pinned}
            onClose={onCloseText}
            onSubmit={onTextSubmit}
            onVoiceClick={onVoiceClick}
            onTogglePin={onTogglePin}
            onDragStart={textDrag.startDrag}
          />
        </div>
      ) : null}
      {children}
    </div>
  )
}

const stageStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  pointerEvents: 'none',
  overflow: 'visible',
  background: 'transparent',
  fontFamily: "'Geist', system-ui, sans-serif"
}

function voicePositionStyle(offset: { x: number; y: number }, isDragging: boolean): CSSProperties {
  return {
    position: 'absolute',
    top: 0,
    right: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 8,
    zIndex: 6,
    transform: `translate(${offset.x}px,${offset.y}px)`,
    pointerEvents: 'auto',
    overflow: 'visible',
    cursor: isDragging ? 'grabbing' : undefined
  }
}

function textPositionStyle(offset: { x: number; y: number }, isDragging: boolean): CSSProperties {
  return {
    position: 'absolute',
    inset: 0,
    transform: `translate(${offset.x}px,${offset.y}px)`,
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'flex-end',
    gap: 8,
    zIndex: 6,
    pointerEvents: 'auto',
    cursor: isDragging ? 'grabbing' : undefined
  }
}

const overlayKeyframes = `
@keyframes auroraOrbSweepRotate {
  to { transform: rotate(360deg); }
}
`
