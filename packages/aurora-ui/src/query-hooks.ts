'use client'

import { useMemo } from 'react'
import { useQuery, type QueryClient, type QueryKey, type UseQueryOptions, type UseQueryResult } from '@tanstack/react-query'
import type { AuroraClient, AuroraError, CapabilityCatalogRequest, CapabilityCatalogResponse, CapabilityGraph, GetServicesResponse, NativeCapabilityManifest, ToolCatalogResponse } from '@aurora/client'
import { selectConnectionScopeId, selectConnectionState, useConnectionStore, type AuroraConnectionState } from './state/connection-store'
import { AURORA_QUERY_FALLBACK_INTERVAL_MS, AURORA_QUERY_STALE_TIMES, isAuroraTerminalQueryData, isAuroraTerminalQueryError, useAuroraClient, useAuroraQueryScopeKey, type AuroraQueryScopeKey } from './query'
import { errorShellSnapshot, snapshotFromGraph, type AuroraShellSnapshot } from './shell-data'

export function createAuroraQueryKeys(scope: AuroraQueryScopeKey) {
  return {
    root: () => scope,
    capabilities: (request: CapabilityCatalogRequest = {}) => [...scope, 'capabilities', request] as const,
    capabilityGraph: (request: CapabilityCatalogRequest = {}) => [...scope, 'capability-graph', request] as const,
    services: () => [...scope, 'services'] as const,
    toolCatalog: (request: Record<string, unknown> = {}) => [...scope, 'tool-catalog', request] as const,
    admin: (resource: string, request: unknown = {}) => [...scope, 'admin', resource, request] as const,
    conversations: (conversationScope = 'default') => [...scope, 'conversations', conversationScope] as const,
    conversation: (conversationId: string) => [...scope, 'conversation', conversationId] as const,
    backups: (request: unknown = {}) => [...scope, 'backups', request] as const
  } as const
}

export const auroraQueryKeys = createAuroraQueryKeys(['aurora', 'unscoped'])

export function useAuroraQueryKeys(): ReturnType<typeof createAuroraQueryKeys> {
  const scopeKey = useAuroraQueryScopeKey()
  return useMemo(() => createAuroraQueryKeys(scopeKey), [scopeKey])
}

type QueryOptions<TData, TQueryKey extends QueryKey> = Omit<UseQueryOptions<TData, AuroraError, TData, TQueryKey>, 'queryKey' | 'queryFn'>

export interface AuroraQueryFallbackOptions {
  /**
   * Set to false only for resource families that do not have an authoritative
   * subscription yet. The current confirmed SDK/backend stream families are:
   * assistant (`Orchestrator.Response`, `TTS.AudioChunk`), health
   * (`Gateway.StatusChanged`, filtered by service kind), and config
   * (`Gateway.StatusChanged`, filtered by config kind).
   * Pairing, mesh roster, and mesh diagnostics have query routes but no
   * confirmed resource event emitter, so those stay on explicit bounded
   * fallback polling until their backend event contracts exist.
   */
  subscriptionAvailable?: boolean
}

interface AuroraRefetchIntervalQueryState {
  state?: {
    data?: unknown
    error?: unknown
  }
}

export type AuroraQueryFallbackInterval = (query?: AuroraRefetchIntervalQueryState) => number | false

export function auroraQueryFallbackIntervalForConnectionState(
  state: AuroraConnectionState,
  options: AuroraQueryFallbackOptions = {},
  error?: unknown
): number | false {
  if (isAuroraTerminalQueryError(error)) return false
  if (options.subscriptionAvailable === false) return AURORA_QUERY_FALLBACK_INTERVAL_MS
  return state === 'connected' ? false : AURORA_QUERY_FALLBACK_INTERVAL_MS
}

export function auroraQueryFallbackInterval(options: AuroraQueryFallbackOptions = {}, error?: unknown): number | false {
  return auroraQueryFallbackIntervalForConnectionState(useConnectionStore.getState().state, options, error)
}

export function useAuroraQueryFallbackInterval(options: AuroraQueryFallbackOptions = {}): AuroraQueryFallbackInterval {
  const scopeKey = useAuroraQueryScopeKey()
  const state = useConnectionStore(selectConnectionState)
  const connectionScopeId = useConnectionStore(selectConnectionScopeId)
  return useMemo(() => {
    return (query?: AuroraRefetchIntervalQueryState) => {
      const error = query?.state?.error
      const data = query?.state?.data
      if (isAuroraTerminalQueryData(data)) return false
      if (isAuroraTerminalQueryError(error)) return false
      if (connectionScopeId !== null && connectionScopeId !== scopeKey[1]) return AURORA_QUERY_FALLBACK_INTERVAL_MS
      return auroraQueryFallbackIntervalForConnectionState(state, options, error)
    }
  }, [connectionScopeId, options.subscriptionAvailable, scopeKey, state])
}


