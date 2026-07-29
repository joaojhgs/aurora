/**
 * @vitest-environment jsdom
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DiagnosticsExportControl } from './diagnostics-export-control'

const exportSupportBundle = vi.fn()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../aurora-client', () => ({
  createAuroraBrowserClient: () => ({
    diagnostics: {
      exportSupportBundle
    }
  })
}))

describe('DiagnosticsExportControl', () => {
  afterEach(() => {
    exportSupportBundle.mockReset()
    document.body.innerHTML = ''
  })

  it('maps hostile export errors before rendering visible or accessible text', async () => {
    const hostile = 'Gateway.GetSupportBundle failed at /home/alice/.aurora room-password WebRTC sidecar evidence SDK fallback raw token'
    exportSupportBundle.mockRejectedValueOnce(new Error(hostile))
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(<DiagnosticsExportControl correlationId="corr-test" disabled={false} disabledReason="ready" />)
    })

    await confirmAndExport(container)

    const rendered = visibleOutput(container)
    const attributes = userFacingAttributes(container)
    expect(rendered).toContain('Aurora could not complete that action. Try again.')
    expect(rendered).not.toContain(hostile)
    expect(`${rendered} ${attributes}`).not.toMatch(/Gateway\.|\/home\/|room-password|WebRTC|sidecar|evidence|SDK|fallback|raw|token/i)

    root.unmount()
  })

  it('summarizes hostile bundle fields instead of rendering them', async () => {
    exportSupportBundle.mockResolvedValueOnce({
      data: {
        generated_at: '2026-06-19T00:00:00Z',
        correlation_ids: ['Gateway.GetSupportBundle:/home/alice/room-password'],
        audit_receipt: 'AdminAction receipt Gateway.GetSupportBundle',
        audit_error: null,
        secrets_redacted: true,
        native_capabilities: [
          { name: 'SDK provider /home/alice', status: 'UN.AVAILABLE' },
          { name: 'available-looking raw token', status: 'OK' }
        ],
        sidecar_logs: [
          { name: 'sidecar.log', status: 'un-available' },
          { name: 'raw WebRTC DataChannel failure', status: 'connected and available' }
        ],
        recent_events: [{ event: 'diagnostics.support_bundle.exported' }],
        recent_audit_events: [{ method: 'Gateway.GetSupportBundle' }]
      }
    })
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(<DiagnosticsExportControl correlationId="corr-test" disabled={false} disabledReason="ready" />)
    })

    await confirmAndExport(container)

    const rendered = visibleOutput(container)
    const attributes = userFacingAttributes(container)
    expect(rendered).toContain('Support Record Recorded')
    expect(rendered).toContain('1 related item')
    expect(rendered).toContain('Device Features 2 items checked; available: Yes')
    expect(rendered).toContain('Service Notes 2 items checked; available: No')
    expect(`${rendered} ${attributes}`).not.toMatch(/Gateway\.|\/home\/|room-password|WebRTC|DataChannel|sidecar|SDK provider|raw|token/i)

    root.unmount()
  })
})

async function confirmAndExport(container: HTMLElement): Promise<void> {
  const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement | null
  const button = container.querySelector('button') as HTMLButtonElement | null
  expect(checkbox).toBeTruthy()
  expect(button).toBeTruthy()

  await act(async () => {
    checkbox!.click()
  })
  await act(async () => {
    button!.click()
  })
}

function visibleOutput(container: HTMLElement): string {
  return container.innerHTML
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function userFacingAttributes(container: HTMLElement): string {
  return Array.from(container.querySelectorAll('[aria-label], [aria-description], [title], [placeholder], [alt]'))
    .flatMap((element) => ['aria-label', 'aria-description', 'title', 'placeholder', 'alt'].map((name) => element.getAttribute(name) ?? ''))
    .join(' ')
}
