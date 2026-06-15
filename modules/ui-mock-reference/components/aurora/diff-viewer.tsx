import { ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface DiffRow {
  key: string
  before: string
  after: string
}

export function DiffViewer({ rows, className }: { rows: DiffRow[]; className?: string }) {
  return (
    <div className={cn('overflow-hidden rounded-lg border', className)}>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
        <span>Current</span>
        <span className="sr-only">changes to</span>
        <span />
        <span>Proposed</span>
      </div>
      <div className="divide-y">
        {rows.map((row) => {
          const changed = row.before !== row.after
          return (
            <div
              key={row.key}
              className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 px-3 py-2 text-sm"
            >
              <div className="min-w-0">
                <div className="truncate font-mono text-xs text-muted-foreground">{row.key}</div>
                <div
                  className={cn(
                    'truncate font-mono',
                    changed && 'rounded bg-destructive/10 px-1 text-destructive line-through',
                  )}
                >
                  {row.before}
                </div>
              </div>
              <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0 text-right">
                <div className="h-4" />
                <div
                  className={cn(
                    'truncate font-mono',
                    changed && 'rounded bg-success/10 px-1 text-success',
                  )}
                >
                  {row.after}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
