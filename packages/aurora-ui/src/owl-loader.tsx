'use client'

import type { CSSProperties } from 'react'

export type AuroraOwlLoaderStageId = 'boot' | 'core' | 'mesh' | 'models' | 'assistant' | 'workspace' | 'ready'

export interface AuroraOwlLoaderStage {
  id: AuroraOwlLoaderStageId
  message: string
  progress: number
  label: string
}

export const AURORA_OWL_LOADER_STAGES: AuroraOwlLoaderStage[] = [
  { id: 'boot', message: 'Waking the owl…', progress: 8, label: 'boot' },
  { id: 'core', message: 'Starting core services…', progress: 26, label: 'core' },
  { id: 'mesh', message: 'Connecting to secure mesh…', progress: 46, label: 'mesh' },
  { id: 'models', message: 'Loading local models…', progress: 66, label: 'models' },
  { id: 'assistant', message: 'Warming up the assistant…', progress: 85, label: 'assistant' },
  { id: 'workspace', message: 'Finalizing workspace…', progress: 96, label: 'workspace' },
  { id: 'ready', message: 'All systems online', progress: 100, label: 'ready' }
]

const stageIndexById = new Map(AURORA_OWL_LOADER_STAGES.map((stage, index) => [stage.id, index]))

export interface AuroraOwlLoaderProgress {
  completed: number
  total: number
}

export interface AuroraOwlLoaderProps {
  owlSrc: string
  stageId: AuroraOwlLoaderStageId
  /** Real 0-100 progress reported by the caller; falls back to the stage's design value when omitted. */
  progressPct?: number | null
  /** Real backend status text (attempt counts, service tallies, errors); falls back to a generic stage counter when omitted. */
  detail?: string | null
}

export function AuroraOwlLoader({ owlSrc, stageId, progressPct, detail }: AuroraOwlLoaderProps) {
  const index = stageIndexById.get(stageId) ?? 0
  const stage = AURORA_OWL_LOADER_STAGES[index] ?? AURORA_OWL_LOADER_STAGES[0]!
  const total = AURORA_OWL_LOADER_STAGES.length - 1
  const resolvedProgress = typeof progressPct === 'number' && Number.isFinite(progressPct)
    ? Math.max(0, Math.min(100, Math.round(progressPct)))
    : stage.progress
  const online = resolvedProgress >= 100
  const count = Math.min(index + 1, total)
  const progressLabel = online
    ? 'ALL SERVICES ONLINE'
    : detail ?? `${count} / ${total} SERVICES · ${stage.label.toUpperCase()}`

  return (
    <div style={rootStyle} data-screen-label="Owl Loader" data-aurora-loader-stage={stage.id}>
      <style>{owlLoaderKeyframes}</style>
      <div style={vignetteStyle} />
      <div style={orbWrapStyle}>
        <div style={glowStyle} />
        <div style={sonarStyle(0)} />
        <div style={sonarStyle(-1.27)} />
        <div style={sonarStyle(-2.53)} />
        <div style={ringSpinStyle(112, 22, 'normal')} />
        <div style={ringSpinStyle(132, 34, 'reverse')} />
        <div style={chargeStyle} />
        <div style={floatWrapStyle}>
          <img src={owlSrc} alt="Aurora owl" style={owlImageStyle} />
          <div style={eyeBaseStyle(42)} />
          <div style={eyeBaseStyle(57.8)} />
          <div style={scanWrapStyle}>
            <div style={eyeGlintStyle(42)} />
            <div style={eyeGlintStyle(57.8)} />
          </div>
        </div>
      </div>
      <div style={textBlockStyle}>
        <div style={messageRowStyle}>
          <div key={stage.id} style={messageTextStyle}>
            {stage.message}
          </div>
        </div>
        <div style={progressTrackStyle}>
          <div style={progressFillStyle(resolvedProgress)} />
          <div style={progressShimmerStyle} />
        </div>
        <div style={progressFooterStyle}>
          <span style={progressFooterLeftStyle}>
            <span style={progressDotStyle} />
            {progressLabel}
          </span>
          <span style={progressPercentStyle}>{resolvedProgress}%</span>
        </div>
      </div>
    </div>
  )
}

const rootStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 9999,
  width: '100%',
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 'clamp(24px,4.5vmin,52px)',
  background: 'radial-gradient(ellipse 80% 70% at 50% 42%,#0a1526 0%,#050a15 48%,#02040a 100%)',
  fontFamily: "Geist,system-ui,sans-serif",
  overflow: 'hidden',
  padding: '6vmin'
}

const vignetteStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'radial-gradient(circle at 50% 42%,transparent 55%,rgba(0,0,0,.55) 100%)',
  pointerEvents: 'none'
}

const orbWrapStyle: CSSProperties = {
  position: 'relative',
  width: 'clamp(190px,46vmin,470px)',
  aspectRatio: '1',
  flex: 'none'
}

const glowStyle: CSSProperties = {
  position: 'absolute',
  left: '50%',
  top: '50%',
  width: '150%',
  height: '150%',
  transform: 'translate(-50%,-50%)',
  background: 'radial-gradient(circle,rgba(0,233,218,.28) 0%,rgba(0,150,220,.14) 38%,transparent 68%)',
  animation: 'owl-glow 4.2s ease-in-out infinite',
  pointerEvents: 'none'
}

function sonarStyle(delay: number): CSSProperties {
  return {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: '118%',
    height: '118%',
    border: '1.5px solid rgba(0,233,218,.5)',
    borderRadius: '50%',
    transform: 'translate(-50%,-50%) scale(.48)',
    animation: 'owl-sonar 3.8s cubic-bezier(.2,.6,.3,1) infinite',
    animationDelay: `${delay}s`
  }
}

function ringSpinStyle(sizePct: number, durationS: number, direction: 'normal' | 'reverse'): CSSProperties {
  return {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: `${sizePct}%`,
    height: `${sizePct}%`,
    border: '1px dashed rgba(0,233,218,.28)',
    borderRadius: '50%',
    transform: 'translate(-50%,-50%)',
    animation: `owl-ringspin ${durationS}s linear infinite ${direction}`
  }
}

const chargeStyle: CSSProperties = {
  position: 'absolute',
  left: '50%',
  top: '50%',
  width: '96%',
  height: '96%',
  border: '1.5px solid rgba(0,233,218,.55)',
  borderRadius: '50%',
  transform: 'translate(-50%,-50%) scale(1.7)',
  animation: 'owl-charge 6s ease-in infinite'
}

const floatWrapStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  animation: 'owl-float 6.5s ease-in-out infinite,owl-wake 6s ease-in-out infinite',
  transformOrigin: 'center 60%'
}

const owlImageStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  objectFit: 'contain',
  filter: 'drop-shadow(0 6px 22px rgba(0,120,180,.35))'
}

function eyeBaseStyle(leftPct: number): CSSProperties {
  return {
    position: 'absolute',
    left: `${leftPct}%`,
    top: '51.4%',
    width: '4.4%',
    height: '4.4%',
    transform: 'translate(-50%,-50%)',
    borderRadius: '50%',
    background: 'radial-gradient(circle,#18f2e2 0%,#00dccb 60%,rgba(0,220,205,0) 100%)',
    filter: 'blur(.5px)'
  }
}

const scanWrapStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  animation: 'owl-scan 7.2s ease-in-out infinite'
}

function eyeGlintStyle(leftPct: number): CSSProperties {
  return {
    position: 'absolute',
    left: `${leftPct}%`,
    top: '51.4%',
    width: '3.1%',
    height: '3.1%',
    transform: 'translate(-50%,-50%)',
    borderRadius: '50%',
    background: 'radial-gradient(circle,#ffffff 0%,#d8ffff 45%,#5fe9ff 100%)',
    boxShadow: '0 0 7px 1px rgba(150,255,255,.9),0 0 14px 3px rgba(0,233,218,.5)',
    animation: 'owl-glint 3.4s ease-in-out infinite'
  }
}

const textBlockStyle: CSSProperties = {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 'clamp(12px,2vmin,18px)',
  width: 'clamp(240px,42vmin,430px)',
  zIndex: 2
}

const messageRowStyle: CSSProperties = {
  minHeight: '1.4em',
  fontSize: 'clamp(15px,2.5vmin,21px)',
  fontWeight: 500,
  letterSpacing: '.01em',
  color: '#e8f6ff',
  textAlign: 'center',
  textShadow: '0 0 18px rgba(0,233,218,.25)'
}

