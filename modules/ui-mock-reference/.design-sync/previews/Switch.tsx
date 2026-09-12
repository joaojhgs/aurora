import { Switch, Label } from '@aurora/ui-mock-reference'

export function Default() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground">
      <Switch />
    </div>
  )
}

export function CheckedUnchecked() {
  return (
    <div className="flex items-center gap-4 rounded-lg bg-background p-6 text-foreground">
      <Switch defaultChecked />
      <Switch />
    </div>
  )
}

export function Sizes() {
  return (
    <div className="flex items-center gap-4 rounded-lg bg-background p-6 text-foreground">
      <Switch size="sm" defaultChecked />
      <Switch size="default" defaultChecked />
    </div>
  )
}

export function Disabled() {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-background p-6 text-foreground">
      <Switch id="mic-access" disabled />
      <Label htmlFor="mic-access">Microphone access (requires OS grant)</Label>
    </div>
  )
}
