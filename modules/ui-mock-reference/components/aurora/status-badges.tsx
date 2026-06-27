import {
  Cpu,
  Globe,
  Laptop,
  Lock,
  Network,
  ShieldAlert,
  ShieldCheck,
  Signal,
  Smartphone,
  User,
  WifiOff,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type {
  AvailabilityState,
  BackendCoverage,
  ContractExposure,
  ContractMethodType,
  DeploymentMode,
  HealthState,
  IdentityState,
  PrivacyClass,
  RouteKind,
} from '@/lib/aurora/types'

type Tone = 'success' | 'warning' | 'destructive' | 'info' | 'neutral' | 'primary'

const toneClass: Record<Tone, string> = {
  success: 'border-success/30 bg-success/10 text-success',
  warning: 'border-warning/30 bg-warning/10 text-warning',
  destructive: 'border-destructive/30 bg-destructive/10 text-destructive',
  info: 'border-info/30 bg-info/10 text-info',
  primary: 'border-primary/30 bg-primary/10 text-primary',
  neutral: 'border-border bg-muted/60 text-muted-foreground',
}

function StatusPill({
  tone,
  icon: Icon,
  label,
  className,
  dot,
  title,
}: {
  tone: Tone
  icon?: LucideIcon
  label: string
  className?: string
  dot?: boolean
  title?: string
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        toneClass[tone],
        className,
      )}
    >
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {Icon && <Icon className="size-3.5" aria-hidden />}
      {label}
    </span>
  )
}

const modeMeta: Record<DeploymentMode, { tone: Tone; icon: LucideIcon; title: string }> = {
  Server: { tone: 'info', icon: Globe, title: 'Browser/web UI connected to HTTP Gateway.' },
  'Desktop Local': { tone: 'success', icon: Laptop, title: 'Tauri desktop shell with local Aurora node/sidecar.' },
  'Desktop Thin': { tone: 'info', icon: Laptop, title: 'Desktop shell connected to a remote Gateway.' },
  Mesh: { tone: 'primary', icon: Network, title: 'UI shell routes through trusted P2P mesh peers.' },
  Android: { tone: 'info', icon: Smartphone, title: 'Android Tauri/mobile shell; native permissions and assistant role are capability-gated.' },
  iOS: { tone: 'info', icon: Smartphone, title: 'iOS shell with Siri/Shortcuts/App Intents and share-sheet integration.' },
  Offline: { tone: 'neutral', icon: WifiOff, title: 'Fixture/offline mode for demo and visual review.' },
  Hybrid: { tone: 'primary', icon: Network, title: 'Combines local, server, mesh and native route candidates.' },
}

export function ModeBadge({ mode, className }: { mode: DeploymentMode; className?: string }) {
  const m = modeMeta[mode]
  return <StatusPill tone={m.tone} icon={m.icon} label={mode} title={m.title} className={className} />
}

const routeMeta: Record<RouteKind, { tone: Tone; icon: LucideIcon; title: string }> = {
  Local: { tone: 'success', icon: Laptop, title: 'Runs on the current local node/device where available.' },
  Remote: { tone: 'info', icon: Globe, title: 'Routes through HTTP Gateway; privacy preview required for sensitive data.' },
  'Mesh Peer': { tone: 'primary', icon: Network, title: 'Routes through a trusted peer; peer permissions and route policy apply.' },
  'Native Mobile': { tone: 'info', icon: Smartphone, title: 'Uses Android/iOS native capability or mobile local-light runtime.' },
  Fallback: { tone: 'warning', icon: Signal, title: 'Fallback route; lower capability or higher privacy friction.' },
  Unknown: { tone: 'neutral', icon: Signal, title: 'Route is not yet resolved by the capability graph.' },
}

export function RouteBadge({ route, className }: { route: RouteKind; className?: string }) {
  const m = routeMeta[route]
  return <StatusPill tone={m.tone} icon={m.icon} label={route} title={m.title} className={className} />
}

const privacyMeta: Record<PrivacyClass, { tone: Tone; label: string; title: string }> = {
  public: { tone: 'neutral', label: 'Public', title: 'Safe for remote routes unless action policy says otherwise.' },
  personal: { tone: 'success', label: 'Personal', title: 'Prefer local/mesh trusted routes; remote fallback is policy-controlled.' },
  sensitive: { tone: 'warning', label: 'Sensitive', title: 'Requires explicit route preview before remote or mesh dispatch.' },
  secret: { tone: 'destructive', label: 'Secret · local-only', title: 'Must stay local/native unless a future policy explicitly permits otherwise.' },
  'raw-audio': { tone: 'warning', label: 'Raw audio', title: 'Requires microphone/native permission and redaction-aware diagnostics.' },
  credential: { tone: 'destructive', label: 'Credential', title: 'Use secure storage; never expose in logs or diagnostics bundles.' },
  'admin-critical': { tone: 'destructive', label: 'Admin-critical', title: 'Requires admin action confirmation, reason and audit receipt.' },
}

