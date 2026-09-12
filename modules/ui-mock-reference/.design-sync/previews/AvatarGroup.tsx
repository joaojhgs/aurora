import {
  AvatarGroup,
  Avatar,
  AvatarFallback,
  AvatarGroupCount,
} from '@aurora/ui-mock-reference'

export function Default() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground">
      <AvatarGroup>
        <Avatar>
          <AvatarFallback>MP</AvatarFallback>
        </Avatar>
        <Avatar>
          <AvatarFallback>DV</AvatarFallback>
        </Avatar>
        <Avatar>
          <AvatarFallback>KR</AvatarFallback>
        </Avatar>
      </AvatarGroup>
    </div>
  )
}

export function WithOverflowCount() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground">
      <AvatarGroup>
        <Avatar>
          <AvatarFallback>MP</AvatarFallback>
        </Avatar>
        <Avatar>
          <AvatarFallback>DV</AvatarFallback>
        </Avatar>
        <Avatar>
          <AvatarFallback>KR</AvatarFallback>
        </Avatar>
        <AvatarGroupCount>+4</AvatarGroupCount>
      </AvatarGroup>
    </div>
  )
}

export function LargeSize() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground">
      <AvatarGroup>
        <Avatar size="lg">
          <AvatarFallback>MP</AvatarFallback>
        </Avatar>
        <Avatar size="lg">
          <AvatarFallback>DV</AvatarFallback>
        </Avatar>
        <AvatarGroupCount>+2</AvatarGroupCount>
      </AvatarGroup>
    </div>
  )
}
