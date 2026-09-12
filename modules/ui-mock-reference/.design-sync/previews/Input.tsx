import { Input, Label } from '@aurora/ui-mock-reference'

export function Default() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground">
      <Input placeholder="mesh-node-7a3f" className="w-64" />
    </div>
  )
}

export function WithLabel() {
  return (
    <div className="flex w-64 flex-col gap-1.5 rounded-lg bg-background p-6 text-foreground">
      <Label htmlFor="peer-alias">Peer alias</Label>
      <Input id="peer-alias" placeholder="e.g. desk-node" />
    </div>
  )
}

export function Invalid() {
  return (
    <div className="flex w-64 flex-col gap-1.5 rounded-lg bg-background p-6 text-foreground">
      <Label htmlFor="pairing-code">Pairing code</Label>
      <Input id="pairing-code" defaultValue="9F2-XXX" aria-invalid="true" />
    </div>
  )
}

export function Disabled() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground">
      <Input
        disabled
        defaultValue="gateway.aurora.local:8443"
        className="w-64"
      />
    </div>
  )
}
