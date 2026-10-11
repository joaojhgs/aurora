import { Badge } from '#components/ui/badge'
import { Signal } from 'lucide-react'
import { EmptyState } from './state-surface'

export function EmptyPanel({ title, description }: { title: string; description: string }) {
  return <EmptyState title={title} message={description} variant="card" icon={<Signal />} />
}

export function PermissionBadges({ permissions, empty, compact = false }: { permissions: string[]; empty: string; compact?: boolean }) {
  if (permissions.length === 0) return <span className="text-sm text-muted-foreground">{empty}</span>
  const visible = compact ? permissions.slice(0, 3) : permissions
  return (
    <div className="flex flex-wrap gap-1">
      {visible.map((permission) => (
        <Badge key={permission} variant="outline">
          {permissionLabel(permission)}
        </Badge>
      ))}
      {visible.length < permissions.length ? <Badge variant="secondary">+{permissions.length - visible.length}</Badge> : null}
    </div>
  )
}

export function permissionSummary(permissions: string[]): string {
  if (permissions.length === 0) return 'No access'
  if (permissions.length === 1) return permissionLabel(permissions[0] ?? '')
  return `${permissionLabel(permissions[0] ?? '')} +${permissions.length - 1}`
}

export function permissionLabel(permission: string): string {
  const labels: Record<string, string> = {
    '*': 'Full access',
    'Gateway.use': 'Device connection',
    'Orchestrator.use': 'Assistant use',
    'Orchestrator.RemoteInference': 'Model selection',
    'DB.use': 'Memory use',
    'Tooling.use': 'Tool use',
    'Scheduler.manage': 'Automation management',
    'TTS.use': 'Speech output',
    'STT.use': 'Speech input',
  }
  return labels[permission] ?? permission.replace(/^[A-Z]+\./, '').replace(/_/g, ' ')
}

export function DetailItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-muted/40 p-2">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm" title={value}>
        {value}
      </dd>
    </div>
  )
}
