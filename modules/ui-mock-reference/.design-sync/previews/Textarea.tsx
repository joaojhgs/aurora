import { Textarea, Label } from '@aurora/ui-mock-reference'

export function Default() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground">
      <Textarea placeholder="Describe the incident for the audit note..." className="w-80" />
    </div>
  )
}

export function WithLabel() {
  return (
    <div className="flex w-80 flex-col gap-1.5 rounded-lg bg-background p-6 text-foreground">
      <Label htmlFor="revoke-reason">Revocation reason</Label>
      <Textarea
        id="revoke-reason"
        defaultValue="Device reported lost during travel; revoking pairing and rotating mesh keys."
      />
    </div>
  )
}

export function Invalid() {
  return (
    <div className="flex w-80 flex-col gap-1.5 rounded-lg bg-background p-6 text-foreground">
      <Label htmlFor="config-diff-note">Config diff note</Label>
      <Textarea id="config-diff-note" aria-invalid="true" placeholder="Required before restart-risk confirmation" />
    </div>
  )
}

export function Disabled() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground">
      <Textarea
        disabled
        defaultValue="Redacted export payload preview is read-only."
        className="w-80"
      />
    </div>
  )
}
