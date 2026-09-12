import { Label, Switch } from '@aurora/ui-mock-reference'

export function Default() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground">
      <Label htmlFor="voice-wake">Voice wake word</Label>
    </div>
  )
}

export function WithControl() {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-background p-6 text-foreground">
      <Switch id="mesh-routing" defaultChecked />
      <Label htmlFor="mesh-routing">Allow mesh peer routing</Label>
    </div>
  )
}

export function DisabledGroup() {
  return (
    <div
      data-disabled="true"
      className="group flex items-center gap-2 rounded-lg bg-background p-6 text-foreground"
    >
      <Switch id="native-permission" disabled />
      <Label htmlFor="native-permission">
        Native microphone permission (unavailable)
      </Label>
    </div>
  )
}
