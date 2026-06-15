'use client'

import { useState } from 'react'
import { GitBranch, LockKeyhole, Network, RadioTower, ShieldCheck, Signal, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/aurora/page-header'
import { AdminConfirmDialog, type AdminAction } from '@/components/aurora/admin-confirm-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { meshPeers, routeCandidates } from '@/lib/aurora/data'
import { PrivacyBadge, RouteBadge } from '@/components/aurora/status-badges'

const peerTone: Record<string, string> = {
  approved: 'border-success/30 bg-success/10 text-success',
  pending: 'border-warning/30 bg-warning/10 text-warning',
  denied: 'border-destructive/30 bg-destructive/10 text-destructive',
}

const qualityValue = { excellent: 92, good: 72, poor: 38 }

export function MeshView() {
  const [action, setAction] = useState<AdminAction | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  function approvePeer(name: string) {
    setAction({
      title: `Approve ${name}`,
      description: 'This peer will be able to receive route-previewed assistant work according to its scoped permissions.',
      methodId: 'Auth.MeshApprovePeer',
      severity: 'high',
      affected: [{ type: 'peer', label: name }, { type: 'route-policy', label: 'mesh.route.preview' }],
      diff: [
        { key: 'peer.status', before: 'pending', after: 'approved' },
        { key: 'peer.permissions', before: '[]', after: '[Orchestrator.use, Orchestrator.use]' },
      ],
      requireReason: true,
    })
    setConfirmOpen(true)
  }

  return (
    <div>
      <PageHeader
        title="Mesh & Peers"
        description="Peer trust, route quality, permissions and privacy-first routing decisions."
        actions={<Button variant="outline"><RadioTower className="size-4" />Pair new peer</Button>}
      />
      <div className="space-y-6 p-4 sm:p-6">
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base"><Network className="size-4 text-primary" />Topology</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 sm:grid-cols-3">
                {meshPeers.map((peer) => (
                  <div key={peer.id} className="relative rounded-xl border bg-muted/20 p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div><p className="font-medium">{peer.name}</p><p className="font-mono text-xs text-muted-foreground">{peer.fingerprint}</p></div>
                      <Badge variant="outline" className={`${peerTone[peer.status]} capitalize`}>{peer.status}</Badge>
                    </div>
                    <div className="mt-4 space-y-2">
                      <div className="flex items-center justify-between text-xs"><span className="text-muted-foreground">Route quality</span><span>{peer.routeQuality}</span></div>
                      <Progress value={qualityValue[peer.routeQuality]} />
                      <div className="flex items-center justify-between text-xs text-muted-foreground"><span>{peer.latencyMs}ms</span><span>{peer.lastSeen}</span></div>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card className="border-warning/30 bg-warning/5">
            <CardHeader><CardTitle className="flex items-center gap-2 text-base text-warning"><TriangleAlert className="size-4" />Trust queue</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p><span className="font-medium">cabin-node</span> is pending. Verify fingerprint out-of-band before approval.</p>
              <Button className="w-full" onClick={() => approvePeer('cabin-node')}>Review pending peer</Button>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><GitBranch className="size-4 text-primary" />Route preview</CardTitle></CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {routeCandidates.map((route) => (
              <button key={route.kind} type="button" className="rounded-xl border p-4 text-left transition-colors hover:bg-accent/40" onClick={() => toast(`${route.label} selected for visual preview`)}>
                <div className="flex items-start justify-between gap-2"><RouteBadge route={route.kind} /><Badge variant={route.available ? 'secondary' : 'outline'}>{route.available ? 'usable' : 'blocked'}</Badge></div>
                <p className="mt-3 font-medium">{route.label}</p>
                <p className="font-mono text-xs text-muted-foreground">{route.model} · {route.latencyMs}ms · {route.cost}</p>
                <p className="mt-2 text-xs text-muted-foreground">{route.note}</p>
                <div className="mt-3"><PrivacyBadge privacy={route.privacyClass} className="px-1.5 py-0" /></div>
              </button>
            ))}
          </CardContent>
        </Card>

        <Card className="overflow-hidden p-0">
          <Table>
            <TableHeader><TableRow><TableHead>Peer</TableHead><TableHead>Permissions</TableHead><TableHead>Latency</TableHead><TableHead>Trust</TableHead><TableHead className="text-right">Action</TableHead></TableRow></TableHeader>
            <TableBody>
              {meshPeers.map((peer) => (
                <TableRow key={peer.id}>
                  <TableCell><div className="font-medium">{peer.name}</div><div className="font-mono text-xs text-muted-foreground">{peer.fingerprint}</div></TableCell>
                  <TableCell><div className="flex flex-wrap gap-1">{peer.permissions.length ? peer.permissions.map((p) => <Badge key={p} variant="secondary" className="font-normal">{p}</Badge>) : <Badge variant="outline">no access</Badge>}</div></TableCell>
                  <TableCell><span className="inline-flex items-center gap-1 text-sm"><Signal className="size-3.5" />{peer.latencyMs}ms</span></TableCell>
                  <TableCell><Badge variant="outline" className={`${peerTone[peer.status]} capitalize`}>{peer.status}</Badge></TableCell>
                  <TableCell className="text-right">{peer.status === 'pending' ? <Button size="sm" onClick={() => approvePeer(peer.name)}><ShieldCheck className="size-4" />Approve</Button> : <Button size="sm" variant="outline"><LockKeyhole className="size-4" />Scopes</Button>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>
      <AdminConfirmDialog open={confirmOpen} onOpenChange={setConfirmOpen} action={action} onConfirm={() => { setConfirmOpen(false); toast('Peer approval audited (mock)') }} />
    </div>
  )
}
