// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  capabilityCatalogFixture,
  cloneFixture,
  meshStatusFixture,
  supportBundleFixture,
  webrtcDiagnosticsFixture,
} from '@aurora/client'
import {
  MeshDiagnosticsView,
  meshDiagnosticsSnapshotFromResults,
  type MeshDiagnosticsSnapshot,
  type RouteAvailability,
  type SupportBundleExportState,
} from '../src/index'
import { findForbiddenProductionCopyTerms } from '../src/product-copy-forbidden-terms'

describe('mesh diagnostics product copy', () => {
  it('maps hostile backend strings before headings, cards, tables, alerts, and attributes render', () => {
    const snapshot = hostileSnapshot()
    const markup = renderToStaticMarkup(
      <MeshDiagnosticsView
        snapshot={snapshot}
        route={hostileRoute()}
        reauthConfirmed
        supportBundleExportState={{
          status: 'error',
          message: 'Gateway.GetSupportBundle AdminAction WebRTC transport fallback provider route failed',
        }}
      />,
    )
    const visible = visibleText(markup)
    const attributes = renderedAttributeText(markup)
    const rendered = `${visible} ${attributes}`

    expect(visible).toContain('Troubleshooting')
    expect(visible).toContain('Connected devices')
    expect(visible).toContain('Feature readiness')
    expect(visible).toContain('Some checks need attention')
    expect(attributes).toContain('Connected device checks')

    for (const leaked of HOSTILE_BACKEND_STRINGS) {
      expect(rendered).not.toContain(leaked)
    }
    expect(findForbiddenProductionCopyTerms(rendered).map((term) => term.id)).toEqual([])
    expect(rendered).not.toMatch(HOSTILE_RENDER_TERMS)
  })

  it('keeps support-export internals in structured data while rendering only safe summaries', () => {
    const snapshot = hostileSnapshot()
    const markup = renderToStaticMarkup(<MeshDiagnosticsView snapshot={snapshot} route={hostileRoute()} reauthConfirmed />)
    const rendered = `${visibleText(markup)} ${renderedAttributeText(markup)}`

    expect(snapshot.recentErrors[0]?.code).toBe('DataChannel_rpc_timeout')
    expect(snapshot.recentErrors[0]?.message).toContain('Gateway.GetWebRTCDiagnostics')
    expect(snapshot.supportBundleCorrelationId).toBe('support-ref-001')
    expect(rendered).toContain('support-ref-001')
    expect(rendered).not.toContain('DataChannel_rpc_timeout')
    expect(rendered).not.toContain('Gateway.GetWebRTCDiagnostics')
    expect(rendered).not.toContain('sidecar_manifest_provider')
    expect(rendered).not.toMatch(HOSTILE_RENDER_TERMS)
  })

  it('sanitizes unsafe support references, redaction rows, trust labels, and quality labels in text and attributes', () => {
    const snapshot = hostileSnapshot()
    snapshot.supportBundleCorrelationId = 'Gateway.GetSupportBundle'
    snapshot.supportBundleAuditReceipt = 'mesh:peer-Gateway.AdminActionConfirm'
    snapshot.redactionRows = [{
      label: 'Gateway.AdminActionConfirm credential provider fallback',
      value: 57,
      detail: 'AdminAction WebRTC transport provider fallback redaction row',
    }]
    snapshot.transportRows[0]!.trustLabel = 'AdminAction provider route trusted'
    snapshot.transportRows[0]!.routeQuality = 'WebRTC transport provider fallback quality'
    snapshot.routeRows[0]!.routeQuality = 'Gateway.GetSupportBundle mesh:peer route quality'

    const markup = renderToStaticMarkup(<MeshDiagnosticsView snapshot={snapshot} route={hostileRoute()} reauthConfirmed />)
    const rendered = `${visibleText(markup)} ${renderedAttributeText(markup)}`

    expect(rendered).toContain('Reference available')
    expect(rendered).toContain('Privacy item')
    expect(rendered).toContain('Quality unavailable')
    expect(rendered).toContain('Access status unavailable')
    for (const leaked of [
      'Gateway.GetSupportBundle',
      'Gateway.AdminActionConfirm',
      'AdminAction',
      'mesh:peer',
      'provider fallback',
      'WebRTC transport',
    ]) {
      expect(rendered).not.toContain(leaked)
    }
    expect(rendered).not.toMatch(HOSTILE_RENDER_TERMS)
    expect(findForbiddenProductionCopyTerms(rendered).map((term) => term.id)).toEqual([])
  })

  it('requires explicit approval before export while preserving the export action', async () => {
    const onExport = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    function Harness() {
      const [confirmed, setConfirmed] = useState(false)
      return (
        <MeshDiagnosticsView
          snapshot={hostileSnapshot()}
          route={hostileRoute()}
          onExportSupportBundle={onExport}
          reauthConfirmed={confirmed}
          onReauthConfirmedChange={setConfirmed}
          supportBundleExportState={{ status: 'idle', message: null }}
        />
      )
    }

    await act(async () => {
      root.render(<Harness />)
    })

    const button = buttonByText(container, 'Export support data')
    expect(button.disabled).toBe(true)
    expect(onExport).not.toHaveBeenCalled()

    await act(async () => {
      checkbox(container).click()
    })

    const armedButton = buttonByText(container, 'Export support data')
    expect(armedButton.disabled).toBe(false)
    await act(async () => {
      armedButton.click()
    })
    expect(onExport).toHaveBeenCalledTimes(1)

    root.unmount()
    container.remove()
  })
})

const HOSTILE_BACKEND_STRINGS = [
  'Gateway.GetWebRTCDiagnostics',
  'Gateway.GetSupportBundle',
  'AdminAction',
  'WebRTC',
  'ICE',
  'DataChannel',
  'transport',
  'provider',
  'fallback',
  'mesh:peer',
  'sidecar_manifest_provider',
  'Gateway.AdminActionConfirm',
] as const

