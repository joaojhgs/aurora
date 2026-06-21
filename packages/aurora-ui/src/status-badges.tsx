import type { AvailabilityState, PrivacyClass } from '@aurora/client'

export function StatusBadge({ state }: { state: AvailabilityState }) {
  return <span className={`aui-badge aui-badge-${state}`}>{state}</span>
}

export function PrivacyBadge({ privacy }: { privacy: PrivacyClass }) {
  return <span className={`aui-badge aui-privacy-${privacy}`}>{privacy}</span>
}

export function EvidenceBadge({ label }: { label: string }) {
  return <span className="aui-badge aui-badge-evidence">{label}</span>
}
