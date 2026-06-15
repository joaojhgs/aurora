'use client'

import { useMemo, useState } from 'react'
import { Clock, Copy, KeyRound, Plus, ShieldAlert, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/aurora/page-header'
import { AdminConfirmDialog, type AdminAction } from '@/components/aurora/admin-confirm-dialog'
import { PrivacyBadge } from '@/components/aurora/status-badges'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { tokens } from '@/lib/aurora/data'

const statusTone: Record<string, string> = {
  active: 'border-success/30 bg-success/10 text-success',
  expiring: 'border-warning/30 bg-warning/10 text-warning',
  revoked: 'border-destructive/30 bg-destructive/10 text-destructive',
}

export function TokensView() {
  const [action, setAction] = useState<AdminAction | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const activeCount = useMemo(() => tokens.filter((t) => t.status !== 'revoked').length, [])

  function revoke(prefix: string) {
    setAction({
      title: `Revoke ${prefix}`,
      description: 'The token will stop authenticating immediately. Existing sessions may need to repair their connection.',
      methodId: 'Auth.RevokeToken',
      severity: 'critical',
      affected: [{ type: 'token', label: prefix }, { type: 'audit', label: 'Auth.AuditEvent' }],
      requireReason: true,
      requireTypedPhrase: prefix,
    })
    setConfirmOpen(true)
  }

  return (
    <div>
      <PageHeader
        title="Tokens"
        description="Scoped API tokens, one-time reveal rules and revocation safety for server, local and mesh clients."
        actions={
          <Button>
            <Plus className="size-4" />
            Create token
          </Button>
        }
      />
      <div className="space-y-6 p-4 sm:p-6">
        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardContent className="flex items-center gap-3 pt-6">
              <KeyRound className="size-5 text-primary" />
              <div>
                <p className="text-2xl font-semibold">{activeCount}</p>
                <p className="text-xs text-muted-foreground">active credentials</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center gap-3 pt-6">
              <Clock className="size-5 text-warning" />
              <div>
                <p className="text-2xl font-semibold">1</p>
                <p className="text-xs text-muted-foreground">expires within 30 days</p>
              </div>
            </CardContent>
          </Card>
          <Card className="border-destructive/30 bg-destructive/5">
            <CardContent className="flex items-start gap-3 pt-6">
              <ShieldAlert className="mt-1 size-5 text-destructive" />
              <div>
                <p className="font-medium text-destructive">One-time reveal only</p>
                <p className="text-xs text-muted-foreground">Secrets are never shown again after creation.</p>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className="overflow-hidden p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Prefix</TableHead>
                <TableHead>Principal</TableHead>
                <TableHead>Scopes</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden md:table-cell">Expires</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tokens.map((token) => (
                <TableRow key={token.id}>
                  <TableCell className="font-mono text-xs">{token.prefix}</TableCell>
                  <TableCell className="font-medium">{token.principal}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {token.scopes.slice(0, 3).map((scope) => <Badge key={scope} variant="secondary" className="font-normal">{scope}</Badge>)}
                    </div>
                  </TableCell>
                  <TableCell><Badge variant="outline" className={`${statusTone[token.status]} capitalize`}>{token.status}</Badge></TableCell>
                  <TableCell className="hidden text-sm text-muted-foreground md:table-cell">{token.expires}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon" aria-label="Copy prefix" onClick={() => toast('Token prefix copied for visual mock')}>
                      <Copy className="size-4" />
                    </Button>
                    <Button variant="ghost" size="icon" aria-label="Revoke token" disabled={token.status === 'revoked'} onClick={() => revoke(token.prefix)}>
                      <Trash2 className="size-4 text-destructive" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Create-token preview</CardTitle></CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-[1fr_1fr_auto] md:items-end">
            <div className="space-y-1.5"><Label>Principal</Label><Input defaultValue="ops-bot" /></div>
            <div className="space-y-1.5"><Label>Scopes</Label><Input defaultValue="Scheduler.manage, Tooling.use" /></div>
            <div className="flex items-center gap-2 rounded-md border px-3 py-2"><Switch defaultChecked /><span className="text-sm">Expire in 90 days</span></div>
          </CardContent>
        </Card>

        <PrivacyBadge privacy="credential" />
      </div>
      <AdminConfirmDialog open={confirmOpen} onOpenChange={setConfirmOpen} action={action} onConfirm={() => { setConfirmOpen(false); toast('Revocation audited (mock)') }} />
    </div>
  )
}
