'use client'

import { useEffect, useState } from 'react'
import { MeshPeersResource, RoutePolicyResource, WebThinConnectionPanel, type RouteAvailability } from '@aurora/ui'
import {
  auroraBrowserThinProfile,
  auroraBrowserThinProfileDocument,
  createAuroraBrowserRuntime,
  saveAuroraBrowserThinProfile,
  selectAuroraBrowserThinProfile,
} from '../aurora-client'
import { useBrowserRoute } from '../browser-shell-runtime'

export function MeshPeersClientPage({ route }: { route: RouteAvailability }) {
  const [incomingInvite, setIncomingInvite] = useState<string | null>(null)
  const runtime = createAuroraBrowserRuntime()
  const client = runtime.client
  const activeRoute = useBrowserRoute(route)
  const profile = auroraBrowserThinProfile()
  const document = auroraBrowserThinProfileDocument()

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
        profile={profile}
        profiles={document.profiles}
        profileStoreEvidence="Hosted web keeps nonsecret runtime profile metadata in browser storage and encrypts WebRTC secrets in IndexedDB when available."
        onSaveProfile={async (nextProfile, roomSecret) => {
          await saveAuroraBrowserThinProfile(nextProfile, roomSecret)
          window.location.reload()
        }}
        onSelectProfile={async (profileId) => {
          await selectAuroraBrowserThinProfile(profileId)
          window.location.reload()
        }}
      />
      <MeshPeersResource client={client} route={activeRoute} />
      <RoutePolicyResource client={client} route={activeRoute} />
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
