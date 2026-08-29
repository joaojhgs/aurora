import { Separator } from '@aurora/ui-mock-reference'

export function Default() {
  return (
    <div className="w-72 rounded-lg bg-background p-6 text-foreground">
      <div className="text-sm">Mesh peers</div>
      <Separator className="my-3" />
      <div className="text-sm text-muted-foreground">Trust queue</div>
    </div>
  )
}

export function Vertical() {
  return (
    <div className="flex h-8 items-center gap-3 rounded-lg bg-background p-6 text-foreground">
      <span className="text-sm">Local</span>
      <Separator orientation="vertical" />
      <span className="text-sm">Remote</span>
      <Separator orientation="vertical" />
      <span className="text-sm">Mesh Peer</span>
    </div>
  )
}
