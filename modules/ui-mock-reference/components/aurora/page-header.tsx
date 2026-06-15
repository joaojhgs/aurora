import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export function PageHeader({
  title,
  description,
  actions,
  className,
  icon: Icon,
}: {
  title: string
  description?: string
  actions?: React.ReactNode
  className?: string
  icon?: LucideIcon
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-3 border-b px-4 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6',
        className,
      )}
    >
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          {Icon && <Icon className="size-5 text-primary" aria-hidden />}
          <h1 className="text-balance text-xl font-semibold tracking-tight">{title}</h1>
        </div>
        {description && (
          <p className="text-pretty text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
