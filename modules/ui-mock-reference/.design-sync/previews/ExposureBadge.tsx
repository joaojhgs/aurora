import { ExposureBadge } from '@aurora/ui-mock-reference'

export function Default() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground">
      <ExposureBadge exposure="external" />
    </div>
  )
}

export function AllExposures() {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-background p-6 text-foreground">
      <ExposureBadge exposure="internal" />
      <ExposureBadge exposure="external" />
      <ExposureBadge exposure="both" />
      <ExposureBadge exposure="gateway_builtin" />
      <ExposureBadge exposure="planned" />
    </div>
  )
}
