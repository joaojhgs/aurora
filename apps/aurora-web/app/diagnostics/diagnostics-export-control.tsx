'use client'

import { useMemo, useState } from 'react'
import type { GatewaySupportBundleResponse } from '@aurora/client'
import { createAuroraBrowserClient } from '../aurora-client'
import { countText, productActionErrorText, productBundleItemAvailable, yesNo } from '../product-copy'

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
  const [exportMessage, setExportMessage] = useState<string | null>(null)

  async function exportBundle() {
    setPending(true)
    setExportMessage(null)
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
      setExportMessage(productActionErrorText(exportError))
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
          <p>Review and confirm before Aurora prepares a support bundle.</p>
        </div>
        <span className="adx-badge adx-badge-critical">confirmation required</span>
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
        <span>I confirmed this support request.</span>
      </label>
      <p id="diagnostics-export-help" className="adx-muted">
        Aurora removes credentials, device secrets, addresses, file locations, tool inputs,
        memory content, and audio details before sharing.
      </p>
      {disabled ? <p className="adx-state adx-state-warn">{disabledReason}</p> : null}
      {exportMessage ? <p className="adx-state adx-state-error" role="alert">{exportMessage}</p> : null}
      <button className="adx-button" type="button" onClick={exportBundle} disabled={blocked}>
        {pending ? 'Exporting...' : 'Export Redacted Bundle'}
      </button>
      {bundle ? (
        <div className="adx-receipt" aria-live="polite">
          <dl className="aw-facts">
            <div>
              <dt>Support Record</dt>
              <dd>{bundle.audit_receipt || bundle.audit_error ? 'Recorded' : 'Record unavailable'}</dd>
            </div>
            <div>
              <dt>Generated</dt>
              <dd>{bundle.generated_at}</dd>
            </div>
            <div>
              <dt>Correlations</dt>
              <dd>{bundle.correlation_ids.length ? countText(bundle.correlation_ids.length, 'related item') : 'None returned'}</dd>
            </div>
            <div>
              <dt>Redaction</dt>
              <dd>{bundle.secrets_redacted ? 'Sensitive details removed' : 'Sensitive-detail status unavailable'}</dd>
            </div>
            <div>
              <dt>Device Features</dt>
              <dd>{bundle.native_capabilities.length ? summarizeItems(bundle.native_capabilities) : 'None returned'}</dd>
            </div>
            <div>
              <dt>Service Notes</dt>
              <dd>{bundle.sidecar_logs.length ? summarizeItems(bundle.sidecar_logs) : 'None returned'}</dd>
            </div>
            <div>
              <dt>Recent Activity</dt>
              <dd>{`${countText(bundle.recent_events.length, 'event')}, ${countText(bundle.recent_audit_events.length, 'support record')}`}</dd>
            </div>
          </dl>
        </div>
      ) : null}
    </section>
  )
}

function summarizeItems(items: Array<{ name: string; status: string }>): string {
  const available = items.filter((item) => productBundleItemAvailable(item.status)).length
  return `${countText(items.length, 'item')} checked; available: ${yesNo(available > 0)}`
}
