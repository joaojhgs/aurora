import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Copy, KeyRound, Link2, LockKeyhole, QrCode, RadioTower, ScanLine, Settings2, ShieldCheck, Signal } from 'lucide-react'
import type { AvailabilityState, ConfigFieldMetadata, JsonObject, JsonValue, PermissionCatalogEntry } from '@aurora/client'
import { Alert, AlertDescription, AlertTitle } from '#components/ui/alert'
import { Badge } from '#components/ui/badge'
import { Button } from '#components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '#components/ui/card'
import { Switch } from '#components/ui/switch'
import { Checkbox } from '#components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '#components/ui/dialog'
import { Input } from '#components/ui/input'
import { Label } from '#components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#components/ui/select'
import { Skeleton } from '#components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '#components/ui/tabs'
import { Textarea } from '#components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '#components/ui/toggle-group'
import { PermissionEditorTable, ROLE_TEMPLATES, matchRoleTemplate } from './shared-components'
import { decodeMeshInvite, meshInviteSummary } from './mesh-invite'
import type { AuroraSurfaceProfile } from './platform-surface'
import type { MeshConfigChange, MeshInviteImportOperation, MeshPeerRow, MeshPeersLoadState, MeshPeersSnapshot } from './mesh-peers-view'
import type { MeshInviteReadiness } from './mesh-peers-model'
import { MeshVerificationCode, configArray, formatRelative, groupConfigFields, isArrayConfigField, isBooleanConfigField, isNumberConfigField, meshPeerErrorMessage, meshPeerScopesEditable, meshSafeErrorTitle, parseConfigValue, parseMeshPermissionList, productConfigDescription, productConfigTitle, stringifyConfigValue } from './mesh-peers-model'
import { DetailItem, EmptyPanel, permissionLabel } from './mesh-peers-shared'

export {
  ThinPeerConnectionStatus,
  ThinPeerPairingDialog,
} from './mesh-peers-pairing'

function MeshStateBadge({ state }: { state: AvailabilityState | MeshPeersLoadState }) {
  return <Badge variant="outline">{meshStateLabel(state)}</Badge>
}

function meshStateLabel(state: AvailabilityState | MeshPeersLoadState): string {
  if (state === 'available-local') return 'Local'
  if (state === 'available-remote') return 'Remote'
  if (state === 'pending' || state === 'loading') return 'Pending'
  if (state === 'ready' || state === 'empty') return 'Ready'
  if (state === 'denied') return 'Needs approval'
  if (state === 'degraded' || state === 'stale' || state === 'error' || state === 'service-unavailable' || state === 'unsupported' || state === 'privacy-blocked') return 'Needs attention'
  return 'Status'
}

function toCatalogEntry(id: string): PermissionCatalogEntry {
  const [service, action] = id.includes('.') ? [id.slice(0, id.indexOf('.')), id.slice(id.indexOf('.') + 1)] : [null, null]
  return {
    id,
    label: permissionLabel(id),
    description: '',
    service,
    action,
    kind: id === '*' ? 'all' : 'method',
    methodType: null,
    exposure: null,
    busTopic: null,
    routePath: null,
    availableOverHttp: false,
    requiredBy: [],
  }
}

export function isPermissionAllowedOnSurface(permission: string, surfaceProfile: AuroraSurfaceProfile): boolean {
  if (!permission) return false
  if (surfaceProfile.isMobile && permission === 'Gateway.use') return false
  return true
}

function meshPermissionCatalog(surfaceProfile: AuroraSurfaceProfile, ...permissionSets: string[][]): PermissionCatalogEntry[] {
  const base = ['*', 'Gateway.use', 'Orchestrator.use', 'Orchestrator.RemoteInference', 'DB.use', 'Tooling.use', 'Scheduler.manage', 'TTS.use', 'STT.use']
  const roleDefaults = ROLE_TEMPLATES.flatMap((template) => template.permissions ?? [])
  const ordered: string[] = []
  const seen = new Set<string>()
  for (const list of [...permissionSets, roleDefaults, base]) {
    for (const permission of list) {
      if (!isPermissionAllowedOnSurface(permission, surfaceProfile)) continue
      if (!seen.has(permission)) {
        seen.add(permission)
        ordered.push(permission)
      }
    }
  }
  return ordered.map(toCatalogEntry)
}

