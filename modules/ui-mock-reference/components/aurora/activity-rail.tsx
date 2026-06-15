import {
  Bot,
  FileCog,
  Network,
  ScrollText,
  ServerCog,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { activityEvents } from '@/lib/aurora/data'
import type { ActivityEvent } from '@/lib/aurora/types'

const meta: Record<ActivityEvent['type'], { icon: LucideIcon; tone: string }> = {
  assistant: { icon: Bot, tone: 'text-primary' },
  service: { icon: ServerCog, tone: 'text-info' },
  mesh: { icon: Network, tone: 'text-primary' },
  config: { icon: FileCog, tone: 'text-info' },
  audit: { icon: ScrollText, tone: 'text-muted-foreground' },
  warning: { icon: TriangleAlert, tone: 'text-warning' },
}

export function ActivityRail({ className }: { className?: string }) {
  return (
    <aside className={cn('flex flex-col border-l bg-sidebar/40', className)}>
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Activity</h2>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="size-1.5 animate-pulse rounded-full bg-success" />
          Live
        </span>
      </div>
      <ScrollArea className="flex-1">
        <ol className="divide-y">
          {activityEvents.map((event) => {
            const m = meta[event.type]
            const Icon = m.icon
            return (
              <li key={event.id} className="flex gap-3 px-4 py-3">
                <Icon className={cn('mt-0.5 size-4 shrink-0', m.tone)} aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-medium">{event.title}</p>
                    <span className="shrink-0 text-xs text-muted-foreground">{event.time}</span>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">{event.detail}</p>
                </div>
              </li>
            )
          })}
        </ol>
      </ScrollArea>
    </aside>
  )
}
