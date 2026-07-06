import { Badge } from '@aurora/ui-mock-reference'

export function Default() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground">
      <Badge>Mesh peer</Badge>
    </div>
  )
}

export function Variants() {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-background p-6 text-foreground">
      <Badge variant="default">Local-only</Badge>
      <Badge variant="secondary">Read-only</Badge>
      <Badge variant="destructive">Missing contract</Badge>
      <Badge variant="outline">Planned</Badge>
      <Badge variant="ghost">Internal-only</Badge>
      <Badge variant="link">View audit log</Badge>
    </div>
  )
}

export function Invalid() {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-background p-6 text-foreground">
      <Badge variant="outline" aria-invalid="true">
        Route unresolved
      </Badge>
    </div>
  )
}
