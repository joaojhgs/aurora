'use client'

import { createContext, useContext } from 'react'
import {
  LocalDataError,
  type LocalConversationsFacade,
  type LocalDataBackend,
  type LocalDataScope,
  type LocalDataSession,
  type LocalLightweightMemoryFacade
} from '@aurora/client/local-data'

import type { BrowserStorageHealth } from './storage-health'

export type LocalDataProviderState = 'opening' | 'ready' | 'error'

export interface LocalDataProviderValue {
  readonly profileId: string
  readonly localNodeId: string
  readonly scope: LocalDataScope
  readonly state: LocalDataProviderState
  readonly session: LocalDataSession | null
  readonly backend: LocalDataBackend | null
  readonly conversations: LocalConversationsFacade | null
  readonly memory: LocalLightweightMemoryFacade | null
  readonly storageHealth: BrowserStorageHealth
  readonly error: LocalDataProductError | null
  readonly reopen: () => void
  readonly refreshStorageHealth: () => Promise<void>
}

export interface LocalDataProductError {
  readonly title: string
  readonly detail: string
  readonly retryable: boolean
  readonly code: string
}

export const LocalDataContext = createContext<LocalDataProviderValue | null>(null)

export function useLocalData(): LocalDataProviderValue {
  const value = useContext(LocalDataContext)
  if (value === null) {
    throw new Error('LocalDataProvider is required for local data UI')
  }
  return value
}

export function useOptionalLocalData(): LocalDataProviderValue | null {
  return useContext(LocalDataContext)
}

export function localDataProductError(error: unknown): LocalDataProductError {
  if (isAbortError(error)) {
    return {
      title: 'Action cancelled',
      detail: 'Aurora stopped the local action before saving changes.',
      retryable: true,
      code: 'cancelled'
    }
  }
  const code = localDataErrorCode(error)
  const reason = localDataErrorReason(error)
  if (reason === 'owner_exists' || code === 'memory_session_only') {
    return {
      title: 'Local features are already active in another Aurora window',
      detail: 'Close the other Aurora window or try again here.',
      retryable: true,
      code: code ?? 'owner_exists'
    }
  }
  if (code === 'session_closed') {
    return {
      title: 'Local data needs attention',
      detail: 'Aurora could not safely use recent activity. Try again.',
      retryable: true,
      code
    }
  }
  return {
    title: 'Your existing local data was not changed. Try again.',
    detail: 'Aurora kept recent activity unchanged.',
    retryable: true,
    code: code ?? 'local_data_unavailable'
  }
}

export function localDataErrorCode(error: unknown): string | null {
  if (error instanceof LocalDataError) return error.code
  if (typeof error !== 'object' || error === null) return null
  const code = 'code' in error ? (error as { code?: unknown }).code : null
  return typeof code === 'string' ? code : null
}

function localDataErrorReason(error: unknown): string | null {
  if (error instanceof LocalDataError) return error.metadata?.reason ?? null
  if (typeof error !== 'object' || error === null) return null
  const metadata = 'metadata' in error ? (error as { metadata?: unknown }).metadata : null
  if (typeof metadata !== 'object' || metadata === null) return null
  const reason = 'reason' in metadata ? (metadata as { reason?: unknown }).reason : null
  return typeof reason === 'string' ? reason : null
}

function isAbortError(error: unknown): boolean {
  return typeof DOMException !== 'undefined'
    && error instanceof DOMException
    && error.name === 'AbortError'
}
