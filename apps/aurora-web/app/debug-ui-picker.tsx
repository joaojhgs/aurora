'use client'

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  AURORA_DEBUG_UI_DEFAULT_OVERRIDE,
  AURORA_DEBUG_UI_OVERRIDE_EVENT,
  AURORA_DEBUG_UI_ROLES,
  AURORA_DEBUG_COMPACT_ATTR,
  AURORA_DEBUG_UI_ROOT_ID,
  AURORA_DEBUG_UI_SURFACES,
  AURORA_DEBUG_UI_VIEWPORTS,
  AURORA_DEBUG_VIEWPORT_ROOT_ID,
  auroraDebugUiViewportPreset,
  isAuroraDebugUiProductionEnv,
  isMobileAuroraDebugUiSurface,
  mergeAuroraDebugUiOverride,
  persistAuroraDebugUiOverride,
  readBrowserAuroraDebugUiSources,
  type AuroraDebugUiOverride,
  type AuroraDebugUiRole,
  type AuroraDebugUiSurface,
  type AuroraDebugUiTier,
  type AuroraDebugUiViewport,
} from './debug-ui-override'
import {
  isAuroraDebugUiPickerEnabled,
  overrideFromDebugUiLaunch,
  resolveAuroraDebugUiLaunch,
} from './debug-ui-launch'

const SURFACE_LABELS: Record<AuroraDebugUiSurface, string> = {
  web: 'Web',
  'desktop-local': 'Desktop local',
  'desktop-thin': 'Desktop client',
  android: 'Android',
  ios: 'iOS',
  mobile: 'Mobile',
}

const ROLE_LABELS: Record<AuroraDebugUiRole, string> = {
  'remote-console': 'Connect',
  'mesh-node': 'Make this device available',
}

const BADGE_ROLE_LABELS: Record<AuroraDebugUiRole, string> = {
  'remote-console': 'Connect',
  'mesh-node': 'Make available',
}

const TIER_LABELS: Record<AuroraDebugUiTier, string> = {
  none: 'Not a local runtime',
  'lightweight-ts': 'This device runtime',
  'python-full': 'Run Aurora on this computer',
}

const VIEWPORT_LABELS: Record<AuroraDebugUiViewport, string> = {
  full: 'Full',
  tablet: 'Tablet',
  phone: 'Phone',
}

const BADGE_CLASS_NAME = 'aurora-debug-ui-badge fixed bottom-4 right-4 z-[2147483647] grid h-9 w-9 place-items-center m-0 cursor-pointer rounded-[999px] border border-[rgba(255,255,255,0.14)] bg-[#18181b] p-0 text-[#f4f4f5] ![font:700_13px/1_ui-sans-serif,system-ui,sans-serif] tracking-[-0.02em] shadow-[0_6px_18px_rgba(0,0,0,0.35)] pointer-events-auto after:absolute after:right-[3px] after:top-[3px] after:h-[7px] after:w-[7px] after:rounded-[999px] after:bg-[#f59e0b] after:shadow-[0_0_0_2px_#18181b] after:content-[""]'
const PANEL_CLASS_NAME = 'fixed right-4 bottom-[60px] z-[2147483647] w-[min(22rem,calc(100vw_-_2rem))] rounded-[12px] border border-[rgba(255,255,255,0.12)] bg-[rgba(9,9,11,0.96)] p-3 text-[#e4e4e7] shadow-[0_18px_40px_rgba(0,0,0,0.35)] pointer-events-auto'
const PANEL_TITLE_CLASS_NAME = 'm-0 mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#a1a1aa]'
const FIELD_CLASS_NAME = 'grid gap-1 text-[12px]'
const SELECT_CLASS_NAME = 'rounded-[0.45rem] border border-[rgba(255,255,255,0.12)] bg-[#09090b] px-2 py-[0.35rem] ![font:400_13px/normal_ui-sans-serif,system-ui,sans-serif] [color:inherit]'

type DebugUiPickerProps = {
  children?: ReactNode
  onOverrideChange?: (override: AuroraDebugUiOverride) => void
}

