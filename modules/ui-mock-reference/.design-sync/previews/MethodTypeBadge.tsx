import { MethodTypeBadge } from '@aurora/ui-mock-reference'

export function Default() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground">
      <MethodTypeBadge type="use" />
    </div>
  )
}

export function AllTypes() {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-background p-6 text-foreground">
      <MethodTypeBadge type="use" />
      <MethodTypeBadge type="manage" />
      <MethodTypeBadge type="event" />
      <MethodTypeBadge type="gateway" />
      <MethodTypeBadge type="planned" />
    </div>
  )
}
