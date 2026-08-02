'use client'

import { useEffect, useState } from 'react'
import {
  LocalServiceRoutingResource,
  MeshPeersResource,
  RoutePolicyResource,
  ServiceRoutingResource,
  type RouteAvailability,
} from '@aurora/ui'
import {
  useBrowserRoute,
  useBrowserRuntimeProfile,
  useBrowserShellRuntime,
} from '../browser-shell-runtime'

export function MeshPeersClientPage({ route }: { route: RouteAvailability }) {
  const [incomingInvite, setIncomingInvite] = useState<string | null>(null)
  const runtime = useBrowserShellRuntime()
  const runtimeProfile = useBrowserRuntimeProfile()
  const client = runtime.client
  const activeRoute = useBrowserRoute(route)
  const providerStatus = runtime.localNodeProviderStatus

  useEffect(() => {
    const invite = consumeFragmentInviteFromUrl(window.location.href, (nextUrl) => {
      window.history.replaceState(null, '', nextUrl)
    })
    if (invite) setIncomingInvite(invite)
  }, [])

  return (
    <div
      data-local-node-provider={providerStatus.state}
      data-local-node-provider-available={String(providerStatus.available)}
      data-local-data-writable={String(providerStatus.localDataWritable)}
      data-local-feature-count={String(providerStatus.registeredFeatureCount)}
    >
      {providerStatus.state === 'open-in-another-tab'
      || providerStatus.state === 'needs-attention' ? (
        <p className="mb-4 text-sm text-muted-foreground" role="status">
          {providerStatus.productMessage}
        </p>
      ) : null}
      <MeshPeersResource
        client={client}
        route={activeRoute}
        surfaceProfile={runtime.surface}
        thinPeer={runtime.peer}
        initialInviteText={incomingInvite}
        localFeatureSharing={runtime.localFeatureSharing}
        localNode={runtimeProfile?.nodeMode === 'mesh-node'
          ? {
              peerId: runtimeProfile.localNode.stablePeerId,
              nodeName: runtimeProfile.localNode.nodeName,
            }
          : undefined}
      />
      {runtime.surface.canManageLocalServiceConfiguration ? (
        <ServiceRoutingResource
          client={client}
          route={activeRoute}
          thinPeer={runtime.peer}
        />
      ) : runtime.surface.ownsLocalNodeState && runtime.localFeatureSharing ? (
        <LocalServiceRoutingResource
          featureSharing={runtime.localFeatureSharing}
        />
      ) : null}
      {runtime.surface.isRemoteConsole ? (
        <RoutePolicyResource client={client} route={activeRoute} />
      ) : null}
    </div>
  )
}


export function consumeFragmentInviteFromUrl(href: string, replace: (nextUrl: string) => void): string | null {
  const url = new URL(href)
  const params = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash)
  const invite = params.get('invite')
  if (!invite) return null
  params.delete('invite')
  const nextHash = params.toString()
  replace(`${url.pathname}${url.search}${nextHash ? `#${nextHash}` : ''}`)
  return invite
}
