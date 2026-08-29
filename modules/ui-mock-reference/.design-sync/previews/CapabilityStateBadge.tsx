import { CapabilityStateBadge } from '@aurora/ui-mock-reference'

export function Default() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground">
      <CapabilityStateBadge state="available" />
    </div>
  )
}

export function AllStates() {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-background p-6 text-foreground">
      <CapabilityStateBadge state="available" />
      <CapabilityStateBadge state="degraded" />
      <CapabilityStateBadge state="read_only" />
      <CapabilityStateBadge state="remote_only" />
      <CapabilityStateBadge state="local_only" />
      <CapabilityStateBadge state="needs_auth" />
      <CapabilityStateBadge state="needs_pairing" />
      <CapabilityStateBadge state="needs_permission" />
      <CapabilityStateBadge state="needs_native_permission" />
      <CapabilityStateBadge state="missing_service" />
      <CapabilityStateBadge state="unsupported_platform" />
      <CapabilityStateBadge state="unknown" />
      <CapabilityStateBadge state="error" />
    </div>
  )
}
