import { HealthBadge } from '@aurora/ui-mock-reference'

export function Default() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground">
      <HealthBadge health="Healthy" />
    </div>
  )
}

export function States() {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-background p-6 text-foreground">
      <HealthBadge health="Healthy" />
      <HealthBadge health="Degraded" />
      <HealthBadge health="Offline" />
      <HealthBadge health="Starting" />
      <HealthBadge health="Needs attention" />
    </div>
  )
}