const HOSTILE_RENDER_TERMS = /\b(?:AdminAction|DataChannel|fallback|Gateway\.[A-Za-z0-9_.]+|ICE|manifest|protocol|provider|route|sidecar|signaling|transport|WebRTC)\b/u

function hostileSnapshot(): MeshDiagnosticsSnapshot {
  const webrtc = cloneFixture(webrtcDiagnosticsFixture)
  webrtc.local_node_name = 'WebRTC Gateway provider'
  webrtc.signaling.strategy = 'WebRTC signaling protocol'
  webrtc.signaling.connected = false
  webrtc.signaling.public_broker_warning = true
  webrtc.peers[0]!.node_name = 'Kitchen speaker'
  webrtc.peers[0]!.identity_source = 'sidecar_manifest_provider'
  webrtc.peers[0]!.data_channel_state = 'closed'
  webrtc.recent_errors = [{
    timestamp: '2026-07-28T00:00:00Z',
    code: 'DataChannel_rpc_timeout',
    message: 'Gateway.GetWebRTCDiagnostics WebRTC ICE signaling DataChannel transport provider fallback sidecar manifest protocol route failed',
    peer_id: 'peer-provider-route-001',
  }]

  const mesh = cloneFixture(meshStatusFixture)
  mesh.routes[0]!.reason = 'Gateway.GetMeshStatus provider route used fallback after WebRTC transport failed'
  mesh.routes[0]!.fallback = 'provider fallback route'
  mesh.routes[0]!.providers[0]!.reason = 'sidecar_manifest_provider protocol ready'
  mesh.routes[0]!.providers[1]!.reason = 'WebRTC transport provider stale'
  mesh.compatibility_failures = [{
    peer_id: 'peer-provider-route-001',
    module: 'Gateway.AdminActionConfirm',
    direction: 'remote',
    reason: 'DataChannel protocol mismatch',
  }]

  const catalog = cloneFixture(capabilityCatalogFixture)
  catalog.actions[0]!.topic = 'Gateway.GetWebRTCDiagnostics'
  catalog.actions[0]!.action_id = 'Gateway.GetWebRTCDiagnostics:provider-route'

  const supportBundle = cloneFixture(supportBundleFixture)
  supportBundle.correlation_id = 'support-ref-001'
  supportBundle.audit_receipt = 'receipt-001'
  supportBundle.native_capabilities = [{
    name: 'native_manifest WebRTC provider',
    source: 'Gateway.GetSupportBundle sidecar',
    status: 'manifest provider ready',
    details: { manifest: 'sidecar_manifest_provider', protocol: 'WebRTC' },
    redacted: true,
  }]
  supportBundle.sidecar_logs = [{
    name: 'sidecar_manifest_provider',
    source: 'Gateway.GetSupportBundle sidecar',
    status: 'transport failed',
    details: { DataChannel: 'closed', route: 'fallback' },
    redacted: true,
  }]
  supportBundle.recent_events = [{
    id: 'event-001',
    timestamp: '2026-07-28T00:00:00Z',
    kind: 'Gateway.AdminActionConfirm',
    topic: 'Gateway.GetSupportBundle',
    bus_topic: 'Gateway.GetSupportBundle',
    status: 'failed',
    peer_id: 'peer-provider-route-001',
    target_peer_id: 'peer-provider-route-001',
    correlation_id: 'support-ref-001',
    payload_summary: { detail: 'WebRTC DataChannel provider fallback route failed' },
    secrets_redacted: true,
  }]

  return meshDiagnosticsSnapshotFromResults({
    route: hostileRoute(),
    webrtc: { data: webrtc, error: 'Gateway.GetWebRTCDiagnostics WebRTC transport unavailable' },
    mesh: { data: mesh, error: null },
    catalog: { data: catalog, error: null },
    supportBundle: { data: supportBundle, error: null },
  })
}

function hostileRoute(): RouteAvailability {
  return {
    item: {
      id: 'mesh-diagnostics',
      label: 'Troubleshooting',
      href: '/mesh/diagnostics',
      capabilityModule: 'Gateway',
      capabilityMethod: 'GetWebRTCDiagnostics',
      methodType: 'use',
      privacyClass: 'personal',
      fallbackState: 'degraded',
      adminGated: false,
      expectedTask: 'MESH-DIAGNOSTICS',
    },
    state: 'degraded',
    explanation: 'Gateway.GetWebRTCDiagnostics provider route fallback failed',
    providerLabel: 'Gateway provider route',
    blockers: ['WebRTC transport provider fallback'],
    repairActions: [],
    candidateProviders: [],
    evidenceSources: ['Gateway.GetWebRTCDiagnostics'],
    selectorRequired: true,
    approvalRequired: false,
    routeable: true,
    disabled: false,
    requiresAdminAction: false,
  }
}

function visibleText(markup: string): string {
  return decodeHtml(markup
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replace(/<[^>]+>/gu, ' '))
}

function renderedAttributeText(markup: string): string {
  return decodeHtml(Array.from(markup.matchAll(/\s(?:aria-label|title|placeholder|alt|data-(?!slot|variant|size|state)[a-z0-9-]+)="([^"]*)"/giu))
    .map((match) => match[1])
    .join(' '))
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/gu, ' ')
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#x27;|&apos;/gu, "'")
    .replace(/\s+/gu, ' ')
    .trim()
}

function checkbox(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="checkbox"]')
  if (!(input instanceof HTMLInputElement)) throw new Error('approval checkbox missing')
  return input
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes(text))
  if (!(button instanceof HTMLButtonElement)) throw new Error(`button not found: ${text}`)
  return button
}
