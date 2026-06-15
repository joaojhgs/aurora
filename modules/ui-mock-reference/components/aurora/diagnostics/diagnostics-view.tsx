'use client'

import { useState } from 'react'
import { Activity, Bug, Download, FileArchive, Gauge, Radio, RefreshCw, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/aurora/page-header'
import { AdminConfirmDialog, type AdminAction } from '@/components/aurora/admin-confirm-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import { PrivacyBadge, HealthBadge } from '@/components/aurora/status-badges'
import { activityEvents, services } from '@/lib/aurora/data'

const probes = [
  { name: 'Gateway route registry', health: 'Healthy' as const, latency: 18 },
  { name: 'OpenAPI route generation', health: 'Healthy' as const, latency: 22 },
  { name: 'Mesh peer metrics', health: 'Needs attention' as const, latency: 180 },
  { name: 'Diagnostics bundle contract', health: 'Degraded' as const, latency: 0 },
]

const redaction = [
  { label: 'Credential values', value: 100 },
  { label: 'Raw audio payloads', value: 100 },
  { label: 'Personal memory snippets', value: 76 },
]

export function DiagnosticsView() {
  const [action, setAction] = useState<AdminAction | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  function exportBundle() {
    setAction({
      title: 'Export diagnostics bundle',
      description: 'A redacted bundle will include registry, service health, route state, recent audit metadata and native capability status. Secrets and raw audio are excluded.',
      methodId: 'Diagnostics.ExportBundle',
      severity: 'high',
      affected: [{ type: 'privacy', label: 'redaction preview' }, { type: 'audit', label: 'diagnostics.export' }],
      requireReason: true,
      diff: [
        { key: 'include.secrets', before: 'unknown', after: 'false' },
        { key: 'include.rawAudio', before: 'unknown', after: 'false' },
        { key: 'include.registry', before: 'false', after: 'true' },
      ],
    })
    setConfirmOpen(true)
  }

  return (
    <div>
      <PageHeader title="Diagnostics" description="Service probes, traces, redaction preview and export workflow for support/debugging." actions={<Button onClick={exportBundle}><Download className="size-4" />Export bundle</Button>} />
      <div className="space-y-6 p-4 sm:p-6">
        <div className="grid gap-4 md:grid-cols-4">
          <Card><CardContent className="pt-6"><Activity className="mb-3 size-5 text-success" /><p className="text-2xl font-semibold">{services.length}</p><p className="text-xs text-muted-foreground">services observed</p></CardContent></Card>
          <Card><CardContent className="pt-6"><Gauge className="mb-3 size-5 text-primary" /><p className="text-2xl font-semibold">42ms</p><p className="text-xs text-muted-foreground">median bus route</p></CardContent></Card>
          <Card><CardContent className="pt-6"><Radio className="mb-3 size-5 text-warning" /><p className="text-2xl font-semibold">1</p><p className="text-xs text-muted-foreground">mesh warning</p></CardContent></Card>
          <Card><CardContent className="pt-6"><Bug className="mb-3 size-5 text-muted-foreground" /><p className="text-2xl font-semibold">0</p><p className="text-xs text-muted-foreground">uncaught UI errors</p></CardContent></Card>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><RefreshCw className="size-4 text-primary" />Live probes</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {probes.map((probe) => <div key={probe.name} className="flex items-center justify-between rounded-lg border p-3"><div><p className="font-medium">{probe.name}</p><p className="font-mono text-xs text-muted-foreground">{probe.latency ? `${probe.latency}ms` : 'contract gap'}</p></div><HealthBadge health={probe.health} /></div>)}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="size-4 text-primary" />Redaction preview</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              {redaction.map((r) => <div key={r.label} className="space-y-1.5"><div className="flex justify-between text-sm"><span>{r.label}</span><span>{r.value}%</span></div><Progress value={r.value} /></div>)}
              <div className="flex flex-wrap gap-2 pt-2"><PrivacyBadge privacy="credential" /><PrivacyBadge privacy="raw-audio" /><PrivacyBadge privacy="admin-critical" /></div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><FileArchive className="size-4 text-primary" />Timeline</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {activityEvents.map((event) => <div key={event.id} className="flex items-start gap-3 rounded-lg border p-3"><Badge variant="outline" className="mt-0.5 capitalize">{event.type}</Badge><div className="min-w-0 flex-1"><p className="font-medium">{event.title}</p><p className="truncate text-sm text-muted-foreground">{event.detail}</p></div><span className="text-xs text-muted-foreground">{event.time}</span></div>)}
          </CardContent>
        </Card>
      </div>
      <AdminConfirmDialog open={confirmOpen} onOpenChange={setConfirmOpen} action={action} onConfirm={() => { setConfirmOpen(false); toast('Diagnostics export queued (mock)') }} />
    </div>
  )
}
