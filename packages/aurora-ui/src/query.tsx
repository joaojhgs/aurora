'use client'

import { QueryClient, QueryClientProvider, type QueryClientConfig } from '@tanstack/react-query'
import type { AuroraClient } from '@aurora/client'
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import type { AuroraSurfaceProfile } from './platform-surface'
import { useAssistantStreamStore } from './state/assistant-stream-store'
import { useSurfaceStore } from './state/surface-store'

export const AURORA_QUERY_STALE_TIMES = {
  capabilities: 5 * 60_000,
  lists: 30_000,
  volatile: 0
} as const

export const AURORA_QUERY_FALLBACK_INTERVAL_MS = 15_000

export type AuroraQueryScopeKey = readonly ['aurora', string]

export interface AuroraQueryScopeInput {
  backend?: string | null
  peerId?: string | null
  profileId?: string | null
}

const clientScopeInputs = new WeakMap<AuroraClient, AuroraQueryScopeInput>()
const clientScopeIds = new WeakMap<AuroraClient, Map<string, string>>()
let nextScopeOrdinal = 0

interface AuroraQueryAuthSnapshot {
  state?: string | null
  principalId?: string | null
  deviceId?: string | null
  peerId?: string | null
  credentialKind?: string | null
  source?: string | null
  tokenExpiresAt?: string | null
  status?: number | null
  isAdmin?: boolean | null
  effectivePermissions?: string[] | null
}

export function auroraQueryRetry(failureCount: number, error: unknown): boolean {
  if (isAuroraTerminalQueryError(error)) return false
  if (isAuroraTransportQueryError(error)) return failureCount < 2
  return failureCount < 1
}

export function isAuroraTerminalQueryError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined
  return isAuroraTerminalQueryCode(code)
}

export function isAuroraTerminalQueryData(data: unknown): boolean {
  if (isAuroraTerminalQueryError(data)) return true
  if (data === null || typeof data !== 'object') return false

  const record = data as Record<string, unknown>
  if (isAuroraTerminalQueryState(record.loadState) || isAuroraTerminalQueryState(record.state)) return true
  if ('queryFailure' in record) return isAuroraTerminalQueryFailure(record.queryFailure)
  return false
}

export function isAuroraTerminalQueryFailure(failure: unknown): boolean {
  if (isAuroraTerminalQueryError(failure)) return true
  if (failure === null || typeof failure !== 'object') return false

  const record = failure as Record<string, unknown>
  return isAuroraTerminalQueryCode(record.code)
    || isAuroraTerminalQueryCode(record.errorCode)
    || isAuroraTerminalQueryCode(record.error_code)
    || isAuroraTerminalQueryState(record.state)
}

function isAuroraTerminalQueryCode(code: unknown): boolean {
  return code === 'auth'
    || code === 'permission'
    || code === 'permission_denied'
    || code === 'validation'
    || code === 'unsupported_feature'
    || code === 'privacy_blocked'
    || code === 'native_permission_missing'
}

function isAuroraTerminalQueryState(state: unknown): boolean {
  return state === 'denied'
    || state === 'privacy_blocked'
    || state === 'privacy-blocked'
    || state === 'native_permission_missing'
    || state === 'native-permission-missing'
}

function isAuroraTransportQueryError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined
  return code === 'timeout' || code === 'transport_loss' || code === 'unavailable_service'
}

export function createAuroraQueryClient(config: QueryClientConfig = {}, options: { isMobile?: boolean } = {}): QueryClient {
  return new QueryClient({
    ...config,
    defaultOptions: auroraQueryDefaultOptions(config, options)
  })
}

let browserQueryClient: QueryClient | undefined

export function getAuroraQueryClient(options: { isMobile?: boolean } = {}): QueryClient {
  // Server requests must never share cached user data. In the browser, keep
  // the client across initial renders that suspend before a provider mounts.
  if (typeof window === 'undefined') return createAuroraQueryClient({}, options)
  browserQueryClient ??= createAuroraQueryClient({}, options)
  return browserQueryClient
}

