import { ActivityRail } from '@aurora/ui-mock-reference'

export function Default() {
  return (
    <div className="flex h-[420px] w-80 overflow-hidden rounded-lg border bg-background text-foreground">
      <ActivityRail className="w-full" />
    </div>
  )
}

export function Narrow() {
  return (
    <div className="flex h-[360px] w-64 overflow-hidden rounded-lg border bg-background text-foreground">
      <ActivityRail className="w-full" />
    </div>
  )
}
