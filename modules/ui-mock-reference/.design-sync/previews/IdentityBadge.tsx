import { IdentityBadge } from '@aurora/ui-mock-reference'

export function Default() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground">
      <IdentityBadge identity="Admin" />
    </div>
  )
}

export function AllStates() {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-background p-6 text-foreground">
      <IdentityBadge identity="Anonymous" />
      <IdentityBadge identity="Pairing" />
      <IdentityBadge identity="User" />
      <IdentityBadge identity="Admin" />
      <IdentityBadge identity="Mesh peer" />
      <IdentityBadge identity="Expired" />
    </div>
  )
}