export interface FetchAuroraShellSnapshotOptions {
  client: AuroraClient
  queryClient: QueryClient
  scopeKey: AuroraQueryScopeKey
  forceRefresh?: boolean
  nativeManifest?: ((signal?: AbortSignal) => Promise<NativeCapabilityManifest>) | undefined
  signal?: AbortSignal | undefined
}

export async function fetchAuroraShellSnapshot({
  client,
  queryClient,
  scopeKey,
  forceRefresh = false,
  nativeManifest,
  signal,
}: FetchAuroraShellSnapshotOptions): Promise<AuroraShellSnapshot> {
  const request: CapabilityCatalogRequest = { include_unavailable: true, include_internal: true }
  const queryKeys = createAuroraQueryKeys(scopeKey)

  try {
    if (signal?.aborted) throw shellSnapshotAbortError()
    const [graph, native] = await Promise.all([
      queryClient.fetchQuery({
        queryKey: queryKeys.capabilityGraph(request),
        queryFn: ({ signal: querySignal }) => client.capabilities.getGraph(request, { signal: signal ?? querySignal }),
        staleTime: forceRefresh ? 0 : AURORA_QUERY_STALE_TIMES.capabilities,
      }),
      fetchNativeManifestForShellSnapshot(client, nativeManifest, signal),
    ])
    if (signal?.aborted) throw shellSnapshotAbortError()
    return snapshotFromGraph(client.transport.kind, graph, native)
  } catch (error) {
    if (signal?.aborted) throw error
    return errorShellSnapshot(client.transport.kind, error)
  }
}


async function fetchNativeManifestForShellSnapshot(
  client: AuroraClient,
  nativeManifest: ((signal?: AbortSignal) => Promise<NativeCapabilityManifest>) | undefined,
  signal: AbortSignal | undefined
): Promise<NativeCapabilityManifest | null> {
  try {
    const read = nativeManifest?.(signal) ?? client.native.getManifest()
    return await abortAwareShellSnapshotPromise(read, signal)
  } catch (error) {
    if (signal?.aborted) throw shellSnapshotAbortError()
    return null
  }
}

function abortAwareShellSnapshotPromise<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const settle = (callback: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      callback()
    }
    const onAbort = () => settle(() => reject(shellSnapshotAbortError()))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error))
    )
    if (signal.aborted) onAbort()
  })
}

function shellSnapshotAbortError(): DOMException {
  return new DOMException('Shell snapshot request was cancelled', 'AbortError')
}

export function useCapabilities(
  request: CapabilityCatalogRequest = {},
  options: QueryOptions<CapabilityCatalogResponse, ReturnType<ReturnType<typeof createAuroraQueryKeys>['capabilities']>> = {}
): UseQueryResult<CapabilityCatalogResponse, AuroraError> {
  const client = useAuroraClient()
  const queryKeys = useAuroraQueryKeys()
  const fallbackInterval = useAuroraQueryFallbackInterval()
  return useQuery({
    queryKey: queryKeys.capabilities(request),
    queryFn: ({ signal }) => client.capabilities.listCatalog(request, { signal }),
    staleTime: AURORA_QUERY_STALE_TIMES.capabilities,
    refetchInterval: fallbackInterval,
    ...options
  })
}

export function useCapabilityGraph(
  request: CapabilityCatalogRequest = {},
  options: QueryOptions<CapabilityGraph, ReturnType<ReturnType<typeof createAuroraQueryKeys>['capabilityGraph']>> = {}
): UseQueryResult<CapabilityGraph, AuroraError> {
  const client = useAuroraClient()
  const queryKeys = useAuroraQueryKeys()
  const fallbackInterval = useAuroraQueryFallbackInterval()
  return useQuery({
    queryKey: queryKeys.capabilityGraph(request),
    queryFn: ({ signal }) => client.capabilities.getGraph(request, { signal }),
    staleTime: AURORA_QUERY_STALE_TIMES.capabilities,
    refetchInterval: fallbackInterval,
    ...options
  })
}

