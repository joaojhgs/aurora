'use client'

import dynamic from 'next/dynamic'

const DiagnosticsExportControl = dynamic(
  () => import('./diagnostics-export-control').then((module) => module.DiagnosticsExportControl),
  {
    ssr: false,
    loading: () => (
      <section className="aw-panel adx-export" aria-labelledby="diagnostics-export-title">
        <div className="adx-section-heading">
          <div>
            <h2 id="diagnostics-export-title">Support Bundle Export</h2>
            <p>AdminAction draft, confirmation, and audit receipt controls are loading for redacted diagnostics export.</p>
          </div>
          <span className="adx-badge adx-badge-critical">admin-critical</span>
        </div>
      </section>
    )
  }
)

export interface DiagnosticsExportIslandProps {
  correlationId: string | null
  disabled: boolean
  disabledReason: string
}

export function DiagnosticsExportIsland(props: DiagnosticsExportIslandProps) {
  return <DiagnosticsExportControl {...props} />
}
