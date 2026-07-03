import type { AvailabilityState, PrivacyClass } from '@aurora/client'

export function StatusBadge({ state }: { state: AvailabilityState }) {
  return <span className={`aui-badge aui-badge-${state}`}>{state}</span>
}

export function PrivacyBadge({ privacy }: { privacy: PrivacyClass }) {
  return <span className={`aui-badge aui-privacy-${privacy}`}>{privacy}</span>
}

export function EvidenceBadge({ label }: { label: string }) {
  return <span className="aui-badge aui-badge-status">{presentableSignal(label)}</span>
}

export function presentableSignal(label: string): string {
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
