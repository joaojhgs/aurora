import type { ReactNode } from 'react'

export function PanelTitle({
  icon,
  title,
  description,
  id
}: {
  icon: ReactNode
  title: string
  description: string
  id: string
}) {
  return (
    <header className="mb-4 flex items-start gap-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground" aria-hidden>{icon}</span>
      <div className="min-w-0 flex flex-col gap-1">
        <h2 id={id} className="text-sm font-semibold leading-snug">{title}</h2>
        <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
      </div>
    </header>
  )
}