export function PrivacyBadge({ privacy, className }: { privacy: PrivacyClass; className?: string }) {
  const m = privacyMeta[privacy]
  const Icon = m.tone === 'destructive' ? Lock : ShieldCheck
  return <StatusPill tone={m.tone} icon={Icon} label={m.label} title={m.title} className={className} />
}

const identityMeta: Record<IdentityState, { tone: Tone; icon: LucideIcon }> = {
  Anonymous: { tone: 'neutral', icon: User },
  Pairing: { tone: 'warning', icon: User },
  User: { tone: 'info', icon: User },
  Admin: { tone: 'primary', icon: ShieldCheck },
  'Mesh peer': { tone: 'primary', icon: Network },
  Expired: { tone: 'destructive', icon: ShieldAlert },
}

export function IdentityBadge({ identity, className }: { identity: IdentityState; className?: string }) {
  const m = identityMeta[identity]
  return <StatusPill tone={m.tone} icon={m.icon} label={identity} className={className} />
}

const healthMeta: Record<HealthState, Tone> = {
  Healthy: 'success',
  Degraded: 'warning',
  Offline: 'destructive',
  Starting: 'info',
  'Needs attention': 'warning',
}

export function HealthBadge({ health, className }: { health: HealthState; className?: string }) {
  return <StatusPill tone={healthMeta[health]} dot label={health} className={className} />
}

const availabilityMeta: Record<AvailabilityState, { tone: Tone; label: string }> = {
  available: { tone: 'success', label: 'Available' },
  degraded: { tone: 'warning', label: 'Degraded' },
  read_only: { tone: 'info', label: 'Read-only' },
  remote_only: { tone: 'info', label: 'Remote-only' },
  local_only: { tone: 'success', label: 'Local-only' },
  needs_auth: { tone: 'warning', label: 'Needs auth' },
  needs_pairing: { tone: 'warning', label: 'Needs pairing' },
  needs_permission: { tone: 'warning', label: 'Needs permission' },
  needs_native_permission: { tone: 'warning', label: 'Needs OS permission' },
  missing_service: { tone: 'destructive', label: 'Missing service' },
  unsupported_platform: { tone: 'neutral', label: 'Unsupported' },
  unknown: { tone: 'neutral', label: 'Unknown' },
  error: { tone: 'destructive', label: 'Error' },
}

export function CapabilityStateBadge({
  state,
  className,
}: {
  state: AvailabilityState
  className?: string
}) {
  const m = availabilityMeta[state]
  return <StatusPill tone={m.tone} label={m.label} className={className} />
}

const coverageMeta: Record<BackendCoverage, { tone: Tone; label: string }> = {
  implemented: { tone: 'success', label: 'backend implemented' },
  partial: { tone: 'warning', label: 'backend partial' },
  internal_only: { tone: 'info', label: 'internal-only' },
  missing_contract: { tone: 'destructive', label: 'missing contract' },
  planned: { tone: 'neutral', label: 'planned' },
  mock_only: { tone: 'warning', label: 'mock-only' },
}

export function BackendCoverageBadge({ coverage, className }: { coverage: BackendCoverage; className?: string }) {
  const m = coverageMeta[coverage]
  return <StatusPill tone={m.tone} label={m.label} className={cn('px-1.5 py-0 text-[10px]', className)} />
}

const exposureTone: Record<ContractExposure, Tone> = {
  internal: 'warning',
  external: 'info',
  both: 'success',
  gateway_builtin: 'primary',
  planned: 'neutral',
}

export function ExposureBadge({ exposure, className }: { exposure: ContractExposure; className?: string }) {
  return <StatusPill tone={exposureTone[exposure]} label={exposure.replace('_', ' ')} className={cn('px-1.5 py-0 font-mono text-[10px] uppercase', className)} />
}

export function MethodTypeBadge({ type }: { type: ContractMethodType | string }) {
  const tone: Tone =
    type === 'manage'
      ? 'destructive'
      : type === 'use' || type === 'gateway'
        ? 'info'
        : type === 'event'
          ? 'primary'
          : type === 'planned'
            ? 'neutral'
            : 'warning'
  return <StatusPill tone={tone} label={type} className="px-1.5 py-0 font-mono text-[10px] uppercase" />
}

export { Cpu }
