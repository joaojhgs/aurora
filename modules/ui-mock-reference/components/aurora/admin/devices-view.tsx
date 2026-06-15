'use client'

import { useState } from 'react'
import { CheckCircle2, Laptop, Smartphone, Tablet, Trash2, UserCheck } from 'lucide-react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/aurora/page-header'
import { AdminConfirmDialog, type AdminAction } from '@/components/aurora/admin-confirm-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { devices } from '@/lib/aurora/data'
import { RouteBadge } from '@/components/aurora/status-badges'

const trustTone: Record<string, string> = {
  trusted: 'border-success/30 bg-success/10 text-success',
  pending: 'border-warning/30 bg-warning/10 text-warning',
  revoked: 'border-destructive/30 bg-destructive/10 text-destructive',
}

function DeviceIcon({ platform }: { platform: string }) {
  if (platform.includes('iOS') || platform.includes('Android')) return <Smartphone className="size-4" />
  if (platform.includes('tablet')) return <Tablet className="size-4" />
  return <Laptop className="size-4" />
}

export function DevicesView() {
  const [action, setAction] = useState<AdminAction | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  function removeDevice(name: string) {
    setAction({
      title: `Remove ${name}`,
      description: 'This device will need to pair again before using assistant, admin or mesh surfaces.',
      methodId: 'Auth.DeleteDevice',
      severity: 'high',
      affected: [{ type: 'device', label: name }, { type: 'session', label: 'active device sessions' }],
      requireReason: true,
    })
    setConfirmOpen(true)
  }

  return (
    <div>
      <PageHeader title="Devices" description="Trusted devices, pending pairings, platform capabilities and remote/local sources." />
      <div className="space-y-6 p-4 sm:p-6">
        <div className="grid gap-4 md:grid-cols-4">
          <Card><CardContent className="pt-6"><p className="text-2xl font-semibold">{devices.length}</p><p className="text-xs text-muted-foreground">registered devices</p></CardContent></Card>
          <Card><CardContent className="pt-6"><p className="text-2xl font-semibold">3</p><p className="text-xs text-muted-foreground">trusted</p></CardContent></Card>
          <Card><CardContent className="pt-6"><p className="text-2xl font-semibold">1</p><p className="text-xs text-muted-foreground">pending review</p></CardContent></Card>
          <Card><CardContent className="pt-6"><p className="text-2xl font-semibold">2</p><p className="text-xs text-muted-foreground">mobile clients</p></CardContent></Card>
        </div>

        <Card className="overflow-hidden p-0">
          <Table>
            <TableHeader><TableRow><TableHead>Device</TableHead><TableHead>Trust</TableHead><TableHead>User</TableHead><TableHead className="hidden md:table-cell">Source</TableHead><TableHead className="hidden lg:table-cell">Last seen</TableHead><TableHead className="text-right">Actions</TableHead></TableRow></TableHeader>
            <TableBody>
              {devices.map((d) => (
                <TableRow key={d.id}>
                  <TableCell><div className="flex items-center gap-2"><span className="rounded-md bg-muted p-1.5 text-muted-foreground"><DeviceIcon platform={d.platform} /></span><div><p className="font-medium">{d.name}</p><p className="text-xs text-muted-foreground">{d.platform}</p></div></div></TableCell>
                  <TableCell><Badge variant="outline" className={`${trustTone[d.trust]} capitalize`}>{d.trust}</Badge></TableCell>
                  <TableCell>{d.user}</TableCell>
                  <TableCell className="hidden md:table-cell"><RouteBadge route={d.source} className="px-1.5 py-0" /></TableCell>
                  <TableCell className="hidden text-sm text-muted-foreground lg:table-cell">{d.lastSeen}</TableCell>
                  <TableCell className="text-right">
                    {d.trust === 'pending' && <Button variant="ghost" size="icon" aria-label="Approve device" onClick={() => toast('Device approval previewed (mock)')}><UserCheck className="size-4 text-success" /></Button>}
                    {d.trust === 'trusted' && <CheckCircle2 className="mr-2 inline size-4 text-success" />}
                    <Button variant="ghost" size="icon" aria-label="Remove device" onClick={() => removeDevice(d.name)}><Trash2 className="size-4 text-destructive" /></Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>
      <AdminConfirmDialog open={confirmOpen} onOpenChange={setConfirmOpen} action={action} onConfirm={() => { setConfirmOpen(false); toast('Device mutation audited (mock)') }} />
    </div>
  )
}
