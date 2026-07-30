'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import {
  createLocalConversations,
  createLocalLightweightMemory,
  type LocalDataBackend,
  type LocalDataBackendStatus,
  type LocalDataSession
} from '@aurora/client/local-data'

import { createLocalDataBackend } from './create-local-data-backend'
import {
  LocalDataContext,
  localDataErrorCode,
  localDataProductError,
  type LocalDataProductError,
  type LocalDataProviderState,
  type LocalDataProviderValue
} from './local-data-context'
import {
  describeBrowserStorageHealth,
  type BrowserStorageHealth,
  type BrowserStorageInternalState
} from './storage-health'

export {
  localDataProductError,
  useLocalData,
  useOptionalLocalData,
  type LocalDataProductError,
  type LocalDataProviderState,
  type LocalDataProviderValue
} from './local-data-context'

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