export function useServices(options: QueryOptions<GetServicesResponse, ReturnType<ReturnType<typeof createAuroraQueryKeys>['services']>> = {}) {
  const client = useAuroraClient()
  const queryKeys = useAuroraQueryKeys()
  const fallbackInterval = useAuroraQueryFallbackInterval()
  return useQuery({
    queryKey: queryKeys.services(),
    queryFn: ({ signal }) => client.registry.listServices({ signal }),
    staleTime: AURORA_QUERY_STALE_TIMES.lists,
    refetchInterval: fallbackInterval,
    ...options
  })
}

export function useToolCatalog(
  request: Record<string, unknown> = {},
  options: QueryOptions<ToolCatalogResponse, ReturnType<ReturnType<typeof createAuroraQueryKeys>['toolCatalog']>> = {}
) {
  const client = useAuroraClient()
  const queryKeys = useAuroraQueryKeys()
  const fallbackInterval = useAuroraQueryFallbackInterval({ subscriptionAvailable: false })
  return useQuery({
    queryKey: queryKeys.toolCatalog(request),
    queryFn: ({ signal }) => client.tools.listCatalog<ToolCatalogResponse>(request, { signal }),
    staleTime: AURORA_QUERY_STALE_TIMES.lists,
    refetchInterval: fallbackInterval,
    ...options
  })
}

export interface AdminListQuery<TData, TRequest = unknown> {
  resource: string
  request?: TRequest
  queryFn: (client: AuroraClient, request: TRequest, signal: AbortSignal) => Promise<TData>
  options?: QueryOptions<TData, ReturnType<ReturnType<typeof createAuroraQueryKeys>['admin']>>
}

export function useAdminList<TData, TRequest = unknown>({ resource, request, queryFn, options }: AdminListQuery<TData, TRequest>) {
  const client = useAuroraClient()
  const queryKeys = useAuroraQueryKeys()
  const fallbackInterval = useAuroraQueryFallbackInterval({ subscriptionAvailable: false })
  const resolvedRequest = request as TRequest
  return useQuery({
    queryKey: queryKeys.admin(resource, resolvedRequest),
    queryFn: ({ signal }) => queryFn(client, resolvedRequest, signal),
    staleTime: AURORA_QUERY_STALE_TIMES.lists,
    refetchInterval: fallbackInterval,
    ...options
  })
}

export function useConversations<TData>(
  conversationScope: string,
  queryFn: (client: AuroraClient, signal: AbortSignal) => Promise<TData>,
  options: QueryOptions<TData, ReturnType<ReturnType<typeof createAuroraQueryKeys>['conversations']>> = {}
) {
  const client = useAuroraClient()
  const queryKeys = useAuroraQueryKeys()
  const fallbackInterval = useAuroraQueryFallbackInterval({ subscriptionAvailable: false })
  return useQuery({
    queryKey: queryKeys.conversations(conversationScope),
    queryFn: ({ signal }) => queryFn(client, signal),
    staleTime: AURORA_QUERY_STALE_TIMES.lists,
    refetchInterval: fallbackInterval,
    ...options
  })
}

export function useConversation<TData>(
  conversationId: string,
  queryFn: (client: AuroraClient, conversationId: string, signal: AbortSignal) => Promise<TData>,
  options: QueryOptions<TData, ReturnType<ReturnType<typeof createAuroraQueryKeys>['conversation']>> = {}
) {
  const client = useAuroraClient()
  const queryKeys = useAuroraQueryKeys()
  const fallbackInterval = useAuroraQueryFallbackInterval({ subscriptionAvailable: false })
  return useQuery({
    queryKey: queryKeys.conversation(conversationId),
    enabled: conversationId.length > 0 && (options.enabled ?? true),
    queryFn: ({ signal }) => queryFn(client, conversationId, signal),
    staleTime: AURORA_QUERY_STALE_TIMES.lists,
    refetchInterval: fallbackInterval,
    ...options
  })
}

export function useBackups<TData, TRequest = unknown>(
  request: TRequest,
  queryFn: (client: AuroraClient, request: TRequest, signal: AbortSignal) => Promise<TData>,
  options: QueryOptions<TData, ReturnType<ReturnType<typeof createAuroraQueryKeys>['backups']>> = {}
) {
  const client = useAuroraClient()
  const queryKeys = useAuroraQueryKeys()
  const fallbackInterval = useAuroraQueryFallbackInterval({ subscriptionAvailable: false })
  return useQuery({
    queryKey: queryKeys.backups(request),
    queryFn: ({ signal }) => queryFn(client, request, signal),
    staleTime: AURORA_QUERY_STALE_TIMES.lists,
    refetchInterval: fallbackInterval,
    ...options
  })
}