const messageTextStyle: CSSProperties = {
  animation: 'owl-msgin .7s cubic-bezier(.2,.7,.2,1) both'
}

const progressTrackStyle: CSSProperties = {
  position: 'relative',
  width: '100%',
  height: 5,
  borderRadius: 99,
  background: 'rgba(0,233,218,.12)',
  boxShadow: 'inset 0 0 0 1px rgba(0,233,218,.18)',
  overflow: 'hidden'
}

function progressFillStyle(progressPct: number): CSSProperties {
  return {
    position: 'absolute',
    left: 0,
    top: 0,
    height: '100%',
    borderRadius: 99,
    background: 'linear-gradient(90deg,#0aa9d6,#00e9da 70%,#3df0ff)',
    boxShadow: '0 0 10px 1px rgba(0,233,218,.7)',
    width: `${progressPct}%`,
    transition: 'width 1.5s cubic-bezier(.4,0,.2,1)'
  }
}

const progressShimmerStyle: CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  height: '100%',
  width: '32%',
  background: 'linear-gradient(90deg,transparent,rgba(255,255,255,.55),transparent)',
  mixBlendMode: 'screen',
  animation: 'owl-shimmer 2.1s linear infinite'
}

const progressFooterStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  width: '100%',
  fontFamily: "'Geist Mono',ui-monospace,monospace",
  fontSize: 'clamp(10px,1.5vmin,12px)',
  letterSpacing: '.09em',
  color: 'rgba(120,200,220,.72)',
  textTransform: 'uppercase'
}

const progressFooterLeftStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 7
}

const progressDotStyle: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: '50%',
  background: '#00e9da',
  boxShadow: '0 0 8px #00e9da',
  animation: 'owl-dot 1.3s ease-in-out infinite'
}

const progressPercentStyle: CSSProperties = {
  color: '#4df0ff'
}

const owlLoaderKeyframes = `
  @keyframes owl-sonar{
    0%{transform:translate(-50%,-50%) scale(.48);opacity:0;}
    14%{opacity:.55;}
    100%{transform:translate(-50%,-50%) scale(1.85);opacity:0;}
  }
  @keyframes owl-glow{
    0%,100%{opacity:.32;transform:translate(-50%,-50%) scale(.9);}
    50%{opacity:.66;transform:translate(-50%,-50%) scale(1.08);}
  }
  @keyframes owl-charge{
    0%{transform:translate(-50%,-50%) scale(1.7);opacity:0;}
    32%{opacity:.5;}
    100%{transform:translate(-50%,-50%) scale(.68);opacity:0;}
  }
  @keyframes owl-float{
    0%,100%{transform:translateY(0);}
    50%{transform:translateY(-2.4%);}
  }
  @keyframes owl-wake{
    0%,100%{filter:brightness(.9) saturate(1);}
    12%{filter:brightness(1.22) saturate(1.3) drop-shadow(0 0 14px rgba(0,233,218,.5));}
    28%{filter:brightness(1) saturate(1.06);}
  }
  @keyframes owl-scan{
    0%,16%{transform:translateX(0);}
    28%,44%{transform:translateX(-4.2%);}
    56%,72%{transform:translateX(4.2%);}
    86%,100%{transform:translateX(0);}
  }
  @keyframes owl-glint{
    0%,100%{opacity:.85;transform:translate(-50%,-50%) scale(.92);}
    50%{opacity:1;transform:translate(-50%,-50%) scale(1.08);}
  }
  @keyframes owl-shimmer{
    0%{transform:translateX(-120%);}
    100%{transform:translateX(360%);}
  }
  @keyframes owl-msgin{
    0%{opacity:0;transform:translateY(7px);filter:blur(3px);}
    100%{opacity:1;transform:translateY(0);filter:blur(0);}
  }
  @keyframes owl-ringspin{
    0%{transform:translate(-50%,-50%) rotate(0deg);}
    100%{transform:translate(-50%,-50%) rotate(360deg);}
  }
  @keyframes owl-dot{
    0%,100%{opacity:.25;}
    50%{opacity:1;}
  }
`
