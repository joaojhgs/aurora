'use client'

import { useState } from 'react'
import { Lock, Play, RotateCw, Square } from 'lucide-react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/aurora/page-header'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import {
  HealthBadge,
  BackendCoverageBadge,
  ExposureBadge,
  MethodTypeBadge,
  RouteBadge,
} from '@/components/aurora/status-badges'
import {
  AdminConfirmDialog,
  type AdminAction,
} from '@/components/aurora/admin-confirm-dialog'
import { services } from '@/lib/aurora/data'
import type { AuroraService } from '@/lib/aurora/types'

export function ServicesView() {
  const [detail, setDetail] = useState<AuroraService | null>(null)
  const [action, setAction] = useState<AdminAction | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  function serviceControlCoverage(svc: AuroraService, verb: 'restart' | 'stop') {
    const topic = `Supervisor.${verb === 'restart' ? 'RestartService' : 'StopService'}`
    return svc.methods.find((m) => m.busTopic === topic)?.backendCoverage ?? 'missing_contract'
  }

  function controlService(svc: AuroraService, verb: 'restart' | 'stop') {
    setAction({
      title: `${verb === 'restart' ? 'Restart' : 'Stop'} ${svc.module}`,
      description: `This will ${verb} the ${svc.module} service. Dependent assistant and admin features may be briefly unavailable.`,
      methodId: `Supervisor.${verb === 'restart' ? 'RestartService' : 'StopService'}`,
      severity: verb === 'stop' ? 'critical' : 'high',
      affected: [
        { type: 'service', label: svc.module },
        ...svc.capabilities.slice(0, 2).map((c) => ({ type: 'capability', label: c })),
      ],
      requireReason: true,
      requireTypedPhrase: verb === 'stop' ? svc.module : undefined,
    })
    setConfirmOpen(true)
  }

  return (
    <div>
      <PageHeader
        title="Services"
        description="Service registry, health and supervisor controls. Mutations preview their impact."
      />
      <div className="p-4 sm:p-6">
        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Module</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden md:table-cell">Instance</TableHead>
                  <TableHead className="hidden lg:table-cell">Capabilities</TableHead>
                  <TableHead className="hidden sm:table-cell">Route</TableHead>
                  <TableHead className="hidden xl:table-cell">Heartbeat</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {services.map((s) => (
                  <TableRow
                    key={s.module}
                    className="cursor-pointer"
                    onClick={() => setDetail(s)}
                  >
                    <TableCell className="font-medium">{s.module}</TableCell>
                    <TableCell>
                      <HealthBadge health={s.status} />
                    </TableCell>
                    <TableCell className="hidden font-mono text-xs text-muted-foreground md:table-cell">
                      {s.instanceId}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <div className="flex flex-wrap gap-1">
                        {s.capabilities.slice(0, 3).map((c) => (
                          <Badge key={c} variant="secondary" className="font-normal">
                            {c}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <RouteBadge route={s.routeAvailability} className="px-1.5 py-0" />
                    </TableCell>
                    <TableCell className="hidden text-xs text-muted-foreground xl:table-cell">
                      {s.lastHeartbeat}
                    </TableCell>
                    <TableCell
                      className="text-right"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Restart ${s.module}`}
                          disabled={serviceControlCoverage(s, 'restart') === 'missing_contract'}
                          title={serviceControlCoverage(s, 'restart') === 'internal_only' ? 'Local/Tauri/internal-only control' : 'Preview restart AdminAction'}
                          onClick={() => controlService(s, 'restart')}
                        >
                          <RotateCw className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Stop ${s.module}`}
                          disabled={serviceControlCoverage(s, 'stop') === 'missing_contract'}
                          title="StopService is displayed as a planned/missing backend contract, not a currently executable HTTP action."
                          onClick={() => controlService(s, 'stop')}
                        >
                          {serviceControlCoverage(s, 'stop') === 'missing_contract' ? <Lock className="size-4 text-muted-foreground" /> : <Square className="size-4 text-destructive" />}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>
      </div>

      {/* Method drawer */}
      <Sheet open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          {detail && (
            <>
              <SheetHeader>
                <div className="flex items-center gap-2">
                  <SheetTitle>{detail.module}</SheetTitle>
                  <HealthBadge health={detail.status} />
                </div>
                <SheetDescription>{detail.description}</SheetDescription>
              </SheetHeader>
              <div className="space-y-4 px-4 pb-6">
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <Meta label="Instance" value={detail.instanceId} mono />
                  <Meta label="Heartbeat" value={detail.lastHeartbeat} />
                  <Meta label="Route" value={detail.routeAvailability} />
                  <Meta label="Methods" value={String(detail.methods.length)} />
                </div>
                <Separator />
                <div>
                  <p className="mb-2 text-xs font-medium text-muted-foreground">
                    Methods &amp; exposure
                  </p>
                  <div className="space-y-2">
                    {detail.methods.map((m) => (
                      <div key={m.name} className="rounded-md border p-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <code className="font-mono text-sm">{m.busTopic}</code>
                          <MethodTypeBadge type={m.methodType} />
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <ExposureBadge exposure={m.exposure} />
                          {m.backendCoverage ? <BackendCoverageBadge coverage={m.backendCoverage} /> : null}
                          {m.routePath ? <code className="rounded bg-muted px-1 font-mono">{m.routePath}</code> : null}
                          {m.permissions.map((p) => (
                            <code key={p} className="rounded bg-muted px-1 font-mono">
                              {p}
                            </code>
                          ))}
                        </div>
                        {m.note ? <p className="mt-2 text-xs text-muted-foreground">{m.note}</p> : null}
                      </div>
                    ))}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" className="flex-1" onClick={() => toast('Health check requested')}>
                    <Play className="size-4" />
                    Run health check
                  </Button>
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={() => {
                      controlService(detail, 'restart')
                      setDetail(null)
                    }}
                  >
                    <RotateCw className="size-4" />
                    Restart
                  </Button>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      <AdminConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        action={action}
        onConfirm={() => {
          setConfirmOpen(false)
          toast.success(`${action?.title} confirmed`, { description: 'Action recorded in audit log.' })
        }}
      />
    </div>
  )
}

function Meta({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={mono ? 'font-mono text-sm' : 'text-sm'}>{value}</p>
    </div>
  )
}
