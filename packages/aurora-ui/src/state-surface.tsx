import type { AvailabilityState } from '@aurora/client'
import { StatusBadge } from './status-badges'

export interface StateSurfaceProps {
  title: string
  state: AvailabilityState | 'loading' | 'error'
  description: string
  evidence?: string | null
  actionLabel?: string | null
}

export function StateSurface({ title, state, description, evidence, actionLabel }: StateSurfaceProps) {
  return (
    <section className="aui-state-surface" aria-live={state === 'loading' ? 'polite' : undefined}>
      <div>
        <p className="aui-kicker">Backend state</p>
        <h1>{title}</h1>
      </div>
      {state === 'loading' || state === 'error'
        ? <span className={`aui-badge aui-badge-${state}`}>{state}</span>
        : <StatusBadge state={state} />}
      <p>{description}</p>
      {evidence ? <code>{evidence}</code> : null}
      {actionLabel ? <button className="aui-button" type="button" disabled>{actionLabel}</button> : null}
    </section>
  )
}
