import { describe, expect, it } from 'vitest'
import { defaultSurfaceStoreScopeId, selectSurfaceIsMobile, selectSurfaceScope, useSurfaceStore } from './surface-store'

const runtimeA = 'runtime-a'
const runtimeB = 'runtime-b'

describe('surface store', () => {
  it('keeps surface policy separate from server data', () => {
    useSurfaceStore.getState().reset()
    useSurfaceStore.getState().setSurface(
      { kind: 'android', isMobile: true, isNative: true },
      { scopeId: defaultSurfaceStoreScopeId },
    )
    expect(selectSurfaceIsMobile(useSurfaceStore.getState())).toBe(true)
    expect(useSurfaceStore.getState().ready).toBe(true)
    useSurfaceStore.getState().reset()
  })

  it('keeps mounted runtime surface state isolated by scope', () => {
    useSurfaceStore.getState().reset()

    useSurfaceStore.getState().setSurface(
      { kind: 'android', isMobile: true, isNative: true },
      { scopeId: runtimeA },
    )

    useSurfaceStore.getState().activateScope(runtimeB)
    expect(useSurfaceStore.getState()).toMatchObject({
      kind: 'unknown',
      isMobile: false,
      isNative: false,
      ready: false,
    })
    expect(selectSurfaceScope(runtimeA)(useSurfaceStore.getState())).toMatchObject({
      kind: 'android',
      isMobile: true,
      isNative: true,
      ready: true,
    })

    useSurfaceStore.getState().setSurface(
      { kind: 'desktop-tauri', isMobile: false, isNative: true },
      { scopeId: runtimeB },
    )
    expect(useSurfaceStore.getState()).toMatchObject({
      kind: 'desktop-tauri',
      isMobile: false,
      isNative: true,
      ready: true,
    })

    useSurfaceStore.getState().activateScope(runtimeA)
    expect(useSurfaceStore.getState()).toMatchObject({
      kind: 'android',
      isMobile: true,
      isNative: true,
      ready: true,
    })

    useSurfaceStore.getState().reset(runtimeA)
    expect(selectSurfaceScope(runtimeA)(useSurfaceStore.getState())).toMatchObject({
      kind: 'unknown',
      isMobile: false,
      isNative: false,
      ready: false,
    })
    expect(selectSurfaceScope(runtimeB)(useSurfaceStore.getState())).toMatchObject({
      kind: 'desktop-tauri',
      isMobile: false,
      isNative: true,
      ready: true,
    })

    useSurfaceStore.getState().reset()
  })
})
