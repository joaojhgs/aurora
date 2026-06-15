'use client'

import { Cpu, Download, Gauge, HardDrive, Route, Smartphone, Thermometer, Zap } from 'lucide-react'
import { PageHeader } from '@/components/aurora/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { modelProviders, routeCandidates } from '@/lib/aurora/data'
import { CapabilityStateBadge, HealthBadge, PrivacyBadge, RouteBadge } from '@/components/aurora/status-badges'

const runtimeRows = [
  { id: 'desktop.llamacpp', label: 'llama.cpp desktop', mode: 'Desktop Local', status: 'available' as const, metric: '1.2s first token', privacy: 'personal' as const },
  { id: 'server.gateway', label: 'Server provider', mode: 'Server', status: 'remote_only' as const, metric: '600ms avg', privacy: 'sensitive' as const },
  { id: 'mesh.studio-gpu', label: 'studio-gpu peer', mode: 'Mesh', status: 'available' as const, metric: '34ms route', privacy: 'personal' as const },
  { id: 'mobile.local-light', label: 'Mobile local-light', mode: 'Android/iOS', status: 'unsupported_platform' as const, metric: 'Spike pending', privacy: 'secret' as const },
]

const benchmarks = [
  { label: 'Cold start', value: 68, detail: 'desktop local model warmup' },
  { label: 'Context fit', value: 82, detail: '8k current conversation' },
  { label: 'Thermal headroom', value: 54, detail: 'mobile provider pending' },
]

export function ModelsView() {
  return (
    <div>
      <PageHeader
        title="Models & Runtime"
        description="Local, server, peer and mobile-light providers with route policy and benchmark states."
        actions={<Button variant="outline"><Download className="size-4" />Import model</Button>}
      />
      <div className="space-y-6 p-4 sm:p-6">
        <div className="grid gap-4 lg:grid-cols-4">
          {modelProviders.map((provider) => (
            <Card key={provider.id}>
              <CardHeader className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="rounded-lg bg-primary/10 p-2 text-primary">{provider.kind === 'mobile' ? <Smartphone className="size-4" /> : <Cpu className="size-4" />}</span>
                  <CapabilityStateBadge state={provider.status} />
                </div>
                <CardTitle className="text-base">{provider.name}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm text-muted-foreground">
                <div className="flex justify-between"><span>Kind</span><Badge variant="secondary" className="capitalize">{provider.kind}</Badge></div>
                <div className="flex justify-between"><span>Context</span><span className="font-mono">{provider.contextWindow}</span></div>
                {provider.size && <div className="flex justify-between"><span>Size</span><span>{provider.size}</span></div>}
                <div className="flex justify-between"><span>Health</span><HealthBadge health={provider.health} className="px-1.5 py-0" /></div>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Route className="size-4 text-primary" />Provider route policy</CardTitle></CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              {routeCandidates.map((candidate) => (
                <div key={candidate.kind} className="rounded-lg border p-3">
                  <div className="flex items-center justify-between"><RouteBadge route={candidate.kind} /><Badge variant={candidate.available ? 'secondary' : 'outline'}>{candidate.available ? 'enabled' : 'blocked'}</Badge></div>
                  <p className="mt-3 font-medium">{candidate.model}</p>
                  <p className="text-xs text-muted-foreground">{candidate.note}</p>
                  <div className="mt-3 flex items-center justify-between"><PrivacyBadge privacy={candidate.privacyClass} className="px-1.5 py-0" /><span className="font-mono text-xs text-muted-foreground">{candidate.latencyMs}ms</span></div>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Gauge className="size-4 text-primary" />Benchmark snapshot</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              {benchmarks.map((b) => <div key={b.label} className="space-y-1.5"><div className="flex justify-between text-sm"><span>{b.label}</span><span>{b.value}%</span></div><Progress value={b.value} /><p className="text-xs text-muted-foreground">{b.detail}</p></div>)}
            </CardContent>
          </Card>
        </div>

        <Card className="overflow-hidden p-0">
          <Table>
            <TableHeader><TableRow><TableHead>Runtime feature</TableHead><TableHead>Mode</TableHead><TableHead>Status</TableHead><TableHead>Metric</TableHead><TableHead>Privacy</TableHead></TableRow></TableHeader>
            <TableBody>
              {runtimeRows.map((row) => <TableRow key={row.id}><TableCell><div className="font-medium">{row.label}</div><code className="text-xs text-muted-foreground">{row.id}</code></TableCell><TableCell>{row.mode}</TableCell><TableCell><CapabilityStateBadge state={row.status} /></TableCell><TableCell className="font-mono text-xs text-muted-foreground">{row.metric}</TableCell><TableCell><PrivacyBadge privacy={row.privacy} className="px-1.5 py-0" /></TableCell></TableRow>)}
            </TableBody>
          </Table>
        </Card>

        <Card className="border-warning/30 bg-warning/5">
          <CardContent className="flex items-start gap-3 pt-6 text-sm">
            <Thermometer className="mt-0.5 size-4 text-warning" />
            <div><p className="font-medium text-warning">Mobile local-light remains capability-gated</p><p className="text-muted-foreground">ExecuTorch, MLC, ONNX Runtime Mobile and Core ML providers need benchmark/device-matrix proof before the UI presents them as available.</p></div>
            <Zap className="ml-auto hidden size-5 text-warning sm:block" />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
