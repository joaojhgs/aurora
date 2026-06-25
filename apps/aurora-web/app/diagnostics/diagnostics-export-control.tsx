'use client'

import { useMemo, useState } from 'react'
import type { GatewaySupportBundleResponse } from '@aurora/client'
import { createAuroraBrowserClient } from '../aurora-client'

interface DiagnosticsExportControlProps {
  correlationId: string | null
  disabled: boolean
  disabledReason: string
}

export function DiagnosticsExportControl({
  correlationId,
  disabled,
  disabledReason
}: DiagnosticsExportControlProps) {
  const client = useMemo(() => createAuroraBrowserClient(), [])
  const [reason, setReason] = useState('Share redacted diagnostics with support')
  const [reauthConfirmed, setReauthConfirmed] = useState(false)
  const [pending, setPending] = useState(false)
  const [bundle, setBundle] = useState<GatewaySupportBundleResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function exportBundle() {
    setPending(true)
    setError(null)
    try {
      const result = await client.diagnostics.exportSupportBundle({
        request: {
          correlation_id: correlationId,
          event_limit: 100,
          audit_limit: 50,
          include_capability_catalog: true
        },
        reason,
        reauthConfirmed
      })
      setBundle(result.data)
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : 'Diagnostics export failed')
    } finally {
      setPending(false)
    }
  }

  const blocked = disabled || !reason.trim() || !reauthConfirmed || pending

  return (
    <section className="aw-panel adx-export" aria-labelledby="diagnostics-export-title">
      <div className="adx-section-heading">
        <div>
          <h2 id="diagnostics-export-title">Support Bundle Export</h2>
          <p>AdminAction draft, confirmation, and audit receipt are required before bundle generation.</p>
        </div>
        <span className="adx-badge adx-badge-critical">admin-critical</span>
      </div>
      <label className="adx-field">
        <span>Reason</span>
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          disabled={pending || disabled}
          aria-describedby="diagnostics-export-help"
        />
      </label>
      <label className="adx-check">
        <input
          type="checkbox"
          checked={reauthConfirmed}
          onChange={(event) => setReauthConfirmed(event.target.checked)}
          disabled={pending || disabled}
        />
        <span>Re-authentication was confirmed for this admin action.</span>
      </label>
      <p id="diagnostics-export-help" className="adx-muted">
        Bundle redaction omits tokens, peer secrets, Redis URLs, host paths, model paths, tool args,
        RAG content, and audio/session metadata when the backend reports them.
      </p>
      {disabled ? <p className="adx-state adx-state-warn">{disabledReason}</p> : null}
      {error ? <p className="adx-state adx-state-error" role="alert">{error}</p> : null}
      <button className="adx-button" type="button" onClick={exportBundle} disabled={blocked}>
        {pending ? 'Exporting...' : 'Export Redacted Bundle'}
      </button>
      {bundle ? (
        <div className="adx-receipt" aria-live="polite">
          <dl className="aw-facts">
            <div>
              <dt>Audit receipt</dt>
              <dd>{bundle.audit_receipt ?? bundle.audit_error ?? 'receipt unavailable'}</dd>
            </div>
            <div>
              <dt>Generated</dt>
              <dd>{bundle.generated_at}</dd>
            </div>
            <div>
              <dt>Correlations</dt>
              <dd>{bundle.correlation_ids.length ? bundle.correlation_ids.join(', ') : 'none returned'}</dd>
            </div>
            <div>
              <dt>Redaction</dt>
              <dd>{bundle.secrets_redacted ? 'backend asserted secrets redacted' : 'redaction assertion missing'}</dd>
            </div>
            <div>
              <dt>Native capabilities</dt>
              <dd>{bundle.native_capabilities.length ? summarizeItems(bundle.native_capabilities) : 'none returned'}</dd>
            </div>
            <div>
              <dt>Sidecar/gateway logs</dt>
              <dd>{bundle.sidecar_logs.length ? summarizeItems(bundle.sidecar_logs) : 'none returned'}</dd>
            </div>
            <div>
              <dt>Recent events and audit</dt>
              <dd>{`${bundle.recent_events.length} events, ${bundle.recent_audit_events.length} audit records`}</dd>
            </div>
          </dl>
        </div>
      ) : null}
    </section>
  )
}

function summarizeItems(items: Array<{ name: string; status: string }>): string {
  return items.map((item) => `${item.name}: ${item.status}`).join(', ')
}
