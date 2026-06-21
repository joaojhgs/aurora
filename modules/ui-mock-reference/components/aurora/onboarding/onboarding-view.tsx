'use client'

import { CheckCircle2, Cloud, Compass, Laptop, Network, Rocket, Smartphone, WifiOff } from 'lucide-react'
import { PageHeader } from '@/components/aurora/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { CapabilityStateBadge, PrivacyBadge, RouteBadge } from '@/components/aurora/status-badges'

const modes = [
  { title: 'Server Web', icon: Cloud, route: 'Remote' as const, status: 'available' as const, detail: 'Connect to an HTTP Gateway deployment and manage assistant/admin remotely.' },
  { title: 'Desktop Local', icon: Laptop, route: 'Local' as const, status: 'available' as const, detail: 'Tauri starts the local Aurora Python node through sidecar/loopback/IPC.' },
  { title: 'Mesh Shell', icon: Network, route: 'Mesh Peer' as const, status: 'needs_pairing' as const, detail: 'Pair with trusted peers and route only through peer capabilities.' },
  { title: 'Mobile Thin', icon: Smartphone, route: 'Native Mobile' as const, status: 'degraded' as const, detail: 'Android/iOS shell with native permissions and server/mesh transport first.' },
  { title: 'Offline Demo', icon: WifiOff, route: 'Fallback' as const, status: 'available' as const, detail: 'Fixture-only exploration for Lovable/PoC review.' },
]

const setupSteps = [
  ['Select mode', 'Choose server, local, mesh, mobile or demo'],
  ['Authenticate / pair', 'Sign in, enter pairing code or load local owner identity'],
  ['Load capability graph', 'Registry + native + peer manifest drive every screen'],
  ['Review privacy defaults', 'Confirm local-first, remote fallback and mesh policy'],
  ['Land in cockpit', 'Assistant and Admin share the same shell'],
]

export function OnboardingView() {
  return (
    <div>
      <PageHeader title="Onboarding" description="First-launch mode selection and setup flows for server, desktop local, mesh, Android and iOS." actions={<Button><Rocket className="size-4" />Start guided setup</Button>} />
      <div className="space-y-6 p-4 sm:p-6">
        <div className="grid gap-4 lg:grid-cols-5">
          {modes.map((mode) => { const Icon = mode.icon; return <Card key={mode.title} className="transition-colors hover:bg-accent/30"><CardHeader><div className="flex items-center justify-between"><span className="rounded-lg bg-primary/10 p-2 text-primary"><Icon className="size-4" /></span><CapabilityStateBadge state={mode.status} /></div><CardTitle className="text-base">{mode.title}</CardTitle></CardHeader><CardContent className="space-y-3 text-sm text-muted-foreground"><p>{mode.detail}</p><RouteBadge route={mode.route} className="px-1.5 py-0" /></CardContent></Card> })}
        </div>

        <div className="grid gap-6 lg:grid-cols-[1.2fr_.8fr]">
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Compass className="size-4 text-primary" />Guided setup path</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              {setupSteps.map(([title, detail], index) => <div key={title} className="flex gap-3"><span className="flex size-7 shrink-0 items-center justify-center rounded-full border bg-muted text-xs font-semibold">{index + 1}</span><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><p className="font-medium">{title}</p>{index < 2 && <CheckCircle2 className="size-4 text-success" />}</div><p className="text-sm text-muted-foreground">{detail}</p>{index === 2 && <Progress value={62} className="mt-2" />}</div></div>)}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Mobile first-launch copy</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="rounded-lg border p-3"><p className="font-medium">Android</p><p className="text-muted-foreground">Aurora can request Android assistant role only when package qualification, OS availability and user/OEM grant allow it. Fallbacks stay visible.</p></div>
              <div className="rounded-lg border p-3"><p className="font-medium">iOS</p><p className="text-muted-foreground">Aurora integrates through App Intents, Shortcuts, widgets, share sheet and deep links. It does not replace Siri.</p></div>
              <div className="flex flex-wrap gap-2"><PrivacyBadge privacy="raw-audio" /><PrivacyBadge privacy="credential" /></div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
