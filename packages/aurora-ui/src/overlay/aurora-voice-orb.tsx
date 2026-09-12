'use client'

import { MicOff, X } from 'lucide-react'
import { useMemo, useRef, type CSSProperties, type MouseEvent, type MouseEventHandler } from 'react'

import { useAuroraOrbVisualizer } from './use-aurora-orb-visualizer'
import type { AuroraOverlayLevel, AuroraVoiceOverlayState } from './types'

export interface AuroraVoiceOrbProps {
  owlSrc: string
  state: AuroraVoiceOverlayState
  level?: AuroraOverlayLevel | null | undefined
  onClose?: (() => void) | undefined
  onOrbClick?: (() => void) | undefined
  onDragStart?: MouseEventHandler<HTMLDivElement> | undefined
}

export function AuroraVoiceOrb({ owlSrc, state, level, onClose, onOrbClick, onDragStart }: AuroraVoiceOrbProps) {
  const iconRef = useRef<HTMLImageElement | null>(null)
  const sweepRef = useRef<HTMLDivElement | null>(null)
  useAuroraOrbVisualizer({ iconRef, sweepRef, state, level })

  const sweep = useMemo(() => sweepStyleForState(state), [state])

  return (
    <div style={voicePopupStackStyle} data-aurora-overlay="voice">
      <DragGrip onMouseDown={onDragStart} />
      <button type="button" onClick={onClose} title="Dismiss" style={voiceCloseButtonStyle}>
        <X size={13} strokeWidth={2} />
      </button>
      <button type="button" onClick={onOrbClick} title="Aurora voice overlay" style={orbButtonStyle}>
        <img ref={iconRef} src={owlSrc} alt="Aurora" style={iconStyleForState(state)} />
        <div data-aurora-orb-clip="true" style={orbClipStyle}>
          <div ref={sweepRef} style={sweep} />
        </div>
        {state === 'muted' ? (
          <div style={muteBadgeStyle} aria-label="Muted">
            <MicOff size={13} strokeWidth={1.8} />
          </div>
        ) : null}
      </button>
      <span style={chipStyle}>{voiceLabel(state)}</span>
    </div>
  )
}

export function DragGrip({ onMouseDown }: { onMouseDown?: MouseEventHandler<HTMLDivElement> | undefined }) {
  function handleMouseDown(event: MouseEvent<HTMLDivElement>) {
    onMouseDown?.(event)
    event.stopPropagation()
  }

  return (
    <div onMouseDown={handleMouseDown} title="Drag to move" style={dragGripStyle}>
      <span style={dragDotStyle} />
      <span style={dragDotStyle} />
      <span style={dragDotStyle} />
    </div>
  )
}

function voiceLabel(state: AuroraVoiceOverlayState): string {
  if (state === 'listening') return 'Listening'
  if (state === 'processing') return 'Processing'
  if (state === 'speaking') return 'Speaking'
  if (state === 'muted') return 'Muted'
  return 'Error'
}

function iconStyleForState(state: AuroraVoiceOverlayState): CSSProperties {
  return {
    position: 'absolute',
    left: '50%',
    top: '50%',
    transform: 'translate(-50%,-50%)',
    width: 122,
    height: 122,
    borderRadius: 999,
    objectFit: 'contain',
    objectPosition: '50% 50%',
    clipPath: 'circle(49.5% at 50% 50%)',
    opacity: state === 'muted' ? 0.55 : 1,
    WebkitMask: orbArtMask,
    mask: orbArtMask,
    filter: `${state === 'muted' ? 'grayscale(1) ' : 'grayscale(0) '}drop-shadow(0 0 8px rgba(26,209,209,.3))`,
    transition: 'opacity .25s'
  }
}

function sweepStyleForState(state: AuroraVoiceOverlayState): CSSProperties {
  const sweepColor = state === 'speaking' ? '#6fe3ff' : state === 'muted' ? '#5b5f63' : state === 'error' ? '#e6424c' : '#5be9d6'
  const speed = state === 'speaking' ? '1.35s' : state === 'listening' ? '4.5s' : '18s'
  return {
    position: 'absolute',
    inset: -8,
    borderRadius: 999,
    pointerEvents: 'none',
    animation: `auroraOrbSweepRotate ${speed} linear infinite`,
    opacity: state === 'speaking' ? 0.84 : 0.62,
    background: `conic-gradient(from 0deg,transparent 0deg,transparent 265deg,${sweepColor} 300deg,#fff 330deg,${sweepColor} 345deg,transparent 360deg)`,
    WebkitMask: 'radial-gradient(circle,transparent 53%,#000 62%,#000 93%,transparent 100%)',
    mask: 'radial-gradient(circle,transparent 53%,#000 62%,#000 93%,transparent 100%)',
    filter: `drop-shadow(0 0 ${state === 'speaking' ? 18 : 10}px ${sweepColor})`
  }
}

const voicePopupStackStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 8,
  fontFamily: "'Geist', system-ui, sans-serif",
  overflow: 'visible',
  padding: '2px 10px 12px'
}

const dragGripStyle: CSSProperties = {
  alignSelf: 'stretch',
  height: 14,
  margin: '-2px 0 -2px',
  cursor: 'grab',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 3,
  touchAction: 'none'
}

const dragDotStyle: CSSProperties = {
  width: 3,
  height: 3,
  borderRadius: 999,
  background: '#8e939880'
}

const voiceCloseButtonStyle: CSSProperties = {
  alignSelf: 'flex-end',
  width: 24,
  height: 24,
  borderRadius: 999,
  border: 'none',
  background: 'rgba(255,255,255,.18)',
  color: '#fff',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0
}

const orbButtonStyle: CSSProperties = {
  width: 132,
  height: 132,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  padding: 0,
  appearance: 'none',
  WebkitAppearance: 'none',
  WebkitTapHighlightColor: 'transparent',
  display: 'block',
  lineHeight: 0,
  position: 'relative',
  overflow: 'visible',
  borderRadius: 999
}

const orbArtMask = 'radial-gradient(circle 59px at 50% 50%, #000 0 51px, rgba(0,0,0,.96) 55px, rgba(0,0,0,.42) 58px, transparent 61px)'

const orbClipStyle: CSSProperties = {
  position: 'absolute',
  left: '50%',
  top: '50%',
  width: 132,
  height: 132,
  transform: 'translate(-50%,-50%)',
  borderRadius: 999,
  overflow: 'hidden',
  pointerEvents: 'none',
  background: 'transparent'
}

const muteBadgeStyle: CSSProperties = {
  position: 'absolute',
  bottom: 2,
  right: 2,
  width: 24,
  height: 24,
  borderRadius: 999,
  background: 'rgba(32,36,42,.92)',
  border: '2px solid rgba(255,255,255,.25)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: '#c7cacd'
}

const chipStyle: CSSProperties = {
  font: "500 11px/1.2 'Geist', system-ui, sans-serif",
  color: '#3a3d42',
  background: '#ffffffcc',
  padding: '3px 9px',
  borderRadius: 999
}
