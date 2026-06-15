import { CalendarClock, Plug, Wrench } from 'lucide-react'
import { PageHeader } from '@/components/aurora/page-header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { HealthBadge } from '@/components/aurora/status-badges'

const tools = [
  { name: 'web.search', risk: 'external', enabled: true, calls: 142 },
  { name: 'diagnostics.serviceHealth', risk: 'read-only', enabled: true, calls: 38 },
  { name: 'files.write', risk: 'mutating', enabled: false, calls: 4 },
  { name: 'shell.exec', risk: 'admin', enabled: false, calls: 0 },
]

const jobs = [
  { name: 'daily-digest', schedule: '0 8 * * *', status: 'active', next: 'in 22h' },
  { name: 'index-knowledge', schedule: '*/30 * * * *', status: 'active', next: 'in 12m' },
  { name: 'mesh-health-probe', schedule: '*/5 * * * *', status: 'paused', next: '—' },
]

const riskTone: Record<string, string> = {
  'read-only': 'bg-success/10 text-success border-success/30',
  external: 'bg-warning/10 text-warning border-warning/30',
  mutating: 'bg-warning/10 text-warning border-warning/30',
  admin: 'bg-destructive/10 text-destructive border-destructive/30',
}

export default function ToolsPage() {
  return (
    <div>
      <PageHeader
        title="Tools & Automations"
        description="Tool registry, MCP status, scheduler jobs and execution logs."
      />
      <div className="grid gap-6 p-4 sm:p-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <Wrench className="size-4 text-primary" aria-hidden />
              Tool registry
            </CardTitle>
            <Badge variant="outline" className="gap-1.5 font-normal">
              <Plug className="size-3.5" /> MCP connected
            </Badge>
          </CardHeader>
          <CardContent className="space-y-2">
            {tools.map((t) => (
              <div key={t.name} className="flex items-center gap-3 rounded-lg border p-3">
                <code className="flex-1 truncate font-mono text-sm">{t.name}</code>
                <span className="text-xs text-muted-foreground">{t.calls} calls</span>
                <Badge variant="outline" className={`${riskTone[t.risk]} font-normal capitalize`}>
                  {t.risk}
                </Badge>
                <Switch defaultChecked={t.enabled} aria-label={`Toggle ${t.name}`} />
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CalendarClock className="size-4 text-primary" aria-hidden />
              Scheduled jobs
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Job</TableHead>
                  <TableHead>Schedule</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Next</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map((j) => (
                  <TableRow key={j.name}>
                    <TableCell className="font-medium">{j.name}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{j.schedule}</TableCell>
                    <TableCell>
                      <HealthBadge health={j.status === 'active' ? 'Healthy' : 'Degraded'} />
                    </TableCell>
                    <TableCell className="text-right text-sm text-muted-foreground">{j.next}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
