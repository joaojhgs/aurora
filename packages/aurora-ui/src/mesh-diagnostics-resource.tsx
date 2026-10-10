'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { GatewaySupportBundleResponse } from '@aurora/client'
import { AuroraQueryProvider, AURORA_QUERY_STALE_TIMES, useAuroraClient, useAuroraQueryScope } from './query'
import { useAuroraQueryFallbackInterval, useAuroraQueryKeys } from './query-hooks'
import {
  MeshDiagnosticsView,
  canReadMeshDiagnosticsRoute,
  loadingMeshDiagnosticsSnapshot,
  buildMeshDiagnosticsSnapshot,
  meshDiagnosticsAccessSnapshot,
  reconcileMeshDiagnosticsWithThinPeer,
  type SupportBundleExportState
} from './mesh-diagnostics-view'
import type { MeshDiagnosticsResourceProps } from './mesh-diagnostics-view'
import type { RouteAvailability } from './shell-data'
import type { BrowserWebRtcPeerController } from './web-thin-runtime'
import { useThinPeerDiagnosticsProjection } from './thin-peer-diagnostics'

export function MeshDiagnosticsResource({ client, route, thinPeer }: MeshDiagnosticsResourceProps) {
  const hasQueryScope = useAuroraQueryScope()
  if (!hasQueryScope) {
    return (
      <AuroraQueryProvider client={client} queryScope={meshDiagnosticsQueryScope(thinPeer)}>
        <MeshDiagnosticsResourceContent route={route} {...(thinPeer ? { thinPeer } : {})} />
      </AuroraQueryProvider>
    )
  }
  return <MeshDiagnosticsResourceContent route={route} {...(thinPeer ? { thinPeer } : {})} />
}

function MeshDiagnosticsResourceContent({ route, thinPeer }: Omit<MeshDiagnosticsResourceProps, 'client'>) {
  const client = useAuroraClient()
  const queryKeys = useAuroraQueryKeys()
  const fallbackInterval = useAuroraQueryFallbackInterval({ subscriptionAvailable: false })
  const diagnosticsQueryInput = useMemo(() => meshDiagnosticsQueryInput(route), [route])
  const diagnosticsAccessAllowed = canReadMeshDiagnosticsRoute(route)
  const diagnosticsQueryKey = useMemo(
    () => queryKeys.admin('mesh-diagnostics', diagnosticsQueryInput),
    [diagnosticsQueryInput, queryKeys],
  )
  const diagnosticsScopeKey = useMemo(() => JSON.stringify(diagnosticsQueryKey), [diagnosticsQueryKey])
  const thinPeerProjection = useThinPeerDiagnosticsProjection(thinPeer)
  const [exportState, setExportState] = useState<SupportBundleExportState>({ status: 'idle', message: null })
  const [reauthConfirmation, setReauthConfirmation] = useState<{
    scopeKey: string
    generation: number
    confirmed: boolean
  }>({ scopeKey: '', generation: -1, confirmed: false })
  const activeDiagnosticsScopeRef = useRef({
    scopeKey: diagnosticsScopeKey,
    generation: 0,
    accessAllowed: diagnosticsAccessAllowed,
    mounted: true,
  })
  if (
    activeDiagnosticsScopeRef.current.scopeKey !== diagnosticsScopeKey
    || activeDiagnosticsScopeRef.current.accessAllowed !== diagnosticsAccessAllowed
  ) {
    activeDiagnosticsScopeRef.current = {
      scopeKey: diagnosticsScopeKey,
      generation: activeDiagnosticsScopeRef.current.generation + 1,
      accessAllowed: diagnosticsAccessAllowed,
      mounted: true,
    }
  } else {
    activeDiagnosticsScopeRef.current.mounted = true
  }
  const activeDiagnosticsScope = activeDiagnosticsScopeRef.current
  const reauthConfirmed = diagnosticsAccessAllowed
    && reauthConfirmation.confirmed
    && reauthConfirmation.scopeKey === activeDiagnosticsScope.scopeKey
    && reauthConfirmation.generation === activeDiagnosticsScope.generation

  useEffect(() => {
    setReauthConfirmation({ scopeKey: '', generation: -1, confirmed: false })
    setExportState({ status: 'idle', message: null })
  }, [activeDiagnosticsScope.generation, activeDiagnosticsScope.scopeKey])

  useEffect(() => {
    activeDiagnosticsScopeRef.current.mounted = true
    return () => {
      activeDiagnosticsScopeRef.current = {
        ...activeDiagnosticsScopeRef.current,
        generation: activeDiagnosticsScopeRef.current.generation + 1,
        mounted: false,
      }
    }
  }, [])

  const updateReauthConfirmed = useCallback((confirmed: boolean) => {
    const scope = activeDiagnosticsScopeRef.current
    setReauthConfirmation({
      scopeKey: scope.scopeKey,
      generation: scope.generation,
      confirmed,
    })
  }, [])

  const diagnosticsQuery = useQuery({
    queryKey: diagnosticsQueryKey,
    queryFn: ({ signal }) => buildMeshDiagnosticsSnapshot(client, route, { signal }),
    staleTime: AURORA_QUERY_STALE_TIMES.volatile,
    refetchInterval: diagnosticsAccessAllowed ? fallbackInterval : false,
    enabled: diagnosticsAccessAllowed,
  })

  const routeAccessSnapshot = useMemo(() => meshDiagnosticsAccessSnapshot(route), [route])
  const snapshot = useMemo(() => {
    if (!diagnosticsAccessAllowed) return routeAccessSnapshot
    return reconcileMeshDiagnosticsWithThinPeer(
      diagnosticsQuery.data ?? loadingMeshDiagnosticsSnapshot,
      thinPeerProjection.snapshot,
      diagnosticsQuery.data ?? null,
      thinPeerProjection.latencyMs,
    )
  }, [diagnosticsAccessAllowed, diagnosticsQuery.data, routeAccessSnapshot, thinPeerProjection.latencyMs, thinPeerProjection.snapshot])

  const loadDiagnostics = useCallback(() => {
    if (!diagnosticsAccessAllowed) return
    void diagnosticsQuery.refetch()
  }, [diagnosticsAccessAllowed, diagnosticsQuery])

  const exportSupportBundle = useCallback(async () => {
    const startedScope = { ...activeDiagnosticsScopeRef.current }
    if (!diagnosticsAccessAllowed || !startedScope.accessAllowed || !startedScope.mounted) {
      setReauthConfirmation({ scopeKey: '', generation: -1, confirmed: false })
      setExportState({ status: 'idle', message: null })
      return
    }
    if (!reauthConfirmed) {
      setExportState({ status: 'error', message: 'Confirm recent approval before exporting support data.' })
      return
    }
    setExportState({ status: 'pending', message: 'Preparing support data...' })
    try {
      const result = await client.diagnostics.exportSupportBundle({
        request: { event_limit: 10, audit_limit: 10, include_capability_catalog: true },
        reason: 'Operator requested a redacted diagnostics support bundle from the Aurora UI.',
        reauthConfirmed,
        affectedResources: ['diagnostics.support_bundle', 'diagnostics.redaction_preview', 'diagnostics.audit_receipt']
      })
      if (!isCurrentDiagnosticsExportScope(activeDiagnosticsScopeRef.current, startedScope)) return
      assertSupportBundleRedacted(result.data)
      downloadSupportBundle(result.data)
      setExportState({
        status: 'success',
        message: `Support data exported. Reference ${result.data.correlation_id ?? 'available'}; receipt ${result.confirmation.audit_receipt}.`
      })
      await diagnosticsQuery.refetch()
    } catch (error) {
      if (!isCurrentDiagnosticsExportScope(activeDiagnosticsScopeRef.current, startedScope)) return
      setExportState({ status: 'error', message: error instanceof Error ? 'Support data export failed. Try again.' : 'Support data export failed.' })
    }
  }, [client, diagnosticsAccessAllowed, diagnosticsQuery, reauthConfirmed])

  return (
    <MeshDiagnosticsView
      snapshot={snapshot}
      route={route}
      {...(diagnosticsAccessAllowed ? { onRefresh: loadDiagnostics, onExportSupportBundle: exportSupportBundle } : {})}
      supportBundleExportState={exportState}
      reauthConfirmed={reauthConfirmed}
      onReauthConfirmedChange={updateReauthConfirmed}
    />
  )
}


