import { PrivacyBadge } from '@aurora/ui-mock-reference'

export function Default() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground">
      <PrivacyBadge privacy="personal" />
    </div>
  )
}

export function AllClasses() {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-background p-6 text-foreground">
      <PrivacyBadge privacy="public" />
      <PrivacyBadge privacy="personal" />
      <PrivacyBadge privacy="sensitive" />
      <PrivacyBadge privacy="secret" />
      <PrivacyBadge privacy="raw-audio" />
      <PrivacyBadge privacy="credential" />
      <PrivacyBadge privacy="admin-critical" />
    </div>
  )
}