function auroraQueryDefaultOptions(config: QueryClientConfig, options: { isMobile?: boolean }) {
  return {
    ...(config.defaultOptions ?? {}),
    queries: {
      staleTime: AURORA_QUERY_STALE_TIMES.lists,
      refetchOnWindowFocus: options.isMobile ? false : true,
      retry: auroraQueryRetry,
      ...(config.defaultOptions?.queries ?? {})
    }
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

function scopeValue(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : fallback
}

function normalizedPermissions(permissions: string[] | null | undefined): string[] {
  if (!Array.isArray(permissions)) return []
  return [...new Set(permissions.filter((permission) => typeof permission === 'string' && permission.length > 0))].sort()
}

function auroraAuthScopeIdentity(authSnapshot: AuroraQueryAuthSnapshot): Record<string, unknown> {
  return {
    authState: scopeValue(authSnapshot.state, 'anonymous'),
    principal: scopeValue(authSnapshot.principalId, 'principal:none'),
    device: scopeValue(authSnapshot.deviceId, 'device:none'),
    peer: scopeValue(authSnapshot.peerId, 'peer:none'),
    credential: scopeValue(authSnapshot.credentialKind, 'credential:none'),
    source: scopeValue(authSnapshot.source, 'source:none'),
    tokenExpiresAt: scopeValue(authSnapshot.tokenExpiresAt, 'token:none'),
    status: authSnapshot.status ?? null,
    isAdmin: authSnapshot.isAdmin ?? null,
    effectivePermissions: normalizedPermissions(authSnapshot.effectivePermissions)
  }
}

function allocateAuroraScopeId(client: AuroraClient, identity: unknown): string {
  const key = stableStringify(identity)
  let ids = clientScopeIds.get(client)
  if (!ids) {
    ids = new Map()
    clientScopeIds.set(client, ids)
  }
  const existing = ids.get(key)
  if (existing) return existing
  nextScopeOrdinal += 1
  const next = `scope:${nextScopeOrdinal.toString(36)}`
  ids.set(key, next)
  return next
}

function resolvedQueryScopeInput(client: AuroraClient, input: AuroraQueryScopeInput = {}): AuroraQueryScopeInput {
  if (input.backend !== undefined || input.peerId !== undefined || input.profileId !== undefined) return input
  return clientScopeInputs.get(client) ?? input
}

export function createAuroraQueryScopeId(
  client: AuroraClient,
  input: AuroraQueryScopeInput = {},
  authSnapshot: AuroraQueryAuthSnapshot = client.auth.snapshot()
): string {
  const resolvedInput = resolvedQueryScopeInput(client, input)
  return allocateAuroraScopeId(client, {
    backend: scopeValue(resolvedInput.backend, scopeValue(client.transport.kind, 'transport:none')),
    profile: scopeValue(resolvedInput.profileId, 'profile:none'),
    peer: scopeValue(resolvedInput.peerId ?? authSnapshot.peerId, 'peer:none'),
    auth: auroraAuthScopeIdentity(authSnapshot)
  })
}

function useAuroraAuthScopeKey(client: AuroraClient): string {
  return useSyncExternalStore(
    (listener) => client.auth.subscribe(() => listener()),
    () => stableStringify(auroraAuthScopeIdentity(client.auth.snapshot())),
    () => stableStringify(auroraAuthScopeIdentity(client.auth.snapshot()))
  )
}

const AuroraClientContext = createContext<AuroraClient | null>(null)
const AuroraQueryScopeContext = createContext(false)
const AuroraQueryScopeKeyContext = createContext<AuroraQueryScopeKey>(['aurora', 'unscoped'])
const AuroraStateScopeIdContext = createContext('unscoped')

const stateScopeRetainers = new Map<string, number>()
const queryScopeRetainers = new WeakMap<QueryClient, Map<string, number>>()

function retainAuroraQueryScope(queryClient: QueryClient, scopeId: string): () => void {
  let scopes = queryScopeRetainers.get(queryClient)
  if (!scopes) {
    scopes = new Map()
    queryScopeRetainers.set(queryClient, scopes)
  }
  scopes.set(scopeId, (scopes.get(scopeId) ?? 0) + 1)
  return () => {
    const remaining = (scopes.get(scopeId) ?? 1) - 1
    if (remaining > 0) {
      scopes.set(scopeId, remaining)
      return
    }
    scopes.delete(scopeId)
    void queryClient.cancelQueries({ queryKey: ['aurora', scopeId] })
    queryClient.removeQueries({ queryKey: ['aurora', scopeId] })
  }
}

function retainAuroraStateScope(scopeId: string): void {
  stateScopeRetainers.set(scopeId, (stateScopeRetainers.get(scopeId) ?? 0) + 1)
}

function releaseAuroraStateScope(scopeId: string): void {
  const nextCount = (stateScopeRetainers.get(scopeId) ?? 0) - 1
  if (nextCount > 0) {
    stateScopeRetainers.set(scopeId, nextCount)
    return
  }

  stateScopeRetainers.delete(scopeId)
  useSurfaceStore.getState().reset(scopeId)
  useAssistantStreamStore.getState().reset(scopeId)
  const remainingScopes = [...stateScopeRetainers.keys()]
  const nextScopeId = remainingScopes[remainingScopes.length - 1] ?? 'default'
  if (useSurfaceStore.getState().activeScopeId === scopeId) {
    useSurfaceStore.getState().activateScope(nextScopeId)
  }
  if (useAssistantStreamStore.getState().activeScopeId === scopeId) {
    useAssistantStreamStore.getState().activateScope(nextScopeId)
  }
}

export interface AuroraQueryProviderProps {
  client: AuroraClient
  surfaceProfile?: AuroraSurfaceProfile | null
  queryClient?: QueryClient
  queryScope?: AuroraQueryScopeInput | null
  children: ReactNode
}

export function AuroraQueryProvider({ client, surfaceProfile = null, queryClient, queryScope = null, children }: AuroraQueryProviderProps) {
  clientScopeInputs.set(client, queryScope ?? {})
  const authScopeKey = useAuroraAuthScopeKey(client)
  const authSnapshot = useMemo(() => client.auth.snapshot(), [authScopeKey, client])
  const scopeId = useMemo(
    () => createAuroraQueryScopeId(client, queryScope ?? {}, authSnapshot),
    [authScopeKey, authSnapshot, client, queryScope?.backend, queryScope?.peerId, queryScope?.profileId]
  )
  const ownedQueryClient = useMemo(
    () => queryClient ?? getAuroraQueryClient({ isMobile: surfaceProfile?.isMobile ?? false }),
    [queryClient]
  )
  const scopeKey = useMemo<AuroraQueryScopeKey>(() => ['aurora', scopeId], [scopeId])

  useEffect(() => {
    const defaults = ownedQueryClient.getDefaultOptions()
    ownedQueryClient.setDefaultOptions({
      ...defaults,
      queries: { ...defaults.queries, refetchOnWindowFocus: !surfaceProfile?.isMobile }
    })
  }, [ownedQueryClient, surfaceProfile?.isMobile])

  useEffect(() => {
    retainAuroraStateScope(scopeId)
    const releaseQueryScope = retainAuroraQueryScope(ownedQueryClient, scopeId)
    useSurfaceStore.getState().activateScope(scopeId)
    useAssistantStreamStore.getState().activateScope(scopeId)

    return () => {
      releaseQueryScope()
      releaseAuroraStateScope(scopeId)
    }
  }, [ownedQueryClient, scopeId])

  return (
    <AuroraClientContext.Provider value={client}>
      <QueryClientProvider client={ownedQueryClient}>
        <AuroraQueryScopeContext.Provider value={true}>
          <AuroraQueryScopeKeyContext.Provider value={scopeKey}>
            <AuroraStateScopeIdContext.Provider value={scopeId}>{children}</AuroraStateScopeIdContext.Provider>
          </AuroraQueryScopeKeyContext.Provider>
        </AuroraQueryScopeContext.Provider>
      </QueryClientProvider>
    </AuroraClientContext.Provider>
  )
}

export function useAuroraQueryScope(): boolean {
  return useContext(AuroraQueryScopeContext)
}

export function useAuroraQueryScopeKey(): AuroraQueryScopeKey {
  return useContext(AuroraQueryScopeKeyContext)
}

export function useAuroraStateScopeId(): string {
  return useContext(AuroraStateScopeIdContext)
}

export function useAuroraClient(): AuroraClient {
  const client = useContext(AuroraClientContext)
  if (!client) throw new Error('useAuroraClient must be used inside AuroraQueryProvider')
  return client
}
