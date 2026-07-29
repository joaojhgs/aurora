import type { ReactNode } from 'react'
import type { AvailabilityState, PrivacyClass } from '@aurora/client'
import { Cloud, Laptop, Network, ShieldCheck } from 'lucide-react'
import { Badge } from '#components/ui/badge'
import { cn } from '#lib/utils'

export function StatusBadge({ state }: { state: AvailabilityState }) {
  return <Badge variant={statusVariant(state)}>{statusLabel(state)}</Badge>
}

export function PrivacyBadge({ privacy }: { privacy: PrivacyClass | string }) {
  return <Badge variant={privacyVariant(privacy)}>{privacyLabel(privacy)}</Badge>
}

export function EvidenceBadge({ label }: { label: string }) {
  return <Badge variant="outline">{presentableSignal(label)}</Badge>
}

/**
 * Local vs Remote vs Mesh Peer routing pill - matches the prototype's `Aurora.RouteBadge`.
 * Named `RouteKindBadge` (not `RouteBadge`) to avoid colliding with the unrelated
 * `RouteBadge` already exported from `./state-surface` (nav-route diagnostics chip).
 */
export type RouteKind = 'Local' | 'Remote' | 'Mesh Peer'

export function RouteKindBadge({ route, className }: { route: RouteKind | string; className?: string }) {
  const icon = route === 'Local' ? <Laptop /> : route === 'Mesh Peer' ? <Network /> : <Cloud />
  return (
    <Badge variant="secondary" className={cn('gap-1', className)}>
      <span data-icon="inline-start" aria-hidden>
        {icon}
      </span>
      {route}
    </Badge>
  )
}

/** Desktop Local / Desktop Thin / Mobile topbar pill - `Aurora.ModeBadge`. */
export function ModeBadge({ mode, className }: { mode: string; className?: string }) {
  return (
    <Badge variant="outline" className={cn('gap-1 font-normal', className)}>
      <Laptop data-icon="inline-start" aria-hidden />
      {mode}
    </Badge>
  )
}

/** Healthy / Degraded / Offline topbar pill - `Aurora.HealthBadge`. */
export function HealthBadge({ health, className }: { health: string; className?: string }) {
  const normalized = health.toLowerCase()
  const tone =
    normalized === 'healthy'
      ? 'border-success/30 bg-success/10 text-success'
      : normalized === 'degraded'
        ? 'border-warning/30 bg-warning/10 text-warning'
        : 'border-destructive/30 bg-destructive/10 text-destructive'
  return (
    <Badge variant="outline" className={cn('gap-1', tone, className)}>
      <ShieldCheck data-icon="inline-start" aria-hidden />
      {health}
    </Badge>
  )
}

/** Admin / Member identity pill - `Aurora.IdentityBadge`. */
export function IdentityBadge({ identity, className }: { identity: string; className?: string }) {
  return <Badge variant="secondary" className={className}>{identity}</Badge>
}

export type BadgeTone = 'success' | 'warning' | 'danger' | 'neutral'

const TONE_CLASS: Record<BadgeTone, string> = {
  success: 'border-success/30 bg-success/10 text-success',
  warning: 'border-warning/30 bg-warning/10 text-warning',
  danger: 'border-destructive/30 bg-destructive/10 text-destructive',
  neutral: 'border-border bg-muted text-muted-foreground'
}

/**
 * Single tone-to-pill mapper replacing the prototype's four near-duplicate
 * `riskToneClass`/`trustToneClass`/`stateToneClass`/`peerStatusClass` helpers
 * (`Aurora Cockpit.dc.html:2891-2925`). Screens map their own domain string
 * (risk/trust/state/status) to a `BadgeTone` and render with this component.
 */
export function ToneBadge({ tone, children, className }: { tone: BadgeTone; children: ReactNode; className?: string }) {
  return (
    <Badge variant="outline" className={cn(TONE_CLASS[tone], className)}>
      {children}
    </Badge>
  )
}

export function riskTone(risk: string): BadgeTone {
  if (risk === 'read-only') return 'success'
  if (risk === 'external' || risk === 'mutating') return 'warning'
  if (risk === 'admin') return 'danger'
  return 'neutral'
}

export function trustTone(trust: string): BadgeTone {
  if (trust === 'trusted') return 'success'
  if (trust === 'approval-required' || trust === 'quarantined' || trust === 'mixed') return 'warning'
  if (trust === 'blocked') return 'danger'
  return 'neutral'
}

export function stateTone(state: string): BadgeTone {
  if (state === 'approved' || state === 'active') return 'success'
  if (state === 'pending') return 'warning'
  if (state === 'denied' || state === 'revoked') return 'danger'
  return 'neutral'
}

export function presentableSignal(label: string): string {
  const normalized = label.trim()
  if (/^mock$/i.test(normalized)) return 'Local'
  if (/^demo transport$/i.test(normalized)) return 'Local mode'
  if (/service contract pending/i.test(normalized)) return 'Pending'
  if (/capability_not_advertised/i.test(normalized)) return 'Not ready'
  if (/^local\s*\//i.test(normalized)) return 'Local'
  if (/^mesh\s*\//i.test(normalized)) return 'Mesh'
  if (/^remote\s*\//i.test(normalized)) return 'Remote'
  if (/^cloud\s*\//i.test(normalized)) return 'Cloud'
  if (/^native[:/]/i.test(normalized)) return 'Native'
  return label
    .split('Local transport').join('Local mode')
    .split('No service state').join('Not ready')
    .split('evidence').join('state')
    .replace(/evidence/gi, 'State')
    .split('mock').join('Local')
    .split('demo only').join('local preview')
    .split('demo').join('local')
}

function statusLabel(state: AvailabilityState): string {
  switch (state) {
    case 'available-local':
      return 'Local'
    case 'available-remote':
      return 'Remote'
    case 'privacy-blocked':
      return 'Needs consent'
    case 'degraded':
      return 'Degraded'
    case 'denied':
      return 'Denied'
    case 'stale':
      return 'Stale'
    case 'pending':
      return 'Pending'
    case 'unsupported':
      return 'Not ready'
    case 'offline':
      return 'Offline'
    default:
      return titleCaseToken(state)
  }
}

function statusVariant(state: AvailabilityState): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (state) {
    case 'available-local':
    case 'available-remote':
      return 'default'
    case 'denied':
    case 'privacy-blocked':
      return 'destructive'
    case 'degraded':
    case 'stale':
    case 'pending':
      return 'secondary'
    default:
      return 'outline'
  }
}

function privacyVariant(privacy: PrivacyClass | string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (privacy === 'admin-critical' || privacy === 'secret' || privacy === 'credential') return 'destructive'
  if (privacy === 'sensitive' || privacy === 'raw-audio') return 'secondary'
  return 'outline'
}

function privacyLabel(privacy: PrivacyClass | string): string {
  switch (privacy) {
    case 'public':
      return 'Public'
    case 'personal':
      return 'Personal'
    case 'sensitive':
      return 'Sensitive'
    case 'secret':
      return 'Secret'
    case 'credential':
      return 'Credential'
    case 'raw-audio':
      return 'Microphone audio'
    case 'admin-critical':
      return 'Administrator action'
    default:
      return 'Sensitive'
  }
}

function titleCaseToken(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}