function isCurrentDiagnosticsExportScope(
  current: { scopeKey: string; generation: number; accessAllowed: boolean; mounted: boolean },
  started: { scopeKey: string; generation: number; accessAllowed: boolean; mounted: boolean }
): boolean {
  return current.mounted
    && current.accessAllowed
    && started.accessAllowed
    && current.scopeKey === started.scopeKey
    && current.generation === started.generation
}

function meshDiagnosticsQueryScope(thinPeer: BrowserWebRtcPeerController | undefined) {
  return { peerId: thinPeer?.snapshot().expectedStablePeerId ?? null }
}

function meshDiagnosticsQueryInput(route: RouteAvailability) {
  return {
    routeId: route.item.id,
    state: route.state,
    disabled: route.disabled,
    routeable: route.routeable,
    selectorRequired: route.selectorRequired,
    approvalRequired: route.approvalRequired,
    requiresAdminAction: route.requiresAdminAction,
  }
}

function assertSupportBundleRedacted(bundle: GatewaySupportBundleResponse) {
  if (bundle.secrets_redacted !== true || bundle.redaction?.secrets_redacted !== true) {
    throw new Error('Support data export failed. Try again.')
  }
}

function downloadSupportBundle(bundle: GatewaySupportBundleResponse) {
  if (typeof document === 'undefined') return
  const payload = JSON.stringify(bundle, null, 2)
  const blob = new Blob([payload], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = supportBundleFilename(bundle)
  try {
    link.click()
  } finally {
    URL.revokeObjectURL(url)
  }
}

function supportBundleFilename(bundle: GatewaySupportBundleResponse): string {
  const generatedAt = safeFilenamePart(bundle.generated_at?.replace(/[.:]/gu, '-'))
  const correlationId = safeFilenamePart(bundle.correlation_id)
  return ['aurora-support-data', generatedAt, correlationId]
    .filter(Boolean)
    .join('-')
    .concat('.json')
}

function safeFilenamePart(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 80)
}
