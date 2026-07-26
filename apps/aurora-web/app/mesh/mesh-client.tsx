'use client'

import { useEffect, useState } from 'react'
import { MeshPeersResource, RoutePolicyResource, WebThinConnectionPanel, type RouteAvailability } from '@aurora/ui'
import { createAuroraBrowserRuntime } from '../aurora-client'

export function MeshPeersClientPage({ route }: { route: RouteAvailability }) {
  const [incomingInvite, setIncomingInvite] = useState<string | null>(null)
  const runtime = createAuroraBrowserRuntime()
  const client = runtime.client

  useEffect(() => {
    const invite = consumeFragmentInviteFromUrl(window.location.href, (nextUrl) => {
      window.history.replaceState(null, '', nextUrl)
    })
    if (invite) setIncomingInvite(invite)
  }, [])

  return (
    <>
      <WebThinConnectionPanel
        peer={runtime.peer}
        mode={runtime.mode}
        transportKind={client.transport.kind}
        initialInviteText={incomingInvite}
      />
      <MeshPeersResource client={client} route={route} />
      <RoutePolicyResource client={client} route={route} />
    </>
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
