'use client'

import { useMemo, useState, type CSSProperties } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Check, ChevronDown, CircleHelp, Users, X } from 'lucide-react'
import type {
  ToolApprovalCardModel,
  ToolExportDecisionModel,
  ToolExportPolicyModel,
  ToolExportPrerequisiteModel,
  ToolExportScopeModel
} from '@aurora/client'
import { Badge } from '#components/ui/badge'
import { Button } from '#components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '#components/ui/command'
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger
} from '#components/ui/popover'
import { ToggleGroup, ToggleGroupItem } from '#components/ui/toggle-group'
import { Spinner } from '#components/ui/spinner'
import { cn } from '#lib/utils'
import { ToneBadge } from '../status-badges'

const SELECTED_SEGMENT_STYLE: CSSProperties = {
  backgroundColor: 'color-mix(in oklab, var(--primary) 22%, var(--muted))',
  color: 'var(--primary)',
  boxShadow: 'inset 0 0 0 1px color-mix(in oklab, var(--primary) 38%, transparent)'
}

export type ToolExportState = 'shared' | 'unshared'
export type ToolSharingMode = 'inherit' | ToolExportState

export interface ToolSharingMutation {
  scopeType: 'group' | 'tool'
  scopeId: string
  mode: ToolSharingMode
  /** Null means every peer; otherwise these stable peer IDs are the complete audience. */
  peerIds: Array<string | null>
}

export interface ToolSharingRowControlProps {
  tool: ToolApprovalCardModel
  policy: ToolExportPolicyModel | null
  peers: ToolExportScopeModel[]
  decision: ToolExportDecisionModel | null
  loading?: boolean
  error?: string | null
  message?: string | null
  pending?: boolean
  onMutate?: (mutation: ToolSharingMutation) => void
}

export interface ToolSharingGroupControlProps {
  groupId: string
  groupLabel: string
  policy: ToolExportPolicyModel | null
  peers: ToolExportScopeModel[]
  loading?: boolean
  error?: string | null
  message?: string | null
  pending?: boolean
  onMutate?: (mutation: ToolSharingMutation) => void
}

const ALL_PEERS: ToolExportScopeModel = { peerId: null, label: 'All peers', stale: false }

export function ToolSharingGroupControl({
  groupId,
  groupLabel,
  policy,
  peers,
  loading = false,
  error = null,
  message = null,
  pending = false,
  onMutate
}: ToolSharingGroupControlProps) {
  return (
    <ToolSharingPolicyControl
      scopeType="group"
      scopeId={groupId}
      ariaLabel={`Mesh sharing for ${groupLabel} group`}
      label="Tool sharing"
      description={`Choose whether ${groupLabel} tools are advertised to mesh peers.`}
      policy={policy}
      peers={peers}
      loading={loading}
      error={error}
      message={message}
      pending={pending}
      {...(onMutate ? { onMutate } : {})}
    />
  )
}

export function ToolSharingRowControl({
  tool,
  policy,
  peers,
  decision,
  loading = false,
  error = null,
  message = null,
  pending = false,
  onMutate
}: ToolSharingRowControlProps) {
  if (!isLocalExportCandidate(tool)) {
    return (
      <div className="py-2.5" role="group" aria-label={`Mesh sharing for ${tool.name}`}>
        <div className="flex flex-wrap items-center gap-2">
          <strong className="text-xs">Tool sharing</strong>
          <ToneBadge tone="neutral">Remote tool · not re-shareable</ToneBadge>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">Change sharing on {tool.providerLabel || 'the provider device'}.</p>
      </div>
    )
  }

  return (
    <ToolSharingPolicyControl
      compact
      scopeType="tool"
      scopeId={tool.id}
      ariaLabel={`Mesh sharing for ${tool.name}`}
      label="Tool sharing"
      description="Override sharing for this tool."
      policy={policy}
      peers={peers}
      loading={loading}
      error={error}
      message={message}
      pending={pending}
      decision={decision}
      {...(onMutate ? { onMutate } : {})}
    />
  )
}

