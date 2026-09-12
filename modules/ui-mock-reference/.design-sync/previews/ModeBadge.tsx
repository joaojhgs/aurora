import { ModeBadge } from '@aurora/ui-mock-reference'

export function Default() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground">
      <ModeBadge mode="Mesh" />
    </div>
  )
}

export function AllModes() {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-background p-6 text-foreground">
      <ModeBadge mode="Server" />
      <ModeBadge mode="Desktop Local" />
      <ModeBadge mode="Desktop Thin" />
      <ModeBadge mode="Mesh" />
      <ModeBadge mode="Android" />
      <ModeBadge mode="iOS" />
      <ModeBadge mode="Offline" />
      <ModeBadge mode="Hybrid" />
    </div>
  )
}