export function RequestReviewDialog({
  peer,
  open,
  disabled,
  pending,
  permissions,
  surfaceProfile,
  onOpenChange,
  onPermissionsChange,
  onApprovePeer,
  onDenyPeer,
}: {
  peer: MeshPeerRow | null
  open: boolean
  disabled: boolean
  pending: boolean
  permissions: string
  surfaceProfile: AuroraSurfaceProfile
  onOpenChange: (open: boolean) => void
  onPermissionsChange: ((value: string) => void) | undefined
  onApprovePeer: ((peer: MeshPeerRow) => void) | undefined
  onDenyPeer: ((peer: MeshPeerRow) => void) | undefined
}) {
  const selected = parseMeshPermissionList(permissions) ?? []
  const filteredSelected = useMemo(() => selected.filter((permission) => isPermissionAllowedOnSurface(permission, surfaceProfile)), [selected, surfaceProfile])
  const catalog = useMemo(() => meshPermissionCatalog(surfaceProfile, peer?.permissions ?? [], filteredSelected), [peer?.peerId, filteredSelected, surfaceProfile])
  const checked: Record<string, boolean> = Object.fromEntries(filteredSelected.map((permission) => [permission, true]))
  const verificationCode = peer?.pendingPairing?.verification_code?.trim() || null
  const applyPermissions = (next: string[]) => onPermissionsChange?.(next.filter((permission) => isPermissionAllowedOnSurface(permission, surfaceProfile)).join(' '))
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Approve {peer?.nodeName ?? 'device'}</DialogTitle>
          <DialogDescription>Confirm that the verification code matches on both Auroras, then approve independently on this Aurora. Start from a role, then fine-tune below.</DialogDescription>
        </DialogHeader>
        {peer ? (
          <div className="flex flex-col gap-4">
            <div className="rounded-lg bg-muted/40 px-3.5 py-2.5 text-center text-xl">
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Verification code</p>
              <MeshVerificationCode value={verificationCode} />
            </div>
            {!verificationCode ? (
              <Alert variant="destructive" role="alert">
                <AlertDescription>This pairing request did not report a verification code. Do not approve it until both Auroras show the same code.</AlertDescription>
              </Alert>
            ) : null}
            <PermissionEditorTable
              catalog={catalog}
              checked={checked}
              roleTemplate={matchRoleTemplate(filteredSelected)}
              disabled={disabled}
              onSelectRoleTemplate={(templateId) => {
                const template = ROLE_TEMPLATES.find((entry) => entry.id === templateId)
                if (template?.permissions) applyPermissions(template.permissions)
              }}
              onToggle={(permissionId) => {
                const next = checked[permissionId] ? filteredSelected.filter((permission) => permission !== permissionId) : [...filteredSelected, permissionId]
                applyPermissions(next)
              }}
            />
          </div>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="destructive" disabled={disabled || pending || !peer?.denyAction} onClick={() => peer && onDenyPeer?.(peer)}>
            Refuse
          </Button>
          <Button type="button" disabled={disabled || pending || !peer?.approveAction || !verificationCode} onClick={() => peer && onApprovePeer?.(peer)}>
            Approve &amp; pair
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function EnumToggle({ value, options, disabled, onChange, ariaLabel }: { value: string; options: { value: string; label: string }[]; disabled?: boolean; onChange: (value: string) => void; ariaLabel?: string }) {
  return (
    <ToggleGroup variant="outline" value={[value]} disabled={disabled} aria-label={ariaLabel} onValueChange={(group: string[]) => {
      const next = group.find((entry) => entry !== value) ?? group[0]
      if (next) onChange(next)
    }}>
      {options.map((option) => (
        <ToggleGroupItem key={option.value} value={option.value} className="text-xs">
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

const SHARE_SCOPE_PRESETS: { value: string; label: string; permissions: string[] }[] = [
  { value: 'view-only', label: 'View only', permissions: [] },
  { value: 'assistant-use', label: 'Assistant use', permissions: ['Orchestrator.use'] },
  {
    value: 'full-tools',
    label: 'Full tool access',
    permissions: ['Orchestrator.use', 'Tooling.GetTools', 'Tooling.ExecuteTool'],
  },
]

function currentShareScope(permissions: string[]): string {
  const match = SHARE_SCOPE_PRESETS.find((preset) => preset.permissions.length === permissions.length && preset.permissions.every((permission) => permissions.includes(permission)))
  return match?.value ?? 'view-only'
}

export function MeshSettingsDialog({ open, snapshot, disabled, pendingKey, mutationError, onConfigChange, onOpenChange }: { open: boolean; snapshot: MeshPeersSnapshot; disabled: boolean; pendingKey: string | null; mutationError: string | null; onConfigChange: ((changes: MeshConfigChange[]) => void) | undefined; onOpenChange: (open: boolean) => void }) {
  const readOnly = disabled || Boolean(pendingKey) || !snapshot.config.editable || !onConfigChange
  const defaultPermissions = configArray(snapshot.config.fields, 'services.auth.default_pairing_permissions')
  const shareScope = currentShareScope(defaultPermissions)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] w-full overflow-y-auto" style={{ maxWidth: 'min(68rem, calc(100vw - 2rem))' }}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings2 /> Device connection settings
          </DialogTitle>
          <DialogDescription>
            Choose this device&apos;s name, connection behavior,
            security, and pairing defaults. Changes are reviewed before they
            take effect.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div aria-live="polite" className="empty:hidden">
            {mutationError ? (
              <Alert variant="destructive">
                <AlertTriangle />
                <AlertTitle>{meshSafeErrorTitle(mutationError)}</AlertTitle>
                <AlertDescription>Try again after Aurora finishes the current change.</AlertDescription>
              </Alert>
            ) : null}
            {pendingKey ? <p className="text-sm text-muted-foreground">Applying changes…</p> : null}
            {readOnly ? <p className="text-sm text-muted-foreground">Connection settings are read-only right now.</p> : null}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
            <div>
              <p className="text-[13px] font-medium">Default sharing for new devices</p>
              <p className="text-[11.5px] text-muted-foreground">
                Baseline permissions granted on approval. Fine-tune each device in Features.
              </p>
            </div>
            <EnumToggle
              ariaLabel="Default share scope"
              value={shareScope}
              disabled={readOnly}
              options={SHARE_SCOPE_PRESETS.map((preset) => ({ value: preset.value, label: preset.label }))}
              onChange={(value) => {
                const preset = SHARE_SCOPE_PRESETS.find((entry) => entry.value === value)
                if (!preset) return
                onConfigChange?.([{ keyPath: 'services.auth.default_pairing_permissions', value: preset.permissions }])
              }}
            />
          </div>
          <MeshConfigurationPanel snapshot={snapshot} disabled={disabled} pendingKey={pendingKey} onConfigChange={onConfigChange} />
        </div>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  )
}

function MeshConfigurationPanel({ snapshot, disabled, pendingKey, onConfigChange }: { snapshot: MeshPeersSnapshot; disabled: boolean; pendingKey: string | null; onConfigChange: ((changes: MeshConfigChange[]) => void) | undefined }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  useEffect(() => {
    setDrafts(Object.fromEntries(snapshot.config.fields.map((field) => [field.key_path, stringifyConfigValue(field.current_value ?? field.default ?? '')])))
  }, [snapshot.config.fields])
  const groups = groupConfigFields(snapshot.config.fields)
  const groupNames = Object.keys(groups)
  const [activeGroup, setActiveGroup] = useState<string | null>(null)
  const currentGroup = activeGroup && groupNames.includes(activeGroup) ? activeGroup : (groupNames[0] ?? null)
  const pending = Boolean(pendingKey)
  const changedFields = snapshot.config.fields.filter((field) => !field.secret && (drafts[field.key_path] ?? '') !== stringifyConfigValue(field.current_value ?? field.default ?? ''))
  const changedCount = changedFields.length
  const canApply = snapshot.config.editable && !disabled && !pending && changedCount > 0
  const applyChanges = () => {
    if (!canApply) return
    onConfigChange?.(
      changedFields.map((field) => ({
        keyPath: field.key_path,
        value: parseConfigValue(field, drafts[field.key_path] ?? ''),
      })),
    )
  }

  if (snapshot.config.fields.length === 0) {
    return <EmptyPanel title="Settings" description="Connection settings appear here when Aurora reports them." />
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={currentGroup ?? ''} onValueChange={(value) => setActiveGroup(String(value))}>
          <TabsList>
            {groupNames.map((group) => (
              <TabsTrigger key={group} value={group}>
                {group}
                {groups[group]?.some((field) => (drafts[field.key_path] ?? '') !== stringifyConfigValue(field.current_value ?? field.default ?? '') && !field.secret) ? <span aria-hidden className="ml-1 size-1.5 rounded-full bg-primary" /> : null}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex flex-wrap items-center gap-2">
          <MeshStateBadge state={snapshot.config.state} />
          {changedCount > 0 ? <Badge variant="secondary">{changedCount} changed</Badge> : null}
          <Button type="button" onClick={applyChanges} disabled={!canApply}>
            {pending ? 'Applying' : 'Apply changes'}
          </Button>
        </div>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {(currentGroup ? (groups[currentGroup] ?? []) : []).map((field) => {
          const fieldPending = pendingKey === field.key_path || pendingKey === '__batch__'
          const value = drafts[field.key_path] ?? ''
          const original = stringifyConfigValue(field.current_value ?? field.default ?? '')
          const changed = value !== original
          const readOnly = disabled || fieldPending || field.secret || !snapshot.config.editable
          return (
            <div key={field.key_path} className="grid gap-3 rounded-xl border border-border bg-background/60 p-3 transition-colors data-[changed=true]:border-primary/50 data-[changed=true]:bg-primary/5 sm:grid-cols-[minmax(0,1fr)_minmax(180px,240px)] sm:items-center" data-changed={changed || undefined}>
              <div className="min-w-0 space-y-1">
                <Label htmlFor={field.key_path} className="text-sm font-semibold normal-case tracking-normal">
                  {productConfigTitle(field)}
                </Label>
                <p className="line-clamp-2 text-xs text-muted-foreground">{productConfigDescription(field)}</p>
                <div className="flex flex-wrap gap-1">
                  {changed ? <Badge>changed</Badge> : null}
                  {field.secret ? <Badge variant="secondary">secret</Badge> : null}
                  {field.reload_required ? <Badge variant="outline">needs refresh</Badge> : null}
                  {field.restart_required ? <Badge variant="outline">needs attention</Badge> : null}
                </div>
              </div>
              <ConfigFieldControl
                field={field}
                value={value}
                disabled={readOnly}
                onChange={(next) =>
                  setDrafts((current) => ({
                    ...current,
                    [field.key_path]: next,
                  }))
                }
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}


function ConfigFieldControl({ field, value, disabled, onChange }: { field: ConfigFieldMetadata; value: string; disabled: boolean; onChange: (value: string) => void }) {
  if (disabled && value === '' && field.current_value == null && field.default == null) {
    return <div className="rounded-lg border border-border bg-background/50 p-3 text-sm text-muted-foreground">Not reported</div>
  }
  if (isBooleanConfigField(field)) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-border bg-background/50 p-3">
        <span className="text-sm text-muted-foreground">{value === 'true' ? 'Enabled' : 'Disabled'}</span>
        <Switch checked={value === 'true'} disabled={disabled} onCheckedChange={(checked) => onChange(String(Boolean(checked)))} />
      </div>
    )
  }
  if (field.choices && field.choices.length > 0) {
    return (
      <Select value={value} disabled={disabled} onValueChange={(next) => next && typeof next === 'string' && onChange(next)}>
        <SelectTrigger id={field.key_path} className="w-full" disabled={disabled}>
          <SelectValue placeholder="Select…" />
        </SelectTrigger>
        <SelectContent>
          {field.choices.map((choice) => (
            <SelectItem key={String(choice)} value={String(choice)}>
              {String(choice).replace(/_/g, ' ')}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  }
  if (isArrayConfigField(field)) {
    return <Textarea id={field.key_path} value={value} disabled={disabled} rows={3} onChange={(event) => onChange(event.currentTarget.value)} />
  }
  return <Input id={field.key_path} type={isNumberConfigField(field) ? 'number' : 'text'} value={value} disabled={disabled} onChange={(event) => onChange(event.currentTarget.value)} />
}

export function ScopesDialog({
  peer,
  open,
  disabled,
  lockMessage = null,
  pending,
  surfaceProfile,
  permissionCatalog,
  showRoleTemplates = true,
  showPermissionIds = true,
  onOpenChange,
  onSave,
}: {
  peer: MeshPeerRow | null
  open: boolean
  disabled: boolean
  lockMessage?: string | null
  pending: boolean
  surfaceProfile: AuroraSurfaceProfile
  permissionCatalog?: readonly PermissionCatalogEntry[] | undefined
  showRoleTemplates?: boolean | undefined
  showPermissionIds?: boolean | undefined
  onOpenChange: (open: boolean) => void
  onSave: ((peer: MeshPeerRow, permissions: string[]) => void) | undefined
}) {
  const [selected, setSelected] = useState<string[]>([])
  const activeDraftPeerIdRef = useRef<string | null>(null)
  const latestPeerRef = useRef<MeshPeerRow | null>(peer)
  latestPeerRef.current = peer
  const allowedPermissionIdsKey = permissionCatalog === undefined
    ? null
    : permissionCatalog.map((permission) => permission.id).sort().join('\u0000')
  const allowedPermissionIds = useMemo(
    () => allowedPermissionIdsKey === null
      ? null
      : new Set(allowedPermissionIdsKey ? allowedPermissionIdsKey.split('\u0000') : []),
    [allowedPermissionIdsKey],
  )
  const permissionAllowed = useCallback(
    (permission: string) =>
      isPermissionAllowedOnSurface(permission, surfaceProfile)
      && (!allowedPermissionIds || allowedPermissionIds.has(permission)),
    [allowedPermissionIds, surfaceProfile],
  )
  const latestPermissionAllowedRef = useRef(permissionAllowed)
  latestPermissionAllowedRef.current = permissionAllowed
  useEffect(() => {
    const currentPeer = latestPeerRef.current
    if (!open || !currentPeer) {
      activeDraftPeerIdRef.current = null
      setSelected([])
      return
    }
    if (activeDraftPeerIdRef.current === currentPeer.peerId) return
    activeDraftPeerIdRef.current = currentPeer.peerId
    setSelected(currentPeer.permissions.filter((permission) => latestPermissionAllowedRef.current(permission)))
  }, [open, peer?.peerId])
  useEffect(() => {
    setSelected((current) => current.filter(permissionAllowed))
  }, [permissionAllowed])
  const sanitizedSelected = useMemo(() => selected.filter(permissionAllowed), [permissionAllowed, selected])
  const catalog = useMemo(
    () => permissionCatalog
      ? [...permissionCatalog]
      : meshPermissionCatalog(surfaceProfile, peer?.permissions ?? [], sanitizedSelected),
    [peer?.peerId, permissionCatalog, sanitizedSelected, surfaceProfile],
  )
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Features{peer ? ` - ${peer.nodeName}` : ''}</DialogTitle>
          <DialogDescription>Choose what this device can use. The other device separately controls what it shares back.</DialogDescription>
        </DialogHeader>
        {lockMessage ? <p className="text-xs text-muted-foreground">{lockMessage}</p> : null}
        {peer && meshPeerScopesEditable(peer) ? (
          <PermissionEditorTable
            catalog={catalog}
            checked={Object.fromEntries(sanitizedSelected.map((permission) => [permission, true]))}
            roleTemplate={matchRoleTemplate(sanitizedSelected)}
            disabled={disabled}
            onSelectRoleTemplate={(templateId) => {
              const template = ROLE_TEMPLATES.find((entry) => entry.id === templateId)
              if (template?.permissions) setSelected(template.permissions.filter(permissionAllowed))
            }}
            onToggle={(permissionId) => setSelected((current) => (current.includes(permissionId) ? current.filter((permission) => permission !== permissionId) : [...current, permissionId]))}
            showRoleTemplates={showRoleTemplates}
            showPermissionIds={showPermissionIds}
          />
        ) : peer ? (
          <p className="text-sm text-muted-foreground">Review this pending pairing request and verify its exact code before sharing features.</p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={disabled || pending || !peer || !meshPeerScopesEditable(peer) || !onSave} onClick={() => peer && meshPeerScopesEditable(peer) && onSave?.(peer, sanitizedSelected)}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ConnectPeerDialog({ open, inviteUrl, inviteReadiness, inviteImport, initialInviteText, onScanQr, onApplyInvite, onOpenChange }: { open: boolean; inviteUrl: string | null; inviteReadiness: MeshInviteReadiness; inviteImport: MeshInviteImportOperation; initialInviteText: string | null; onScanQr: (() => Promise<string | null>) | undefined; onApplyInvite: ((invite: JsonObject) => void) | undefined; onOpenChange: (open: boolean) => void }) {
  const [copied, setCopied] = useState(false)
  const [mode, setMode] = useState<'invite' | 'join'>(initialInviteText ? 'join' : 'invite')
  const [joinText, setJoinText] = useState((initialInviteText ?? '').trim())
  const [scanError, setScanError] = useState<string | null>(null)
  const joinInvite = useMemo(() => decodeMeshInvite(joinText.trim()), [joinText])
  const joinSummary = useMemo(() => (joinInvite ? meshInviteSummary(joinInvite) : null), [joinInvite])
  const copyInvite = async () => {
    if (!inviteUrl) return
    await navigator.clipboard?.writeText(inviteUrl)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }
  const scanQr = async () => {
    if (!onScanQr) return
    setScanError(null)
    try {
      const scanned = await onScanQr()
      if (scanned) setJoinText(scanned.trim())
    } catch (error) {
      setScanError(meshPeerErrorMessage(error))
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Connect device</DialogTitle>
          <DialogDescription>Invite another device, or configure this device from an invite created elsewhere.</DialogDescription>
        </DialogHeader>
        <Tabs value={mode} onValueChange={(value) => setMode(String(value) === 'join' ? 'join' : 'invite')}>
          <TabsList>
            <TabsTrigger value="invite">Invite a device</TabsTrigger>
            <TabsTrigger value="join">Join from an invite</TabsTrigger>
          </TabsList>
        </Tabs>
        {mode === 'invite' ? (
          <div className="grid gap-4 lg:grid-cols-[1fr_260px]">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <KeyRound /> Invite
                </CardTitle>
                <CardDescription>
                  Share this private invite with the other device. Pairing starts after both devices are ready.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {!inviteReadiness.ready ? (
                  <Alert>
                    <Signal />
                    <AlertTitle>Secure mesh invite is not ready</AlertTitle>
                    <AlertDescription>{inviteReadiness.reason}</AlertDescription>
                  </Alert>
                ) : null}
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="mesh-invite-link" className="flex items-center gap-1.5">
                    <Link2 className="size-3.5" /> Invite link
                  </Label>
                  <Textarea id="mesh-invite-link" aria-label="Mesh invite link" className="min-h-16 break-all font-mono text-[11px]" value={inviteUrl ?? ''} placeholder="Enable mesh and wait for secure services to start." readOnly />
                  <p className="text-[11px] text-muted-foreground">The link includes sensitive connection details. Share it only through a private channel.</p>
                </div>
              </CardContent>
              <CardFooter className="justify-end">
                <Button type="button" onClick={copyInvite} disabled={!inviteUrl}>
                  <Copy data-icon="inline-start" /> {copied ? 'Copied' : 'Copy invite link'}
                </Button>
              </CardFooter>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <QrCode /> Invite QR
                </CardTitle>
                <CardDescription>Scan with the Aurora mobile app or any camera app.</CardDescription>
              </CardHeader>
              <CardContent className="flex justify-center">
                {inviteUrl ? <InviteQr value={inviteUrl} /> : <p className="text-sm text-muted-foreground">QR becomes available after secure mesh startup completes.</p>}
              </CardContent>
            </Card>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <RadioTower /> Join from an invite
                </CardTitle>
                <CardDescription>Paste or scan an invite to connect both devices. Pairing starts only after both devices are ready.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <Label htmlFor="mesh-join-invite">Invite link or code</Label>
                    {onScanQr ? (
                      <Button type="button" size="sm" variant="outline" disabled={inviteImport.pending} onClick={scanQr}>
                        <ScanLine data-icon="inline-start" /> Scan QR
                      </Button>
                    ) : null}
                  </div>
                  <Textarea id="mesh-join-invite" className="min-h-16 break-all font-mono text-[11px]" placeholder="aurora://mesh/invite?i=amv2.…" value={joinText} disabled={inviteImport.pending} onChange={(event) => setJoinText(event.currentTarget.value.trim())} />
                  {scanError ? <p className="text-sm text-destructive">{meshSafeErrorTitle(scanError)}</p> : null}
                  {joinText && !joinInvite ? <p className="text-sm text-muted-foreground">Not a recognizable Aurora mesh invite yet. Paste the full invite link or the invite code.</p> : null}
                </div>
                {joinSummary ? (
                  <div className="grid gap-2 sm:grid-cols-3">
                    <DetailItem label="Device" value={joinSummary.nodeName} />
                    <DetailItem label="Invite" value="Ready" />
                    <DetailItem label="Connection" value={joinSummary.brokerCount > 0 ? 'Available' : 'Needs attention'} />
                    <DetailItem label="Sensitive details" value={joinSummary.includesPassword ? 'Included' : 'Missing'} />
                    <DetailItem label="Created" value={joinSummary.generatedAt ? formatRelative(joinSummary.generatedAt) : 'unknown'} />
                  </div>
                ) : null}
                {joinSummary && !joinSummary.includesPassword ? (
                  <Alert variant="destructive">
                    <AlertTriangle />
                    <AlertTitle>Incomplete invite</AlertTitle>
                    <AlertDescription>This invite is incomplete. Ask the sender for a new invite.</AlertDescription>
                  </Alert>
                ) : null}
                <Button type="button" disabled={!joinInvite || inviteImport.pending || !onApplyInvite} onClick={() => joinInvite && onApplyInvite?.(joinInvite)}>
                  {inviteImport.pending ? 'Applying invite…' : 'Apply invite'}
                </Button>
                {inviteImport.appliedChangeCount !== null ? (
                  <Alert>
                    <ShieldCheck />
                    <AlertTitle>Invite applied</AlertTitle>
                    <AlertDescription>
                      Invite details were saved. Aurora will connect and show approval requests on both devices.
                    </AlertDescription>
                  </Alert>
                ) : null}
              </CardContent>
            </Card>
          </div>
        )}
        <Alert>
          <LockKeyhole />
          <AlertTitle>Private invitation</AlertTitle>
          <AlertDescription>The invite includes sensitive connection details. Share it only through a private channel.</AlertDescription>
        </Alert>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  )
}

function InviteQr({ value }: { value: string }) {
  const [svg, setSvg] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void import('qrcode')
      .then((module) => module.toString(value, { type: 'svg', margin: 1, width: 220 }))
      .then((next) => {
        if (!cancelled) setSvg(next)
      })
      .catch(() => {
        if (!cancelled) setSvg(null)
      })
    return () => {
      cancelled = true
    }
  }, [value])
  if (!svg) return <Skeleton className="size-56" aria-label="Generating QR code" />
  return (
    <div className="rounded-lg bg-background p-2 ring-1 ring-border">
      <img
        alt="Aurora device invitation QR code"
        className="size-56"
        src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
      />
    </div>
  )
}

export {
  DiscoveredDevicesCard,
  MeshSummaryCards,
  PeerCardGrid,
  PeerDetailSheet,
  PeerTable,
  PendingRequestsTable,
} from './mesh-peers-roster'

export {
  DevicesPanel,
  LiveSessionsPanel,
  MeshRuntimeOverview,
  WarningsPanel,
} from './mesh-peers-stats'
export {
  buildMeshDeviceRows,
  buildMeshInvitePayload,
  buildMeshLiveSessionRows,
  buildMeshPeerAdminAction,
  buildMeshPeerRows,
  buildMeshPendingRequestRows,
  buildMeshScopesAdminAction,
  buildRuntimeConfigFields,
  capabilityFor,
  capabilityReason,
  configArray,
  configBoolean,
  configField,
  failureMessage,
  groupConfigFields,
  firstCapability,
  isArrayConfigField,
  isBooleanConfigField,
  isDeniedFailure,
  isNumberConfigField,
  isPendingPairing,
  meshConfigKeyPaths,
  meshInviteReadiness,
  meshPeerActionIdentity,
  meshPeerErrorMessage,
  meshPeerScopesEditable,
  meshSafeErrorTitle,
  parseConfigValue,
  parseMeshPermissionList,
  peerInitials,
  productConfigDescription,
  productConfigTitle,
  responseDataOrNull,
  stringifyConfigValue,
  skippedMeshAuthRead,
  sortConfigFields,
  stateFromCapability,
  connectionRoundTripTimeMs,
  uniqueStrings,
  isExpectedOfflineTransportMessage,
  valueOrNull,
  withUiTimeout,
  MeshVerificationCode,
} from './mesh-peers-model'
export type { MeshInviteReadiness } from './mesh-peers-model'
