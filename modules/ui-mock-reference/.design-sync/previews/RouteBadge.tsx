import { RouteBadge } from '@aurora/ui-mock-reference'

export function Default() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground">
      <RouteBadge route="Mesh Peer" />
    </div>
  )
}

export function AllRoutes() {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-background p-6 text-foreground">
      <RouteBadge route="Local" />
      <RouteBadge route="Remote" />
      <RouteBadge route="Mesh Peer" />
      <RouteBadge route="Native Mobile" />
      <RouteBadge route="Fallback" />
      <RouteBadge route="Unknown" />
    </div>
  )
}
