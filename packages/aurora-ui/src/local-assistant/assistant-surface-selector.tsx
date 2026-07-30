import * as React from 'react'

import { Badge } from '#components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '#components/ui/card'
import { ToggleGroup, ToggleGroupItem } from '#components/ui/toggle-group'
import { cn } from '#lib/utils'
import {
  isLightweightLocalAssistantAvailable,
  LightweightLocalAssistant,
  type LightweightAssistantProps,
} from './lightweight-assistant'

type AssistantSurfaceChoice = 'local' | 'connected'

export interface AssistantSurfaceSelectorProps {
  readonly connectedAssistant?: React.ReactNode
  readonly localAssistant?: LightweightAssistantProps | null
  readonly localAssistantEnabled?: boolean
  readonly className?: string
}

const CONNECTED_LABEL = 'Connected Aurora device'
const LOCAL_LABEL = 'Assistant on this device'

const CHOICE_COPY: Record<AssistantSurfaceChoice, { label: string; detail: string; status: string }> = {
  connected: {
    label: CONNECTED_LABEL,
    detail: 'Uses the paired Aurora device for the broader assistant experience you already use.',
    status: 'Current choice',
  },
  local: {
    label: LOCAL_LABEL,
    detail: 'Keeps new chats and approved actions on this device when those features are ready here.',
    status: 'Available here',
  },
}

export function AssistantSurfaceSelector({
  connectedAssistant,
  localAssistant,
  localAssistantEnabled = true,
  className,
}: AssistantSurfaceSelectorProps) {
  const connectedAvailable = hasConnectedAssistant(connectedAssistant)
  const localAvailable =
    localAssistantEnabled && localAssistant !== undefined && localAssistant !== null && isLightweightLocalAssistantAvailable(localAssistant)
  const initialChoice = connectedAvailable ? 'connected' : 'local'
  const [choice, setChoice] = React.useState<AssistantSurfaceChoice>(initialChoice)

  React.useEffect(() => {
    if (choice === 'connected' && !connectedAvailable && localAvailable) setChoice('local')
    if (choice === 'local' && !localAvailable && connectedAvailable) setChoice('connected')
  }, [choice, connectedAvailable, localAvailable])

  if (connectedAvailable && !localAvailable) {
    return <>{connectedAssistant}</>
  }

  if (localAvailable && !connectedAvailable) {
    const combinedClassName = cn(localAssistant.className, className)
    return <LightweightLocalAssistant {...localAssistant} {...(combinedClassName ? { className: combinedClassName } : {})} />
  }

  if (!connectedAvailable && localAssistant !== undefined && localAssistant !== null) {
    const combinedClassName = cn(localAssistant.className, className)
    return <LightweightLocalAssistant {...localAssistant} {...(combinedClassName ? { className: combinedClassName } : {})} />
  }

  if (!connectedAvailable) {
    return <LightweightLocalAssistant {...(className ? { className } : {})} />
  }

  const activeChoice: AssistantSurfaceChoice = choice === 'local' && localAvailable ? 'local' : 'connected'

  return (
    <section className={cn('flex min-h-[30rem] flex-col gap-4', className)} aria-label="Assistant options">
      <div className="flex flex-col gap-3 rounded-lg border border-border/70 bg-card/70 p-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-col gap-1">
            <h2 className="text-sm font-medium">Choose how Aurora answers</h2>
            <p className="text-sm text-muted-foreground">
              Pick this device for private, ready-here work, or stay with the paired Aurora device for the assistant you already use.
            </p>
          </div>
          <ToggleGroup
            value={[activeChoice]}
            onValueChange={(values: string[]) => {
              const next = values[0] as AssistantSurfaceChoice | undefined
              if (next === 'local' || next === 'connected') setChoice(next)
            }}
            variant="outline"
            spacing={1}
            aria-label="Assistant choice"
            className="w-full bg-background/70 p-1 shadow-inner sm:w-fit"
          >
            <ToggleGroupItem value="local" aria-pressed={activeChoice === 'local'} className="min-h-10 flex-1 text-xs sm:flex-none">
              {LOCAL_LABEL}
            </ToggleGroupItem>
            <ToggleGroupItem value="connected" aria-pressed={activeChoice === 'connected'} className="min-h-10 flex-1 text-xs sm:flex-none">
              {CONNECTED_LABEL}
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <AssistantChoiceCard choice="local" selected={activeChoice === 'local'} />
          <AssistantChoiceCard choice="connected" selected={activeChoice === 'connected'} />
        </div>
      </div>

      {activeChoice === 'local' ? <LightweightLocalAssistant {...localAssistant} /> : connectedAssistant}
    </section>
  )
}

function AssistantChoiceCard({ choice, selected }: { readonly choice: AssistantSurfaceChoice; readonly selected: boolean }) {
  const copy = CHOICE_COPY[choice]
  return (
    <Card size="sm" data-state={selected ? 'selected' : undefined} className={cn('transition-colors', selected && 'ring-primary/35')}>
      <CardHeader>
        <CardTitle>{copy.label}</CardTitle>
        <CardDescription>{copy.detail}</CardDescription>
      </CardHeader>
      <CardContent>
        <Badge variant={selected ? 'default' : 'secondary'}>{selected ? copy.status : 'Ready'}</Badge>
      </CardContent>
    </Card>
  )
}

function hasConnectedAssistant(content: React.ReactNode): boolean {
  return content !== null && content !== undefined && content !== false
}
