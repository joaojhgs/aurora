import {
  Avatar,
  AvatarImage,
  AvatarFallback,
  AvatarBadge,
} from '@aurora/ui-mock-reference'

export function Default() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground">
      <Avatar>
        <AvatarFallback>JG</AvatarFallback>
      </Avatar>
    </div>
  )
}

export function Sizes() {
  return (
    <div className="flex items-center gap-4 rounded-lg bg-background p-6 text-foreground">
      <Avatar size="sm">
        <AvatarFallback>JG</AvatarFallback>
      </Avatar>
      <Avatar size="default">
        <AvatarFallback>JG</AvatarFallback>
      </Avatar>
      <Avatar size="lg">
        <AvatarFallback>JG</AvatarFallback>
      </Avatar>
    </div>
  )
}

export function WithPresenceBadge() {
  return (
    <div className="flex items-center gap-4 rounded-lg bg-background p-6 text-foreground">
      <Avatar size="lg">
        <AvatarFallback>MP</AvatarFallback>
        <AvatarBadge className="bg-success" />
      </Avatar>
      <Avatar size="lg">
        <AvatarFallback>DV</AvatarFallback>
        <AvatarBadge className="bg-muted-foreground" />
      </Avatar>
    </div>
  )
}

export function WithImage() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground">
      <Avatar>
        <AvatarImage src="/aurora-admin-avatar.png" alt="Admin operator" />
        <AvatarFallback>AO</AvatarFallback>
      </Avatar>
    </div>
  )
}
