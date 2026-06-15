'use client'

import { useState } from 'react'
import { ArchiveRestore, Boxes, CheckCircle2, Code2, FileJson, Fingerprint, PackageCheck, Plug, ShieldCheck, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/aurora/page-header'
import { AdminConfirmDialog, type AdminAction } from '@/components/aurora/admin-confirm-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { services, meshPeers, specCoverageRows } from '@/lib/aurora/data'
import { BackendCoverageBadge, CapabilityStateBadge, ExposureBadge, MethodTypeBadge, PrivacyBadge } from '@/components/aurora/status-badges'

type Surface = 'contracts' | 'plugins' | 'pairing' | 'backups'

const meta = {
  contracts: { title: 'Contract Explorer', description: 'Registry methods, OpenAPI paths, schemas and safe test-invoke previews.', icon: Code2 },
  plugins: { title: 'Plugin Management', description: 'Core tools, MCP plugins, reload status and signed install/update policy.', icon: Plug },
  pairing: { title: 'Pairing Queue', description: 'Pending device and mesh peer approval with fingerprint verification.', icon: Fingerprint },
  backups: { title: 'Backups & Restore', description: 'Planned DB/config/model export and restore flow with admin-critical warnings.', icon: ArchiveRestore },
} satisfies Record<Surface, { title: string; description: string; icon: typeof Code2 }>

export function AdminSecondarySurface({ surface }: { surface: Surface }) {
  const [action, setAction] = useState<AdminAction | null>(null)
  const [open, setOpen] = useState(false)
  const m = meta[surface]
  const Icon = m.icon

  function confirm(title: string, methodId: string, severity: 'medium' | 'high' | 'critical' = 'high') {
    setAction({
      title,
      description: 'This visual mock uses the AdminAction wrapper for every manage/admin-critical operation.',
      methodId,
      severity,
      affected: [{ type: 'surface', label: m.title }, { type: 'audit', label: 'Auth.AuditEvent' }],
      requireReason: true,
      diff: [{ key: `${surface}.state`, before: 'pending', after: 'approved' }],
    })
    setOpen(true)
  }

  return (
    <div>
      <PageHeader title={m.title} description={m.description} icon={Icon} actions={<Button variant="outline" onClick={() => confirm(`Preview ${m.title}`, `Admin.${surface}.Preview`, 'medium')}><ShieldCheck className="size-4" />Preview action</Button>} />
      <div className="space-y-6 p-4 sm:p-6">
        {surface === 'contracts' && <ContractsPanel />}
        {surface === 'plugins' && <PluginsPanel onConfirm={confirm} />}
        {surface === 'pairing' && <PairingPanel onConfirm={confirm} />}
        {surface === 'backups' && <BackupsPanel onConfirm={confirm} />}
      </div>
      <AdminConfirmDialog open={open} onOpenChange={setOpen} action={action} onConfirm={() => { setOpen(false); toast('Admin action audited (mock)') }} />
    </div>
  )
}

function ContractsPanel() {
  const methods = services.flatMap((s) => s.methods.map((method) => ({ module: s.module, ...method }))).slice(0, 24)
  return <div className="space-y-6"><Card className="overflow-hidden p-0"><Table><TableHeader><TableRow><TableHead>Method</TableHead><TableHead>Route/path</TableHead><TableHead>Type</TableHead><TableHead>Exposure</TableHead><TableHead>Backend</TableHead><TableHead>Permissions</TableHead></TableRow></TableHeader><TableBody>{methods.map((m) => <TableRow key={`${m.module}.${m.name}`}><TableCell><div className="font-medium">{m.busTopic}</div><code className="text-xs text-muted-foreground">MethodInfo.bus_topic / generated method id</code>{m.note ? <p className="mt-1 text-xs text-muted-foreground">{m.note}</p> : null}</TableCell><TableCell className="font-mono text-xs">{m.routePath ?? 'not HTTP-exposed'}</TableCell><TableCell><MethodTypeBadge type={m.methodType} /></TableCell><TableCell><ExposureBadge exposure={m.exposure} /></TableCell><TableCell>{m.backendCoverage ? <BackendCoverageBadge coverage={m.backendCoverage} /> : <Badge variant="outline">unknown</Badge>}</TableCell><TableCell><div className="flex flex-wrap gap-1">{m.permissions.length ? m.permissions.map((p) => <Badge key={p} variant="secondary">{p}</Badge>) : <Badge variant="outline">none</Badge>}</div></TableCell></TableRow>)}</TableBody></Table></Card><Card className="overflow-hidden p-0"><Table><TableHeader><TableRow><TableHead>Production row</TableHead><TableHead>Spec</TableHead><TableHead>Backend</TableHead><TableHead>Mock</TableHead><TableHead>Task-generation note</TableHead></TableRow></TableHeader><TableBody>{specCoverageRows.map((row) => <TableRow key={row.id}><TableCell><div className="font-medium">{row.label}</div><code className="text-xs text-muted-foreground">{row.id}</code></TableCell><TableCell><Badge variant="outline">{row.specStatus}</Badge></TableCell><TableCell><BackendCoverageBadge coverage={row.backendStatus} /></TableCell><TableCell><Badge variant="outline">{row.mockStatus}</Badge></TableCell><TableCell className="max-w-md text-sm text-muted-foreground">{row.taskNotes}</TableCell></TableRow>)}</TableBody></Table></Card></div>
}

function PluginsPanel({ onConfirm }: { onConfirm: (title: string, methodId: string, severity?: 'medium' | 'high' | 'critical') => void }) {
  const plugins = [['Core tools', 'enabled', 'Tooling.GetTools'], ['MCP filesystem', 'review', 'Tooling.ReloadMCPTools'], ['OpenRecall', 'disabled', 'Config.SetPlugin']]
  return <div className="grid gap-4 md:grid-cols-3">{plugins.map(([name, state, method]) => <Card key={name}><CardHeader><CardTitle className="flex items-center gap-2 text-base"><PackageCheck className="size-4 text-primary" />{name}</CardTitle></CardHeader><CardContent className="space-y-3"><CapabilityStateBadge state={state === 'enabled' ? 'available' : state === 'review' ? 'degraded' : 'missing_service'} /><p className="text-sm text-muted-foreground">Signed plugin metadata, config source and reload impact are shown before changes.</p><Button variant="outline" onClick={() => onConfirm(`Update ${name}`, method, state === 'disabled' ? 'critical' : 'high')}>Configure</Button></CardContent></Card>)}</div>
}

function PairingPanel({ onConfirm }: { onConfirm: (title: string, methodId: string, severity?: 'medium' | 'high' | 'critical') => void }) {
  const pending = meshPeers.filter((p) => p.status === 'pending')
  return <div className="grid gap-4 lg:grid-cols-[.8fr_1.2fr]"><Card className="border-warning/30 bg-warning/5"><CardContent className="flex items-start gap-3 pt-6"><TriangleAlert className="mt-1 size-5 text-warning" /><div><p className="font-medium text-warning">{pending.length} pending request</p><p className="text-sm text-muted-foreground">Verify fingerprint out-of-band before approval.</p></div></CardContent></Card><Card className="overflow-hidden p-0"><Table><TableHeader><TableRow><TableHead>Peer</TableHead><TableHead>Fingerprint</TableHead><TableHead>Requested scopes</TableHead><TableHead className="text-right">Action</TableHead></TableRow></TableHeader><TableBody>{pending.map((peer) => <TableRow key={peer.id}><TableCell className="font-medium">{peer.name}</TableCell><TableCell className="font-mono text-xs">{peer.fingerprint}</TableCell><TableCell><Badge variant="outline">Orchestrator.use</Badge></TableCell><TableCell className="text-right"><Button size="sm" onClick={() => onConfirm(`Approve ${peer.name}`, 'Auth.PairingApprove', 'high')}><CheckCircle2 className="size-4" />Approve</Button></TableCell></TableRow>)}</TableBody></Table></Card></div>
}

function BackupsPanel({ onConfirm }: { onConfirm: (title: string, methodId: string, severity?: 'medium' | 'high' | 'critical') => void }) {
  return <div className="grid gap-4 md:grid-cols-3"><Card><CardContent className="pt-6"><Boxes className="mb-3 size-5 text-primary" /><p className="font-medium">Config snapshot</p><p className="text-sm text-muted-foreground">config.json + effective env overlay, redacted.</p><Button className="mt-4" variant="outline" disabled onClick={() => onConfirm('Create config backup', 'Backup.CreateConfig', 'high')}>Preview only</Button></CardContent></Card><Card><CardContent className="pt-6"><FileJson className="mb-3 size-5 text-primary" /><p className="font-medium">DB/RAG export</p><p className="text-sm text-muted-foreground">Personal/sensitive records require explicit privacy review.</p><Button className="mt-4" variant="outline" disabled onClick={() => onConfirm('Create DB export', 'Backup.CreateDatabase', 'critical')}>Preview only</Button></CardContent></Card><Card className="border-destructive/30 bg-destructive/5"><CardContent className="pt-6"><TriangleAlert className="mb-3 size-5 text-destructive" /><p className="font-medium text-destructive">Restore is admin-critical</p><p className="text-sm text-muted-foreground">Future contract must validate, diff, stop services and audit.</p><PrivacyBadge privacy="admin-critical" className="mt-4" /></CardContent></Card></div>
}
