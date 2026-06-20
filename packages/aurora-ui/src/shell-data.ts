import type {
  AuroraClient,
  AuroraError,
  AvailabilityState,
  CapabilityCatalogResponse,
  CapabilitySummary,
  NativeCapabilityManifest
} from '@aurora/client'
import { auroraNavSections, navItemSnapshot, type AuroraNavItem, type AuroraNavItemSnapshot } from './nav'

export type ShellLoadState = 'loading' | 'ready' | 'error'

export interface RouteAvailability {
  item: AuroraNavItemSnapshot
  state: AvailabilityState
  explanation: string
  providerLabel: string
  blockers: string[]
  disabled: boolean
  requiresAdminAction: boolean
}

export interface AuroraShellSnapshot {
  loadState: ShellLoadState
  nodeName: string
  localPeerId: string | null
  transportKind: string
  evidenceSource: string
  generatedAt: string | null
  secretsRedacted: boolean
  routeCount: number
  availableCount: number
  blockedCount: number
  nativePlatform: string
  nativeAvailable: boolean
  routes: RouteAvailability[]
  error: string | null
}

export const loadingShellSnapshot: AuroraShellSnapshot = {
  loadState: 'loading',
  nodeName: 'Loading Aurora',
  localPeerId: null,
  transportKind: 'pending',
  evidenceSource: 'pending SDK request',
  generatedAt: null,
  secretsRedacted: true,
  routeCount: 0,
  availableCount: 0,
  blockedCount: 0,
  nativePlatform: 'unknown',
  nativeAvailable: false,
  routes: [],
  error: null
}

export async function buildShellSnapshot(client: AuroraClient): Promise<AuroraShellSnapshot> {
  try {
    const [catalog, summaries, native] = await Promise.all([
      client.capabilities.listCatalog({ include_unavailable: true, include_internal: true }),
      client.capabilities.listSummaries({ include_unavailable: true, include_internal: true }),
      client.native.getManifest().catch(() => null)
    ])
    return snapshotFromCatalog(client.transport.kind, catalog, summaries, native)
  } catch (error) {
    return errorShellSnapshot(client.transport.kind, error)
  }
}

export function snapshotFromCatalog(
  transportKind: string,
  catalog: CapabilityCatalogResponse,
  summaries: CapabilitySummary[],
  native: NativeCapabilityManifest | null
): AuroraShellSnapshot {
  const routes = auroraNavSections.flatMap((section) =>
    section.items.map((item) => routeAvailability(item, summaries))
  )
  return {
    loadState: 'ready',
    nodeName: catalog.local_node_name || 'Aurora node',
    localPeerId: catalog.local_peer_id,
    transportKind,
    evidenceSource: transportKind === 'mock' ? 'SDK mock transport fixture' : 'AuroraClient backend response',
    generatedAt: catalog.generated_at,
    secretsRedacted: catalog.secrets_redacted,
    routeCount: routes.length,
    availableCount: routes.filter((route) => !route.disabled).length,
    blockedCount: routes.filter((route) => route.disabled).length,
    nativePlatform: native?.platform ?? 'not available',
    nativeAvailable: native !== null,
    routes,
    error: null
  }
}

export function errorShellSnapshot(transportKind: string, error: unknown): AuroraShellSnapshot {
  const routes = auroraNavSections.flatMap((section) =>
    section.items.map((item) => ({
      item: navItemSnapshot(item),
      state: 'unsupported' as const,
      explanation: 'Capability state could not be loaded from AuroraClient.',
      providerLabel: 'No backend evidence',
      blockers: ['sdk_error'],
      disabled: true,
      requiresAdminAction: item.methodType === 'manage'
    }))
  )
  return {
    ...loadingShellSnapshot,
    loadState: 'error',
    nodeName: 'Aurora unavailable',
    transportKind,
    evidenceSource: 'AuroraClient error',
    routeCount: routes.length,
    blockedCount: routes.length,
    error: errorMessage(error),
    routes
  }
}

function routeAvailability(item: AuroraNavItem, summaries: CapabilitySummary[]): RouteAvailability {
  const match = summaries.find((summary) =>
    summary.module === item.capabilityModule &&
    (!item.capabilityMethod || summary.method === item.capabilityMethod)
  )
  const state = match?.availability ?? item.fallbackState
  const disabled = !['available-local', 'available-remote', 'degraded', 'pending'].includes(state)
  return {
    item: navItemSnapshot(item),
    state,
    explanation: routeExplanation(state, match),
    providerLabel: match ? providerLabel(match) : `${item.expectedTask} pending`,
    blockers: match?.routeBlockers ?? ['capability_not_advertised'],
    disabled,
    requiresAdminAction: item.methodType === 'manage'
  }
}

function routeExplanation(state: AvailabilityState, summary: CapabilitySummary | undefined): string {
  if (!summary) return 'No executable capability catalog entry exists yet; the route stays visible with a repair task.'
  if (state === 'available-local') return 'Backend catalog reports a local provider that can serve this route.'
  if (state === 'available-remote') return 'Backend catalog reports a remote provider; target identity must remain visible.'
  if (state === 'degraded') return 'The route is partially usable with backend-reported limitations.'
  if (state === 'pending') return 'The route is waiting on pairing, approval, consent, or an in-flight backend correlation.'
  if (state === 'denied') return 'Backend policy denied this route for the current principal or peer.'
  if (state === 'stale') return 'Provider evidence is stale and cannot be used for execution.'
  if (state === 'privacy-blocked') return 'A selector, consent, privacy indicator, or approval is required before use.'
  return 'The route is unsupported in this backend or deployment mode.'
}

function providerLabel(summary: CapabilitySummary): string {
  const location = summary.raw.provider_kind === 'local' ? 'local' : `remote ${summary.peerId}`
  return `${location} / ${summary.module}.${summary.method}`
}

function errorMessage(error: unknown): string {
  const maybe = error as Partial<AuroraError>
  return maybe.message ?? (error instanceof Error ? error.message : 'Unknown SDK error')
}
