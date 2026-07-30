'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import {
  createLocalConversations,
  createLocalLightweightMemory,
  LocalDataError,
  type LocalConversationsFacade,
  type LocalDataBackend,
  type LocalDataBackendStatus,
  type LocalDataScope,
  type LocalDataSession,
  type LocalLightweightMemoryFacade
} from '@aurora/client/local-data'

import { createLocalDataBackend } from './create-local-data-backend.js'
import {
  describeBrowserStorageHealth,
  type BrowserStorageHealth,
  type BrowserStorageInternalState
} from './storage-health.js'

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

export interface LocalDataProviderProps {
  readonly profileId: string
  readonly localNodeId: string
  readonly ownerAvailable?: boolean | undefined
  readonly backendFactory?: LocalDataBackendFactory | undefined
  readonly children: ReactNode
}

export type LocalDataBackendFactory = (
  profileId: string,
  localNodeId: string,
) => LocalDataBackend | Promise<LocalDataBackend>

const LocalDataContext = createContext<LocalDataProviderValue | null>(null)

export function LocalDataProvider({
  profileId,
  localNodeId,
  ownerAvailable = true,
  backendFactory = defaultLocalDataBackendFactory,
  children
}: LocalDataProviderProps) {
  const generation = useRef(0)
  const [reloadToken, setReloadToken] = useState(0)
  const [snapshot, setSnapshot] = useState<ProviderSnapshot>(() => openingSnapshot(profileId, localNodeId, ownerAvailable))

  useEffect(() => {
    let closed = false
    let effectBackend: LocalDataBackend | null = null
    const runGeneration = generation.current + 1
    generation.current = runGeneration
    setSnapshot(openingSnapshot(profileId, localNodeId, ownerAvailable))

    void (async () => {
      let backend: LocalDataBackend | null = null
      try {
        backend = await backendFactory(profileId, localNodeId)
        effectBackend = backend
        const session = await backend.open(profileId, localNodeId)
        const status = await backend.status()
        if (closed || generation.current !== runGeneration) {
          await backend.close().catch(() => undefined)
          return
        }
        setSnapshot(readySnapshot(profileId, localNodeId, ownerAvailable, backend, session, status))
      } catch (error) {
        await backend?.close().catch(() => undefined)
        if (closed || generation.current !== runGeneration) return
        setSnapshot(errorSnapshot(profileId, localNodeId, ownerAvailable, error))
      }
    })()

    return () => {
      closed = true
      const active = effectBackend
      if (active) void active.close().catch(() => undefined)
    }
  }, [profileId, localNodeId, ownerAvailable, backendFactory, reloadToken])

  useEffect(() => () => {
    generation.current += 1
  }, [])

  const refreshStorageHealth = useCallback(async () => {
    const backend = snapshot.backend
    if (!backend) return
    const runGeneration = generation.current
    const status = await backend.status()
    if (generation.current !== runGeneration) return
    setSnapshot((current) => current.backend === backend
      ? {
          ...current,
          storageHealth: describeBrowserStorageHealth({
            backend: status,
            ownerAvailable
          })
        }
      : current)
  }, [snapshot.backend, ownerAvailable])

  const value = useMemo<LocalDataProviderValue>(() => ({
    profileId,
    localNodeId,
    scope: { profileId, localNodeId },
    state: snapshot.state,
    session: snapshot.session,
    backend: snapshot.backend,
    conversations: snapshot.session ? createLocalConversations(snapshot.session) : null,
    memory: snapshot.session ? createLocalLightweightMemory(snapshot.session) : null,
    storageHealth: snapshot.storageHealth,
    error: snapshot.error,
    reopen: () => setReloadToken((token) => token + 1),
    refreshStorageHealth
  }), [profileId, localNodeId, snapshot, refreshStorageHealth])

  return <LocalDataContext.Provider value={value}>{children}</LocalDataContext.Provider>
}

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

interface ProviderSnapshot {
  readonly state: LocalDataProviderState
  readonly backend: LocalDataBackend | null
  readonly session: LocalDataSession | null
  readonly storageHealth: BrowserStorageHealth
  readonly error: LocalDataProductError | null
}

async function defaultLocalDataBackendFactory(profileId: string, localNodeId: string): Promise<LocalDataBackend> {
  return await createLocalDataBackend(profileId, localNodeId)
}

function openingSnapshot(profileId: string, localNodeId: string, ownerAvailable: boolean): ProviderSnapshot {
  return {
    state: 'opening',
    backend: null,
    session: null,
    storageHealth: describeBrowserStorageHealth({
      backend: pendingStatus(profileId),
      ownerAvailable,
      internalState: 'ready_memory'
    }),
    error: null
  }
}

function readySnapshot(
  profileId: string,
  localNodeId: string,
  ownerAvailable: boolean,
  backend: LocalDataBackend,
  session: LocalDataSession,
  status: LocalDataBackendStatus,
): ProviderSnapshot {
  const healthBackend = status.profileId === null ? { ...status, profileId, schemaVersion: session.schemaVersion } : status
  return {
    state: 'ready',
    backend,
    session,
    storageHealth: describeBrowserStorageHealth(ownerAvailable
      ? { backend: healthBackend, ownerAvailable }
      : { backend: healthBackend, ownerAvailable, internalState: 'owner_blocked' }),
    error: null
  }
}

function errorSnapshot(profileId: string, localNodeId: string, ownerAvailable: boolean, error: unknown): ProviderSnapshot {
  const productError = localDataProductError(error)
  return {
    state: 'error',
    backend: null,
    session: null,
    storageHealth: describeBrowserStorageHealth({
      backend: pendingStatus(profileId),
      ownerAvailable,
      internalState: internalStateForError(error, ownerAvailable),
      internalReason: productError.code
    }),
    error: productError
  }
}

function pendingStatus(profileId: string): LocalDataBackendStatus {
  return {
    kind: 'memory',
    persistent: false,
    sqlite: false,
    profileId,
    schemaVersion: null,
    migrationState: 'idle'
  }
}

function internalStateForError(error: unknown, ownerAvailable: boolean): BrowserStorageInternalState {
  if (!ownerAvailable) return 'owner_blocked'
  const code = localDataErrorCode(error)
  if (code === 'identity_mismatch' || code === 'memory_session_only') return 'owner_blocked'
  return 'needs_attention'
}

function localDataErrorCode(error: unknown): string | null {
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
