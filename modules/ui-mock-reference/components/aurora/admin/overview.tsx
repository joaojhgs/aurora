'use client'

import { useState } from 'react'
import {
  Boxes,
  ChevronRight,
  Cpu,
  KeyRound,
  Network,
  ScrollText,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { PageHeader } from '@/components/aurora/page-header'
import {
  CapabilityStateBadge,
  HealthBadge,
  ModeBadge,
} from '@/components/aurora/status-badges'
import { CapabilityDrawer } from '@/components/aurora/capability-drawer'
import {
  auditEvents,
  capabilityFeatures,
  deploymentSummary,
  services,
} from '@/lib/aurora/data'
import type { CapabilityFeature } from '@/lib/aurora/types'

const stats = [
  { label: 'Services', value: '10', sub: '9 healthy · 1 attention', icon: Boxes, tone: 'text-info' },
  { label: 'Mesh peers', value: '3', sub: '2 approved · 1 pending', icon: Network, tone: 'text-primary' },
  { label: 'Active tokens', value: '3', sub: '1 expiring soon', icon: KeyRound, tone: 'text-warning' },
  { label: 'Model runtime', value: 'Healthy', sub: 'llama.cpp · local', icon: Cpu, tone: 'text-success' },
]

export function AdminOverview() {
  const [feature, setFeature] = useState<CapabilityFeature | null>(null)
  const [open, setOpen] = useState(false)
  const healthy = services.filter((s) => s.status === 'Healthy').length

  function openFeature(f: CapabilityFeature) {
    setFeature(f)
    setOpen(true)
  }

  return (
    <div>
      <PageHeader
        title="Admin Overview"
        description="Deployment posture, service health and capability gaps at a glance."
        actions={
          <>
            <ModeBadge mode={deploymentSummary.mode} />
            <HealthBadge health={deploymentSummary.health} />
          </>
        }
      />

      <div className="space-y-6 p-4 sm:p-6">
        {/* Security warning banner */}
        <div className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <div className="flex-1">
            <p className="font-medium text-warning">1 pairing request awaiting review</p>
            <p className="text-muted-foreground">
              Peer <span className="font-mono">cabin-node</span> requested access. Review fingerprint before approving.
            </p>
          </div>
          <Button size="sm" variant="outline">
            Review
          </Button>
        </div>

        {/* Stat cards */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {stats.map((s) => {
            const Icon = s.icon
            return (
              <Card key={s.label}>
                <CardContent className="flex items-start gap-3 pt-6">
                  <span className={`rounded-lg bg-muted/60 p-2 ${s.tone}`}>
                    <Icon className="size-5" aria-hidden />
                  </span>
                  <div>
                    <p className="text-sm text-muted-foreground">{s.label}</p>
                    <p className="text-xl font-semibold">{s.value}</p>
                    <p className="text-xs text-muted-foreground">{s.sub}</p>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          {/* Service health */}
          <Card className="lg:col-span-2">
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">Service health</CardTitle>
              <span className="text-sm text-muted-foreground">
                {healthy}/{services.length} healthy
              </span>
            </CardHeader>
            <CardContent className="grid gap-2 sm:grid-cols-2">
              {services.map((s) => (
                <div key={s.module} className="flex items-center justify-between rounded-md border p-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{s.module}</p>
                    <p className="truncate font-mono text-xs text-muted-foreground">{s.instanceId}</p>
                  </div>
                  <HealthBadge health={s.status} />
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Recent audit */}
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="flex items-center gap-2 text-base">
                <ScrollText className="size-4 text-muted-foreground" aria-hidden />
                Recent audit
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {auditEvents.slice(0, 5).map((e) => (
                <div key={e.id} className="text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <code className="font-mono text-xs">{e.action}</code>
                    <span className="text-xs text-muted-foreground">{e.actor}</span>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">{e.resource}</p>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>

        {/* Capability graph */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="size-4 text-primary" aria-hidden />
              Capability graph
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Every feature renders by capability state. Click any item to see why and how to repair it.
            </p>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y">
              {capabilityFeatures.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => openFeature(f)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40 sm:px-6"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{f.label}</p>
                    <code className="truncate font-mono text-xs text-muted-foreground">{f.id}</code>
                  </div>
                  <span className="hidden text-xs capitalize text-muted-foreground sm:inline">
                    {f.category}
                  </span>
                  <CapabilityStateBadge state={f.state} />
                  <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <CapabilityDrawer feature={feature} open={open} onOpenChange={setOpen} />
    </div>
  )
}
