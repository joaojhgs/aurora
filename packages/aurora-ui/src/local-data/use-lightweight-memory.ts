'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  searchLocalData,
  type DeleteExpiredLocalMemoryInput,
  type LightweightMemoryRecord,
  type LocalDataSearchResponse,
  type LocalMemoryItem,
  type UpsertLocalMemoryItemInput
} from '@aurora/client/local-data'

import { localDataProductError, useLocalData } from './local-data-context'

export interface UseLightweightMemoryOptions {
  readonly namespace?: string | undefined
  readonly nowMs?: number | undefined
  readonly limit?: number | undefined
  readonly autoRefresh?: boolean | undefined
}

export interface UseLightweightMemoryResult {
  readonly loading: boolean
  readonly ready: boolean
  readonly error: string | null
  readonly items: LocalMemoryItem[]
  readonly lastSearch: LocalDataSearchResponse | null
  readonly refresh: () => Promise<void>
  readonly search: (query: string) => Promise<void>
  readonly upsertMemoryItem: (record: LightweightMemoryRecord) => Promise<void>
  readonly deleteMemoryItem: (memoryItemId: string) => Promise<void>
  readonly cleanupExpired: (nowMs?: number, limit?: number) => Promise<number>
}

interface MemoryState {
  readonly loading: boolean
  readonly error: string | null
  readonly items: LocalMemoryItem[]
  readonly lastSearch: LocalDataSearchResponse | null
}

export function useLightweightMemory(options: UseLightweightMemoryOptions = {}): UseLightweightMemoryResult {
  const localData = useLocalData()
  const requestId = useRef(0)
  const defaultNowMs = useRef(Date.now())
  const nowMs = options.nowMs ?? defaultNowMs.current
  const limit = options.limit ?? 200
  const [state, setState] = useState<MemoryState>(() => ({
    loading: localData.state === 'opening',
    error: null,
    items: [],
    lastSearch: null
  }))

  const refresh = useCallback(async () => {
    const memory = localData.memory
    if (localData.state !== 'ready' || memory === null) {
      setState((current) => ({
        ...current,
        loading: localData.state === 'opening',
        error: localData.error?.title ?? null,
        items: [],
        lastSearch: null
      }))
      return
    }
    const activeRequest = requestId.current + 1
    requestId.current = activeRequest
    const abortController = new AbortController()
    setState((current) => ({ ...current, loading: true, error: null }))
    try {
      const items = await memory.listMemoryItems({
        scope: localData.scope,
        nowMs,
        limit,
        signal: abortController.signal,
        ...(options.namespace === undefined ? {} : { namespace: options.namespace })
      })
      if (requestId.current !== activeRequest) return
      setState((current) => ({
        ...current,
        loading: false,
        error: null,
        items
      }))
    } catch (error) {
      if (requestId.current !== activeRequest || isAbortError(error)) return
      setState((current) => ({ ...current, loading: false, error: localDataProductError(error).title }))
    }
  }, [localData, options.namespace, nowMs, limit])

  useEffect(() => {
    if (options.autoRefresh === false) return
    void refresh()
    return () => {
      requestId.current += 1
    }
  }, [refresh, options.autoRefresh])

  const mutate = useCallback(async (work: (signal: AbortSignal) => Promise<void>) => {
    const activeRequest = requestId.current + 1
    requestId.current = activeRequest
    const abortController = new AbortController()
    setState((current) => ({ ...current, loading: true, error: null }))
    try {
      await work(abortController.signal)
      if (requestId.current !== activeRequest) return
      await refresh()
    } catch (error) {
      if (requestId.current !== activeRequest || isAbortError(error)) return
      setState((current) => ({ ...current, loading: false, error: localDataProductError(error).title }))
    }
  }, [refresh])

  return {
    loading: state.loading,
    ready: localData.state === 'ready',
    error: state.error,
    items: state.items,
    lastSearch: state.lastSearch,
    refresh,
    search: async (query) => {
      const session = localData.session
      if (session === null) throw new Error('This device memory is unavailable.')
      const activeRequest = requestId.current + 1
      requestId.current = activeRequest
      const abortController = new AbortController()
      setState((current) => ({ ...current, loading: true, error: null }))
      try {
        const lastSearch = await searchLocalData(session, {
          scope: localData.scope,
          query,
        nowMs,
        domains: ['conversations', 'messages', 'memory'],
        limit: 50,
        maxScanRecords: 1_000,
        signal: abortController.signal,
        ...(options.namespace === undefined ? {} : { namespace: options.namespace })
      })
        if (requestId.current !== activeRequest) return
        setState((current) => ({ ...current, loading: false, error: null, lastSearch }))
      } catch (error) {
        if (requestId.current !== activeRequest || isAbortError(error)) return
        setState((current) => ({ ...current, loading: false, error: localDataProductError(error).title }))
      }
    },
    upsertMemoryItem: async (record) => {
      const memory = requireMemory(localData)
      await mutate(async (signal) => {
        const input: UpsertLocalMemoryItemInput = { scope: localData.scope, record, signal }
        await memory.upsertMemoryItem(input)
      })
    },
    deleteMemoryItem: async (memoryItemId) => {
      const memory = requireMemory(localData)
      await mutate(async (signal) => {
        await memory.deleteMemoryItem({ scope: localData.scope, memoryItemId, signal })
      })
    },
    cleanupExpired: async (cleanupNowMs = Date.now(), cleanupLimit = 100) => {
      const memory = requireMemory(localData)
      let deleted = 0
      await mutate(async (signal) => {
        const input: DeleteExpiredLocalMemoryInput = {
          scope: localData.scope,
          nowMs: cleanupNowMs,
          limit: cleanupLimit,
          signal
        }
        const result = await memory.deleteExpiredMemoryItems(input)
        deleted = result.deleted
      })
      return deleted
    }
  }
}

function requireMemory(localData: ReturnType<typeof useLocalData>) {
  if (localData.memory === null) throw new Error('This device memory is unavailable.')
  return localData.memory
}

function isAbortError(error: unknown): boolean {
  return typeof DOMException !== 'undefined'
    && error instanceof DOMException
    && error.name === 'AbortError'
}