let lastKnownOverride: AuroraDebugUiOverride | null = null

export function rememberAuroraDebugUiOverride(
  override: AuroraDebugUiOverride | null,
): AuroraDebugUiOverride | null {
  if (override) lastKnownOverride = override
  return override ?? lastKnownOverride
}

export function emitAuroraDebugUiOverride(override: AuroraDebugUiOverride): void {
  rememberAuroraDebugUiOverride(override)
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(AURORA_DEBUG_UI_OVERRIDE_EVENT, { detail: override }))
}

export function DebugUiPicker({ children, onOverrideChange }: DebugUiPickerProps) {
  const [override, setOverride] = useState<AuroraDebugUiOverride | null>(null)

  useLayoutEffect(() => {
    setOverride(readVisibleAuroraDebugUiOverride())
  }, [])

  useEffect(() => {
    const onOverride = (event: Event) => {
      const next = (event as CustomEvent<AuroraDebugUiOverride>).detail
      if (!next?.surface) return
      const runtimeChanged =
        !override
        || next.surface !== override.surface
        || next.role !== override.role
        || next.tier !== override.tier
        || next.admin !== override.admin
      setOverride(next)
      if (runtimeChanged) onOverrideChange?.(next)
    }
    window.addEventListener(AURORA_DEBUG_UI_OVERRIDE_EVENT, onOverride)
    return () => window.removeEventListener(AURORA_DEBUG_UI_OVERRIDE_EVENT, onOverride)
  }, [onOverrideChange, override])

  if (!override) {
    return children ?? null
  }

  return <DebugViewportFrame viewport={override.viewport}>{children}</DebugViewportFrame>
}

export function DebugUiIndicator() {
  if (!isAuroraDebugUiPickerEnabled()) {
    return null
  }
  return <DebugUiIndicatorChrome />
}

export function debugUiBadgeLabel(override: AuroraDebugUiOverride): string {
  const parts = [
    SURFACE_LABELS[override.surface],
    BADGE_ROLE_LABELS[override.role],
  ]
  if (override.tier === 'python-full') parts.push('Full runtime')
  parts.push(VIEWPORT_LABELS[override.viewport])
  if (override.admin) parts.push('Admin')
  return parts.join(' · ')
}

export function resetAuroraDebugUiIndicatorForTests(): void {
  lastKnownOverride = null
  document.getElementById(AURORA_DEBUG_UI_ROOT_ID)?.remove()
  document.getElementById(AURORA_DEBUG_VIEWPORT_ROOT_ID)?.remove()
  document.getElementById('aurora-debug-ui-runtime-css')?.remove()
  document.documentElement.classList.remove('aurora-debug-ui-framed')
  document.documentElement.removeAttribute(AURORA_DEBUG_COMPACT_ATTR)
}

