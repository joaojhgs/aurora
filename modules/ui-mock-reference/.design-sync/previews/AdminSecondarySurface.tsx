import { AdminSecondarySurface } from '@aurora/ui-mock-reference'

export function Contracts() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground min-w-[900px]">
      <AdminSecondarySurface surface="contracts" />
    </div>
  )
}

export function Plugins() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground min-w-[900px]">
      <AdminSecondarySurface surface="plugins" />
    </div>
  )
}

export function Pairing() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground min-w-[900px]">
      <AdminSecondarySurface surface="pairing" />
    </div>
  )
}

export function Backups() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground min-w-[900px]">
      <AdminSecondarySurface surface="backups" />
    </div>
  )
}