function ToolSharingPolicyControl({
  scopeType,
  scopeId,
  ariaLabel,
  label,
  description,
  policy,
  peers,
  loading,
  error,
  message,
  pending,
  compact = false,
  decision = null,
  onMutate
}: {
  scopeType: 'group' | 'tool'
  scopeId: string
  ariaLabel: string
  label: string
  description: string
  policy: ToolExportPolicyModel | null
  peers: ToolExportScopeModel[]
  loading: boolean
  error: string | null
  message: string | null
  pending: boolean
  compact?: boolean
  decision?: ToolExportDecisionModel | null
  onMutate?: (mutation: ToolSharingMutation) => void
}) {
  const scopes = useMemo(() => mergeScopes(peers, policy), [peers, policy])
  const configuration = sharingConfiguration(policy, scopeType, scopeId)
  const disabled = !policy || pending

  function changeMode(mode: ToolSharingMode) {
    if (mode === configuration.mode || disabled) return
    const peerIds = mode === 'shared'
      ? configuration.peerIds.length > 0 ? configuration.peerIds : [null]
      : []
    onMutate?.({ scopeType, scopeId, mode, peerIds })
  }

  function changeAudience(peerIds: Array<string | null>) {
    if (disabled || peerIds.length === 0) return
    onMutate?.({ scopeType, scopeId, mode: 'shared', peerIds })
  }

  return (
    <div
      className={cn(
        'min-w-0',
        compact ? 'py-2.5' : 'py-3'
      )}
      role="group"
      aria-label={ariaLabel}
    >
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-col gap-0.5">
          <strong className={cn(compact ? 'text-xs' : 'text-sm')}>{label}</strong>
          <span className="text-xs text-muted-foreground">{description}</span>
        </div>
        <PolicySegmentedControl
          value={configuration.mode}
          compact={compact}
          disabled={disabled}
          pending={pending}
          ariaLabel={`${label} policy`}
          onValueChange={changeMode}
        />
      </div>

      <AnimatePresence initial={false}>
        {configuration.mode === 'shared' ? (
          <motion.div
            key="sharing-audience"
            initial={{ height: 0, opacity: 0, y: -4 }}
            animate={{ height: 'auto', opacity: 1, y: 0 }}
            exit={{ height: 0, opacity: 0, y: -4 }}
            transition={{ duration: 0.16, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div className={cn('flex flex-wrap items-center gap-2', compact ? 'mt-1.5' : 'mt-2')}>
              <span className="text-xs font-medium">Share with</span>
              <PeerMultiSelect
                peers={scopes}
                selectedPeerIds={configuration.peerIds}
                compact={compact}
                disabled={disabled}
                onValueChange={changeAudience}
              />
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {decision && compact ? <EffectiveDecision decision={decision} /> : null}
      {loading ? <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground" role="status"><Spinner /> Loading sharing state…</p> : null}
      {error ? <p className="mt-2 text-xs text-destructive" role="alert">{error}</p> : null}
      {message ? <p className="mt-2 text-xs text-muted-foreground" aria-live="polite">{message}</p> : null}
      {!policy ? <p className="mt-2 text-xs text-muted-foreground">Sharing policy unavailable.</p> : null}
    </div>
  )
}

export function PolicySegmentedControl({
  value,
  compact = false,
  disabled = false,
  pending = false,
  ariaLabel,
  onValueChange
}: {
  value: ToolSharingMode
  compact?: boolean
  disabled?: boolean
  pending?: boolean
  ariaLabel: string
  onValueChange: (value: ToolSharingMode) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <ToggleGroup
        value={[value]}
        onValueChange={(values) => {
          const next = values[0] as ToolSharingMode | undefined
          if (next) onValueChange(next)
        }}
        variant="default"
        size={compact ? 'sm' : 'default'}
        spacing={1}
        disabled={disabled}
        aria-label={ariaLabel}
        className="bg-background/60 p-1 shadow-inner"
      >
        <ToggleGroupItem
          className={cn(
            'bg-muted/60 text-foreground/75 shadow-sm transition-colors hover:bg-muted hover:text-foreground',
            value === 'inherit' && 'font-medium shadow-none'
          )}
          style={value === 'inherit' ? SELECTED_SEGMENT_STYLE : undefined}
          value="inherit"
          aria-label="Inherit sharing policy"
        >
          Inherit
        </ToggleGroupItem>
        <ToggleGroupItem
          className={cn(
            'bg-muted/60 text-foreground/75 shadow-sm transition-colors hover:bg-muted hover:text-foreground',
            value === 'shared' && 'font-medium shadow-none'
          )}
          style={value === 'shared' ? SELECTED_SEGMENT_STYLE : undefined}
          value="shared"
          aria-label="Share tools"
        >
          Shared
        </ToggleGroupItem>
        <ToggleGroupItem
          className={cn(
            'bg-muted/60 text-foreground/75 shadow-sm transition-colors hover:bg-muted hover:text-foreground',
            value === 'unshared' && 'font-medium shadow-none'
          )}
          style={value === 'unshared' ? SELECTED_SEGMENT_STYLE : undefined}
          value="unshared"
          aria-label="Do not share tools"
        >
          Not shared
        </ToggleGroupItem>
      </ToggleGroup>
      {pending ? <Spinner aria-label="Saving" /> : null}
    </div>
  )
}

function PeerMultiSelect({
  peers,
  selectedPeerIds,
  compact,
  disabled,
  onValueChange
}: {
  peers: ToolExportScopeModel[]
  selectedPeerIds: Array<string | null>
  compact: boolean
  disabled: boolean
  onValueChange: (peerIds: Array<string | null>) => void
}) {
  const [open, setOpen] = useState(false)
  const allSelected = selectedPeerIds.includes(null)
  const selectedIds = new Set(selectedPeerIds.filter((peerId): peerId is string => peerId !== null))
  const label = allSelected
    ? 'All peers'
    : selectedIds.size === 1
      ? peerLabel(peers, [...selectedIds][0]!)
      : `${selectedIds.size} peers`

  function togglePeer(peerId: string | null) {
    if (peerId === null) {
      onValueChange([null])
      return
    }
    const next = new Set(allSelected ? [] : selectedIds)
    if (next.has(peerId)) next.delete(peerId)
    else next.add(peerId)
    if (next.size > 0) onValueChange([...next])
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={(
          <Button
            variant="outline"
            size={compact ? 'sm' : 'default'}
            disabled={disabled}
            aria-label="Choose peers to share with"
            className="min-w-36 justify-between border-0 bg-muted/80 text-foreground shadow-sm hover:bg-muted"
          />
        )}
      >
        <Users data-icon="inline-start" />
        <span className="max-w-40 truncate">{label}</span>
        <ChevronDown data-icon="inline-end" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <PopoverHeader className="px-3 pt-3">
          <PopoverTitle>Share with peers</PopoverTitle>
          <PopoverDescription>Select one or more recipients. Stable peer IDs remain the policy keys.</PopoverDescription>
        </PopoverHeader>
        <Command>
          <CommandInput placeholder="Search peers…" />
          <CommandList>
            <CommandEmpty>No peers found.</CommandEmpty>
            <CommandGroup>
              {peers.map((peer) => {
                const selected = peer.peerId === null ? allSelected : selectedIds.has(peer.peerId)
                return (
                  <CommandItem
                    key={peer.peerId ?? '__all__'}
                    value={`${peer.label} ${peer.peerId ?? 'all peers'}`}
                    data-checked={selected}
                    onSelect={() => togglePeer(peer.peerId)}
                  >
                    <span className="min-w-0 flex-1 truncate">{peer.label}{duplicateLabelSuffix(peer, peers)}</span>
                    {peer.stale ? <Badge variant="outline">stale</Badge> : null}
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function sharingConfiguration(
  policy: ToolExportPolicyModel | null,
  scopeType: 'group' | 'tool',
  scopeId: string
): { mode: ToolSharingMode; peerIds: Array<string | null> } {
  const rules = policy?.rules.filter((rule) => rule.scopeType === scopeType && rule.scopeId === scopeId) ?? []
  const globalRule = rules.find((rule) => rule.peerId === null)
  const sharedPeerIds = rules
    .filter((rule) => rule.peerId !== null && rule.state === 'shared')
    .map((rule) => rule.peerId!)

  if (globalRule?.state === 'shared') return { mode: 'shared', peerIds: [null] }
  if (sharedPeerIds.length > 0) return { mode: 'shared', peerIds: sharedPeerIds }
  if (globalRule?.state === 'unshared') return { mode: 'unshared', peerIds: [] }
  return { mode: 'inherit', peerIds: [] }
}

function EffectiveDecision({ decision }: { decision: Pick<ToolExportDecisionModel, 'effectiveState' | 'inheritedFromLabel'> }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
      <ToneBadge tone={decision.effectiveState === 'shared' ? 'success' : 'danger'}>{decision.effectiveState === 'shared' ? 'Shared' : 'Not shared'}</ToneBadge>
      <span className="text-muted-foreground">Effective via {decision.inheritedFromLabel}</span>
    </div>
  )
}

export function decisionSourceLabel(source: ToolExportDecisionModel['inheritedFrom'], peerLabel: string): string {
  switch (source) {
    case 'peer_tool': return `Exact tool for ${peerLabel}`
    case 'global_tool': return 'Exact tool for all peers'
    case 'peer_group': return `Group default for ${peerLabel}`
    case 'global_group': return 'Group default for all peers'
    case 'global_default': return 'Global default'
    default: return String(source).split('_').join(' ')
  }
}

export function PrerequisiteChecklist({ rows, reasonCode }: { rows: ToolExportPrerequisiteModel[]; reasonCode: string | null }) {
  return (
    <div className="mt-2 rounded-md bg-muted/40 p-2.5">
      <ul className="grid gap-1.5 sm:grid-cols-2">
        {rows.map((row) => (
          <li key={row.key} className={cn('flex items-start gap-1.5 text-xs', row.state === 'blocked' && 'text-destructive')}>
            {row.state === 'satisfied' ? <Check aria-hidden /> : row.state === 'blocked' ? <X aria-hidden /> : <CircleHelp aria-hidden />}
            <span className="min-w-0">
              <strong>{row.state === 'satisfied' ? 'Satisfied' : row.state === 'blocked' ? 'Blocked' : row.state === 'not_applicable' ? 'Not applicable' : 'Unknown'}:</strong> {row.label}
              <span className="block break-words text-[11px] opacity-80">Evidence: {row.source ?? 'not reported'} · {row.reasonCode ?? 'no reason code'}</span>
              {row.requiredPermissions.length > 0 ? <span className="block break-words text-[11px] opacity-80">Required: {row.requiredPermissions.join(', ')} · Observed: {row.observedPermissions.join(', ') || 'none'}</span> : null}
            </span>
          </li>
        ))}
      </ul>
      {reasonCode ? <details className="mt-2"><summary>Decision reason</summary><code>{reasonCode}</code></details> : null}
    </div>
  )
}

function mergeScopes(peers: ToolExportScopeModel[], policy: ToolExportPolicyModel | null): ToolExportScopeModel[] {
  const merged = new Map<string | null, ToolExportScopeModel>([[null, ALL_PEERS]])
  for (const scope of [...peers, ...(policy?.scopes ?? [])]) merged.set(scope.peerId, scope)
  return [...merged.values()]
}

function isLocalExportCandidate(tool: ToolApprovalCardModel): boolean {
  return tool.exportable === true && tool.sourceType !== 'mesh_peer' && !/mesh|remote/i.test(tool.providerKind)
}

function duplicateLabelSuffix(scope: ToolExportScopeModel, scopes: ToolExportScopeModel[]): string {
  if (!scope.peerId || scopes.filter((candidate) => candidate.label === scope.label).length < 2) return ''
  return ` · ${scope.peerId.slice(-6)}`
}

function peerLabel(peers: ToolExportScopeModel[], peerId: string): string {
  return peers.find((peer) => peer.peerId === peerId)?.label ?? 'Selected peer'
}
