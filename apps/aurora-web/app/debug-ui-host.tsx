'use client'

import { lazy, Suspense, type ReactNode } from 'react'

/**
 * Compile-time gate for the development preview chrome.
 * Production Next builds inline NODE_ENV as "production", so the picker/emulator
 * module is never imported or mounted. Debug servers started via
 * `pnpm dev:ui:debug` also set NEXT_PUBLIC_AURORA_DEBUG_UI=1.
 */
const debugUiHostEnabled =
  process.env.NODE_ENV !== 'production'
  && process.env.NEXT_PUBLIC_AURORA_DEBUG_UI === '1'

const LazyDebugUiPicker = debugUiHostEnabled
  ? lazy(() => import('./debug-ui-picker').then((module) => ({ default: module.DebugUiPicker })))
  : null

const LazyDebugUiIndicator = debugUiHostEnabled
  ? lazy(() => import('./debug-ui-picker').then((module) => ({ default: module.DebugUiIndicator })))
  : null

export function DebugUiPicker({ children }: { children?: ReactNode }) {
  if (!LazyDebugUiPicker) return children ?? null
  return (
    <Suspense fallback={children ?? null}>
      <LazyDebugUiPicker>{children}</LazyDebugUiPicker>
    </Suspense>
  )
}

export function DebugUiIndicator() {
  if (!LazyDebugUiIndicator) return null
  return (
    <Suspense fallback={null}>
      <LazyDebugUiIndicator />
    </Suspense>
  )
}
