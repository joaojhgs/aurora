'use client'

import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type { AuroraSurfaceKind } from '../runtime-profile'

export type SurfaceStoreScopeId = string

export interface SurfaceSnapshot {
  kind: AuroraSurfaceKind
  isMobile: boolean
  isNative: boolean
  ready: boolean
}

export interface SurfaceStoreScopeOptions {
  scopeId?: SurfaceStoreScopeId | undefined
}

export interface SurfaceStoreState extends SurfaceSnapshot {
  activeScopeId: SurfaceStoreScopeId
  surfaces: Record<SurfaceStoreScopeId, SurfaceSnapshot>
  activateScope: (scopeId: SurfaceStoreScopeId) => void
  setSurface: (
    surface: { kind: AuroraSurfaceKind; isMobile: boolean; isNative: boolean },
    options?: SurfaceStoreScopeOptions,
  ) => void
  reset: (scopeId?: SurfaceStoreScopeId) => void
}

export const defaultSurfaceStoreScopeId = 'default'

const initialSurfaceSnapshot: SurfaceSnapshot = {
  kind: 'unknown',
  isMobile: false,
  isNative: false,
  ready: false,
}

const surfaceSnapshotForScope = (
  surfaces: Record<SurfaceStoreScopeId, SurfaceSnapshot>,
  scopeId: SurfaceStoreScopeId,
): SurfaceSnapshot => surfaces[scopeId] ?? initialSurfaceSnapshot

const surfaceStateForScope = (
  scopeId: SurfaceStoreScopeId,
  surfaces: Record<SurfaceStoreScopeId, SurfaceSnapshot>,
): Pick<SurfaceStoreState, 'activeScopeId' | 'kind' | 'isMobile' | 'isNative' | 'ready'> => ({
  activeScopeId: scopeId,
  ...surfaceSnapshotForScope(surfaces, scopeId),
})

export const useSurfaceStore = create<SurfaceStoreState>()(
  subscribeWithSelector((set) => ({
    ...initialSurfaceSnapshot,
    activeScopeId: defaultSurfaceStoreScopeId,
    surfaces: {
      [defaultSurfaceStoreScopeId]: initialSurfaceSnapshot,
    },
    activateScope: (scopeId) => set((current) => surfaceStateForScope(scopeId, current.surfaces)),
    setSurface: (surface, options) => set((current) => {
      const scopeId = options?.scopeId ?? current.activeScopeId
      const nextSurface: SurfaceSnapshot = { ...surface, ready: true }
      const surfaces = {
        ...current.surfaces,
        [scopeId]: nextSurface,
      }

      if (scopeId !== current.activeScopeId) {
        return { surfaces }
      }

      return {
        surfaces,
        ...nextSurface,
      }
    }),
    reset: (scopeId) => set((current) => {
      if (!scopeId) {
        return {
          ...initialSurfaceSnapshot,
          activeScopeId: defaultSurfaceStoreScopeId,
          surfaces: {
            [defaultSurfaceStoreScopeId]: initialSurfaceSnapshot,
          },
        }
      }

      const surfaces = {
        ...current.surfaces,
        [scopeId]: initialSurfaceSnapshot,
      }

      if (scopeId !== current.activeScopeId) {
        return { surfaces }
      }

      return {
        surfaces,
        ...initialSurfaceSnapshot,
      }
    }),
  })),
)

export const selectSurfaceScope = (scopeId?: SurfaceStoreScopeId) => (state: SurfaceStoreState): SurfaceSnapshot => (
  surfaceSnapshotForScope(state.surfaces, scopeId ?? state.activeScopeId)
)

export const selectSurfaceIsMobile = (state: SurfaceStoreState): boolean => state.isMobile
export const selectSurfaceIsNative = (state: SurfaceStoreState): boolean => state.isNative
