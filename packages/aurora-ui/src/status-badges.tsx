import type { AvailabilityState, PrivacyClass } from '@aurora/client'

export function StatusBadge({ state }: { state: AvailabilityState }) {
  return <span className={`aui-badge aui-badge-${state}`}>{statusLabel(state)}</span>
}

export function PrivacyBadge({ privacy }: { privacy: PrivacyClass }) {
  return <span className={`aui-badge aui-privacy-${privacy}`}>{titleCaseToken(privacy)}</span>
}

export function EvidenceBadge({ label }: { label: string }) {
  return <span className="aui-badge aui-badge-status">{presentableSignal(label)}</span>
}

export function presentableSignal(label: string): string {
  const normalized = label.trim()
  if (/^local\s*\//i.test(normalized)) return 'Local'
  if (/^mesh\s*\//i.test(normalized)) return 'Mesh'
  if (/^remote\s*\//i.test(normalized)) return 'Remote'
  if (/^cloud\s*\//i.test(normalized)) return 'Cloud'
  if (/^native[:/]/i.test(normalized)) return 'Native'
  return label
    .replaceAll('Aurora', 'Aurora')
    .replaceAll('Demo transport', 'Demo transport')
    .replaceAll('service state', 'service state')
    .replaceAll('Service state', 'Service state')
    .replaceAll('No service state', 'Unavailable')
    .replaceAll('route state', 'route state')
    .replaceAll('Route state', 'Route state')
    .replaceAll('evidence', 'state')
    .replaceAll('Evidence', 'State')
    .replaceAll('demo only', 'demo only')
    .replaceAll('demo', 'demo')
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
      return 'Unsupported'
    case 'offline':
      return 'Offline'
    default:
      return titleCaseToken(state)
  }
}

function titleCaseToken(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}