function DebugUiIndicatorChrome() {
  const rootRef = useRef<HTMLDivElement>(null)
  const [override, setOverride] = useState<AuroraDebugUiOverride>(AURORA_DEBUG_UI_DEFAULT_OVERRIDE)
  const [open, setOpen] = useState(false)

  useLayoutEffect(() => {
    for (const el of document.querySelectorAll('[data-aurora-dev-preview-host], #aurora-debug-ui-root')) {
      if (el !== rootRef.current) el.remove()
    }
    const next = readVisibleAuroraDebugUiOverride() ?? AURORA_DEBUG_UI_DEFAULT_OVERRIDE
    rememberAuroraDebugUiOverride(next)
    setOverride(next)
  }, [])

  useEffect(() => {
    if (!override) return
    persistAuroraDebugUiOverride(override)
  }, [override])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (rootRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  if (!override) return null

  const apply = (patch: Partial<AuroraDebugUiOverride>) => {
    const next = persistAuroraDebugUiOverride(mergeAuroraDebugUiOverride(override, patch))
    setOverride(next)
    emitAuroraDebugUiOverride(next)
  }

  return (
    <div
      ref={rootRef}
      id={AURORA_DEBUG_UI_ROOT_ID}
      data-aurora-dev-preview-host="true"
      className="aurora-debug-ui-host"
      style={{ display: 'contents' }}
    >
      <style id="aurora-debug-ui-runtime-css">{AURORA_DEBUG_UI_RUNTIME_CSS}</style>
      <button
        type="button"
        data-aurora-dev-preview="true"
        data-aurora-dev-preview-badge="true"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Development preview: ${debugUiBadgeLabel(override)}`}
        className={BADGE_CLASS_NAME}
        suppressHydrationWarning
        onClick={() => setOpen((value) => !value)}
      >
        A
      </button>
      {open ? (
        <div
          data-aurora-dev-preview="panel"
          className={PANEL_CLASS_NAME}
          role="dialog"
          aria-label="Development preview"
        >
          <p className={PANEL_TITLE_CLASS_NAME}>
            Development preview
          </p>
          <div className="grid gap-2">
            <label className={FIELD_CLASS_NAME}>
              Surface
              <select
                className={SELECT_CLASS_NAME}
                aria-label="Development preview surface"
                value={override.surface}
                onChange={(event) => apply({ surface: event.target.value as AuroraDebugUiSurface })}
              >
                {AURORA_DEBUG_UI_SURFACES.map((surface) => (
                  <option key={surface} value={surface}>{SURFACE_LABELS[surface]}</option>
                ))}
              </select>
            </label>
            <label className={FIELD_CLASS_NAME}>
              Role
              <select
                className={SELECT_CLASS_NAME}
                aria-label="Development preview role"
                value={override.role}
                onChange={(event) => {
                  const role = event.target.value as AuroraDebugUiRole
                  apply({
                    role,
                    tier: role === 'remote-console'
                      ? 'none'
                      : override.tier === 'none' ? 'lightweight-ts' : override.tier,
                  })
                }}
              >
                {AURORA_DEBUG_UI_ROLES.map((role) => (
                  <option key={role} value={role}>{ROLE_LABELS[role]}</option>
                ))}
              </select>
            </label>
            <label className={FIELD_CLASS_NAME}>
              Runtime
              <select
                className={SELECT_CLASS_NAME}
                aria-label="Development preview runtime"
                value={override.tier}
                disabled={override.role === 'remote-console'}
                onChange={(event) => apply({ tier: event.target.value as AuroraDebugUiTier })}
              >
                {visibleDebugUiTiers(override).map((tier) => (
                  <option key={tier} value={tier}>{TIER_LABELS[tier]}</option>
                ))}
              </select>
            </label>
            <label className={FIELD_CLASS_NAME}>
              Access
              <select
                className={SELECT_CLASS_NAME}
                aria-label="Development preview access"
                value={override.admin ? 'admin' : 'member'}
                onChange={(event) => apply({ admin: event.target.value === 'admin' })}
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            </label>
            <label className={FIELD_CLASS_NAME}>
              Viewport
              <select
                className={SELECT_CLASS_NAME}
                aria-label="Development preview viewport"
                value={override.viewport}
                onChange={(event) => apply({ viewport: event.target.value as AuroraDebugUiViewport })}
              >
                {AURORA_DEBUG_UI_VIEWPORTS.map((viewport) => (
                  <option key={viewport} value={viewport}>{VIEWPORT_LABELS[viewport]}</option>
                ))}
              </select>
            </label>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function DebugViewportFrame({
  viewport,
  children,
}: {
  viewport: AuroraDebugUiViewport
  children?: ReactNode
}) {
  const preset = auroraDebugUiViewportPreset(viewport)

  useLayoutEffect(() => {
    if (!preset) {
      document.documentElement.classList.remove('aurora-debug-ui-framed')
      document.documentElement.removeAttribute(AURORA_DEBUG_COMPACT_ATTR)
      return
    }
    document.documentElement.classList.add('aurora-debug-ui-framed')
    document.documentElement.setAttribute(AURORA_DEBUG_COMPACT_ATTR, viewport)
    return () => {
      document.documentElement.classList.remove('aurora-debug-ui-framed')
      document.documentElement.removeAttribute(AURORA_DEBUG_COMPACT_ATTR)
    }
  }, [preset, viewport])

  if (!preset) return children ?? null

  return (
    <div
      id={AURORA_DEBUG_VIEWPORT_ROOT_ID}
      className="aurora-debug-viewport-host"
      data-aurora-debug-viewport-host="true"
    >
      <div
        data-aurora-debug-viewport={viewport}
        className="aurora-debug-viewport-backdrop"
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 20,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxSizing: 'border-box',
          padding: 24,
          pointerEvents: 'auto',
          background: 'radial-gradient(circle at 50% 50%, rgba(15, 23, 42, 0.2), rgba(2, 6, 23, 0.92))',
        }}
      >
        <div
          data-aurora-debug-viewport-frame={viewport}
          className="aurora-debug-viewport-frame"
          style={{
            boxSizing: 'border-box',
            display: 'flex',
            width: preset.width,
            height: preset.height,
            maxWidth: 'calc(100vw - 3rem)',
            maxHeight: 'calc(100dvh - 3rem)',
            flexDirection: 'column',
            overflow: 'hidden',
            position: 'relative',
            transform: 'translateZ(0)',
            border: '10px solid #1c1d22',
            borderRadius: 28,
            background: '#09090b',
            boxShadow: '0 18px 50px rgba(0, 0, 0, 0.45)',
          }}
        >
          <div
            className="aurora-debug-viewport-screen"
            style={{ minHeight: 0, flex: 1, height: '100%', overflow: 'auto' }}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}

function readVisibleAuroraDebugUiOverride(): AuroraDebugUiOverride | null {
  if (isAuroraDebugUiProductionEnv(process.env.NODE_ENV)) return null
  return rememberAuroraDebugUiOverride(readInitialDebugUiOverride())
}

function readInitialDebugUiOverride(): AuroraDebugUiOverride | null {
  if (typeof window === 'undefined') return null
  const sources = readBrowserAuroraDebugUiSources()
  if (!isAuroraDebugUiPickerEnabled({ env: process.env, ...sources })) return null
  const launch = resolveAuroraDebugUiLaunch({ env: process.env, ...sources })
  if (launch) return restoreMobileViewportFrame(launch.override)
  if (lastKnownOverride) return lastKnownOverride
  return restoreMobileViewportFrame(overrideFromDebugUiLaunch({
    runtimeMode: 'web-thin',
    nodeMode: 'remote-console',
    runtimeTier: 'none',
    sessionRole: 'member',
  }))
}

function restoreMobileViewportFrame(override: AuroraDebugUiOverride): AuroraDebugUiOverride {
  if (!isMobileAuroraDebugUiSurface(override.surface) || override.viewport !== 'full') {
    return override
  }
  return { ...override, viewport: 'phone', viewportExplicit: false }
}

function visibleDebugUiTiers(override: AuroraDebugUiOverride): readonly AuroraDebugUiTier[] {
  if (override.role === 'remote-console') return ['none']
  if (override.surface === 'desktop-local') return ['lightweight-ts', 'python-full']
  return ['lightweight-ts']
}

// Keep preview overrides in the same layer as the authored rules they override.
// Important declarations reverse layer precedence, including unlayered styles.
const AURORA_DEBUG_UI_RUNTIME_CSS = `
@layer components {
.aurora-debug-viewport-frame .h-dvh,
.aurora-debug-viewport-frame .min-h-dvh,
.aurora-debug-viewport-frame .aui-shell,
.aurora-debug-viewport-frame .aui-shell[data-mobile-viewport="true"] {
  height: 100% !important;
  max-height: 100%;
  min-height: 100% !important;
}
html[data-aurora-debug-compact] .aurora-debug-viewport-frame .aui-sidebar {
  display: none !important;
}
html[data-aurora-debug-compact] .aurora-debug-viewport-frame .aui-mobile-menu {
  display: block !important;
}
html[data-aurora-debug-compact] .aurora-debug-viewport-frame .aui-mobile-tabs {
  display: flex !important;
  position: absolute !important;
  inset: auto 0 0 !important;
  z-index: 30;
  min-height: 4rem;
}
html[data-aurora-debug-compact] .aurora-debug-viewport-frame [data-aurora-part="assistant-conversation-rail"] {
  display: none !important;
}
html[data-aurora-debug-compact] .aurora-debug-viewport-frame .aui-activity {
  display: none !important;
  width: 0 !important;
}
html[data-aurora-debug-compact] .aurora-debug-viewport-frame .aui-shell {
  padding-bottom: 4.1rem !important;
}
html[data-aurora-debug-compact] .aurora-debug-viewport-frame .aui-content,
html[data-aurora-debug-compact] .aurora-debug-viewport-frame .aui-content:has(.aui-assistant) {
  padding-bottom: 0 !important;
}
html[data-aurora-debug-compact] .aurora-debug-viewport-frame .aui-main-column {
  height: 100% !important;
  min-height: 0 !important;
}
html[data-aurora-debug-compact] .aurora-debug-viewport-frame .aui-assistant {
  display: flex !important;
  height: 100% !important;
  min-height: 0 !important;
  flex-direction: column !important;
  overflow: hidden !important;
}
html[data-aurora-debug-compact] .aurora-debug-viewport-frame [data-aurora-part="assistant-grid"] {
  display: flex !important;
  flex: 1 1 auto !important;
  grid-template-columns: minmax(0, 1fr) !important;
  gap: 0 !important;
  min-height: 0 !important;
  height: auto !important;
  max-height: none !important;
}
html[data-aurora-debug-compact] .aurora-debug-viewport-frame [data-aurora-part="assistant-grid"] > [data-aurora-part="assistant-workspace"] {
  flex: 1 1 auto !important;
  width: 100% !important;
  min-width: 0 !important;
  min-height: 0 !important;
}
html[data-aurora-debug-compact] .aurora-debug-viewport-frame [data-aurora-part="assistant-thread"] {
  flex: 1 1 auto !important;
  width: 100% !important;
  min-height: 0 !important;
}
html[data-aurora-debug-compact] .aurora-debug-viewport-frame [data-aurora-part="assistant-composer"] {
  display: flex !important;
  flex: 0 0 auto !important;
  flex-direction: column !important;
  align-items: stretch !important;
  width: 100% !important;
  max-width: none !important;
  min-width: 0 !important;
  margin-top: auto !important;
  grid-template-columns: none !important;
}
html[data-aurora-debug-compact] .aurora-debug-viewport-frame [data-aurora-part="assistant-composer-toolbar"],
html[data-aurora-debug-compact] .aurora-debug-viewport-frame [data-aurora-part="assistant-composer-control-row"] {
  width: 100% !important;
  max-width: none !important;
  min-width: 0 !important;
  box-sizing: border-box !important;
}
html[data-aurora-debug-compact="tablet"] .aurora-debug-viewport-frame [data-aurora-part="assistant-composer"] {
  padding: 0.55rem 0.75rem 0.65rem !important;
}
html[data-aurora-debug-compact="phone"] .aurora-debug-viewport-frame .aui-content,
html[data-aurora-debug-compact="phone"] .aurora-debug-viewport-frame .aui-content:has(.aui-assistant),
html[data-aurora-debug-compact="phone"] .aurora-debug-viewport-frame [data-aurora-part="assistant-thread"],
html[data-aurora-debug-compact="phone"] .aurora-debug-viewport-frame [data-slot="message-scroller-viewport"] {
  scrollbar-gutter: auto !important;
  scrollbar-width: none !important;
  -ms-overflow-style: none !important;
}
html[data-aurora-debug-compact="phone"] .aurora-debug-viewport-frame [data-slot="message-scroller-viewport"]::-webkit-scrollbar {
  display: none !important;
  width: 0 !important;
  height: 0 !important;
}
html[data-aurora-debug-compact="phone"] .aurora-debug-viewport-frame [data-aurora-part="assistant-grid"] > [data-aurora-part="assistant-workspace"] {
  --aui-chat-width: 100%;
}
html[data-aurora-debug-compact="phone"] .aurora-debug-viewport-frame [data-aurora-part="assistant-thread"] {
  padding-inline: 0 !important;
}
html[data-aurora-debug-compact="phone"] .aurora-debug-viewport-frame [data-slot="message-scroller-viewport"] {
  width: 100% !important;
}
html[data-aurora-debug-compact="phone"] .aurora-debug-viewport-frame [data-slot="message-scroller-content"] {
  width: 100% !important;
  padding-inline: 0.5rem !important;
}
html[data-aurora-debug-compact="phone"] .aurora-debug-viewport-frame [data-slot="message-content"] {
  max-width: 100% !important;
}
html[data-aurora-debug-compact="phone"] .aurora-debug-viewport-frame [data-slot="message"][data-align="end"] [data-slot="message-content"] {
  max-width: 92% !important;
}
html[data-aurora-debug-compact="phone"] .aurora-debug-viewport-frame [data-aurora-part="assistant-composer"] {
  padding: 0.45rem 0 0 !important;
}
html[data-aurora-debug-compact="phone"] .aurora-debug-viewport-frame [data-aurora-part="assistant-composer-toolbar"] {
  padding-inline: 0.75rem !important;
}
html[data-aurora-debug-compact="phone"] .aurora-debug-viewport-frame [data-aurora-part="assistant-composer-control-row"] {
  margin-inline: 0 !important;
  border-radius: 1rem 1rem 0 0 !important;
}
html[data-aurora-debug-compact="phone"] .aurora-debug-viewport-frame [data-aurora-part="assistant-composer"] > [data-aurora-part="assistant-composer-attachments"],
html[data-aurora-debug-compact="phone"] .aurora-debug-viewport-frame [data-aurora-part="assistant-composer"] > [data-aurora-part="assistant-composer-recorder"],
html[data-aurora-debug-compact="phone"] .aurora-debug-viewport-frame [data-aurora-part="assistant-composer-voice-recovery"] {
  width: auto !important;
  max-width: none !important;
  margin-inline: 0.75rem !important;
}
html[data-aurora-debug-compact] .aurora-debug-viewport-frame [data-aurora-part="assistant-composer-control-row"] {
  grid-template-columns: 2.5rem 2.5rem minmax(0, 1fr) 2.5rem 2.5rem !important;
}
html[data-aurora-debug-compact] .aurora-debug-viewport-frame [data-aurora-part="assistant-composer-control-row"][data-aurora-hands-free="available"] {
  grid-template-columns: 2.5rem 2.5rem minmax(0, 1fr) 2.5rem 2.5rem 2.5rem !important;
}
html[data-aurora-debug-compact] .aurora-debug-viewport-frame [data-aurora-part="assistant-composer-control-row"] > [data-aurora-control="button"] {
  width: 2.5rem !important;
  height: 2.5rem !important;
  min-height: 2.5rem !important;
}
html[data-aurora-debug-compact] .aurora-debug-viewport-frame [data-aurora-part="assistant-mobile-history-host"] {
  display: flex !important;
  align-items: center !important;
}
html[data-aurora-debug-compact] .aurora-debug-viewport-frame [data-aurora-part="assistant-composer"] [data-aurora-part="assistant-mobile-history-trigger"] {
  display: inline-flex !important;
  flex: 0 0 auto !important;
  align-items: center !important;
  gap: 0.35rem !important;
}
html[data-aurora-debug-compact="phone"] .aurora-debug-viewport-frame [data-aurora-part="assistant-mobile-history-trigger"] > span {
  display: none !important;
}
html[data-aurora-debug-compact="phone"] .aurora-debug-viewport-frame [data-aurora-part="assistant-composer"] [data-aurora-part="assistant-mobile-history-trigger"] {
  width: 2.15rem !important;
  min-width: 2.15rem !important;
  min-height: 2.15rem !important;
  justify-content: center !important;
  padding: 0 !important;
}
}
`
