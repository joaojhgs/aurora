// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  capabilityCatalogFixture,
  cloneFixture,
  meshStatusFixture,
  supportBundleFixture,
  webrtcDiagnosticsFixture,
  type AuroraClient,
  type GatewaySupportBundleResponse,
} from '@aurora/client'
import type { MeshPeerRosterSnapshot } from '@aurora/client/webrtc'
import {
  MeshDiagnosticsResource,
  MeshDiagnosticsView,
  buildMeshDiagnosticsSnapshot,
  meshDiagnosticsSnapshotFromResults,
  type MeshDiagnosticsSnapshot,
  type RouteAvailability,
  type SupportBundleExportState,
} from '../src/index'
import { findForbiddenProductionCopyTerms } from '../src/product-copy-forbidden-terms'
import { AuroraQueryProvider, createAuroraQueryClient } from '../src/query'
import type { BrowserWebRtcPeerController, BrowserWebRtcSnapshot } from '../src/web-thin-runtime'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('mesh diagnostics product copy', () => {
  it('threads the caller abort signal through diagnostics snapshot reads', async () => {
    const client = diagnosticsClient()
    const signal = new AbortController().signal

    await buildMeshDiagnosticsSnapshot(client, hostileRoute(), { signal })

    expect(client.registry.getWebRTCDiagnostics).toHaveBeenCalledWith({ signal })
    expect(client.mesh.getStatus).toHaveBeenCalledWith({ signal })
    expect(client.capabilities.listCatalog).toHaveBeenCalledWith(
      { include_unavailable: true, include_internal: true },
      { signal },
    )
    expect(client.diagnostics.getSupportBundle).toHaveBeenCalledWith(
      { event_limit: 6, audit_limit: 6, include_capability_catalog: true },
      { signal },
    )
  })

  it('propagates diagnostics aborts instead of returning a successful snapshot', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(buildMeshDiagnosticsSnapshot(diagnosticsClient(), hostileRoute(), { signal: controller.signal }))
      .rejects
      .toMatchObject({ name: 'AbortError' })
  })

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

  it('downloads the redacted support data after protected export succeeds', async () => {
    const exportedBundle = cloneFixture(supportBundleFixture)
    exportedBundle.generated_at = '2026-06-19T00:05:00Z'
    exportedBundle.correlation_id = 'support-ref-001'
    const exportSupportBundle = vi.fn().mockResolvedValue({
      draft: {},
      confirmation: { audit_receipt: 'receipt-001' },
      data: exportedBundle,
    })
    const client = diagnosticsClient({ exportSupportBundle })
    const createdBlobs: Blob[] = []
    const createObjectURL = vi.fn((blob: Blob) => {
      createdBlobs.push(blob)
      return 'blob:aurora-support-data'
    })
    const revokeObjectURL = vi.fn()
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function clickAnchor(this: HTMLAnchorElement) {
      clickedDownload = this.download
      clickedHref = this.href
    })
    let clickedDownload = ''
    let clickedHref = ''

    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(<MeshDiagnosticsResource client={client} route={hostileRoute()} />)
      await flushPromises()
    })
    await act(async () => {
      checkbox(container).click()
    })
    await act(async () => {
      buttonByText(container, 'Export support data').click()
      await flushPromises()
    })

    expect(exportSupportBundle).toHaveBeenCalledWith(expect.objectContaining({
      request: { event_limit: 10, audit_limit: 10, include_capability_catalog: true },
      reauthConfirmed: true,
    }))
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    const blob = createdBlobs[0]
    expect(blob).toBeInstanceOf(Blob)
    await expect(blobText(blob)).resolves.toBe(JSON.stringify(exportedBundle, null, 2))
    expect(clickedDownload).toBe('aurora-support-data-2026-06-19T00-05-00Z-support-ref-001.json')
    expect(clickedHref).toBe('blob:aurora-support-data')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:aurora-support-data')
    expect(container.textContent).toContain('Support data exported.')

    root.unmount()
    container.remove()
  })

  it('does not read diagnostics or arm support export when the route is disabled', async () => {
    const exportSupportBundle = vi.fn().mockResolvedValue({
      draft: {},
      confirmation: { audit_receipt: 'receipt-denied' },
      data: cloneFixture(supportBundleFixture),
    })
    const client = diagnosticsClient({ exportSupportBundle })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(<MeshDiagnosticsResource client={client} route={disabledRoute()} />)
      await flushPromises()
    })

    expect(client.registry.getWebRTCDiagnostics).not.toHaveBeenCalled()
    expect(client.mesh.getStatus).not.toHaveBeenCalled()
    expect(client.capabilities.listCatalog).not.toHaveBeenCalled()
    expect(client.diagnostics.getSupportBundle).not.toHaveBeenCalled()
    expect(exportSupportBundle).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Access needed')
    expect(buttonByText(container, 'Export support data').disabled).toBe(true)
    expect(checkbox(container).disabled).toBe(true)

    await act(async () => {
      buttonByText(container, 'Export support data').click()
      await flushPromises()
    })
    expect(exportSupportBundle).not.toHaveBeenCalled()

    root.unmount()
    container.remove()
  })

  it('clears approval and ignores a pending support export after route access is revoked', async () => {
    let resolveExport: ((value: unknown) => void) | null = null
    const exportSupportBundle = vi.fn(() => new Promise((resolve) => {
      resolveExport = resolve
    }))
    const client = diagnosticsClient({ exportSupportBundle })
    const createObjectURL = vi.fn(() => 'blob:revoked')
    const revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)

    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(<MeshDiagnosticsResource client={client} route={hostileRoute()} />)
      await flushPromises()
    })
    await act(async () => {
      checkbox(container).click()
    })
    expect(checkbox(container).checked).toBe(true)

    await act(async () => {
      buttonByText(container, 'Export support data').click()
      await flushPromises()
    })
    expect(exportSupportBundle).toHaveBeenCalledTimes(1)

    await act(async () => {
      root.render(<MeshDiagnosticsResource client={client} route={deniedRoute()} />)
      await flushPromises()
    })
    expect(checkbox(container).checked).toBe(false)
    expect(checkbox(container).disabled).toBe(true)
    expect(buttonByText(container, 'Export support data').disabled).toBe(true)

    await act(async () => {
      resolveExport?.({
        draft: {},
        confirmation: { audit_receipt: 'receipt-revoked' },
        data: cloneFixture(supportBundleFixture),
      })
      await flushPromises()
    })

    expect(createObjectURL).not.toHaveBeenCalled()
    expect(revokeObjectURL).not.toHaveBeenCalled()
    expect(click).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('Support data exported.')
    expect(client.registry.getWebRTCDiagnostics).toHaveBeenCalledTimes(1)
    expect(client.diagnostics.getSupportBundle).toHaveBeenCalledTimes(1)

    click.mockRestore()
    root.unmount()
    container.remove()
  })

  it('ignores a pending support export after the same route moves to another signed-in scope', async () => {
    let resolveExport: ((value: unknown) => void) | null = null
    const exportSupportBundle = vi.fn(() => new Promise((resolve) => {
      resolveExport = resolve
    }))
    const client = diagnosticsClientWithMutableAuth({ exportSupportBundle })
    const queryClient = createAuroraQueryClient({ defaultOptions: { queries: { retry: false } } })
    const createObjectURL = vi.fn(() => 'blob:auth-switch')
    const revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)

    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <AuroraQueryProvider client={client} queryClient={queryClient} queryScope={{ backend: 'unit', peerId: 'peer-one' }}>
          <MeshDiagnosticsResource client={client} route={hostileRoute()} />
        </AuroraQueryProvider>,
      )
      await flushPromises()
    })
    await act(async () => {
      checkbox(container).click()
    })
    expect(checkbox(container).checked).toBe(true)

    await act(async () => {
      buttonByText(container, 'Export support data').click()
      await flushPromises()
    })
    expect(exportSupportBundle).toHaveBeenCalledTimes(1)

    await act(async () => {
      client.emitTestAuth({ principalId: 'principal-002' })
      await flushPromises()
    })
    expect(checkbox(container).checked).toBe(false)
    expect(buttonByText(container, 'Export support data').disabled).toBe(true)

    await act(async () => {
      resolveExport?.({
        draft: {},
        confirmation: { audit_receipt: 'receipt-auth-switch' },
        data: cloneFixture(supportBundleFixture),
      })
      await flushPromises()
    })

    expect(createObjectURL).not.toHaveBeenCalled()
    expect(revokeObjectURL).not.toHaveBeenCalled()
    expect(click).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('Support data exported.')

    click.mockRestore()
    root.unmount()
    queryClient.clear()
    container.remove()
  })

  it('ignores a pending support export after the same route moves to another peer scope', async () => {
    let resolveExport: ((value: unknown) => void) | null = null
    const exportSupportBundle = vi.fn(() => new Promise((resolve) => {
      resolveExport = resolve
    }))
    const client = diagnosticsClient({ exportSupportBundle })
    const queryClient = createAuroraQueryClient({ defaultOptions: { queries: { retry: false } } })
    const createObjectURL = vi.fn(() => 'blob:peer-switch')
    const revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)

    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    function Harness({ peerId }: { peerId: string }) {
      return (
        <AuroraQueryProvider client={client} queryClient={queryClient} queryScope={{ backend: 'unit', peerId }}>
          <MeshDiagnosticsResource client={client} route={hostileRoute()} />
        </AuroraQueryProvider>
      )
    }

    await act(async () => {
      root.render(<Harness peerId="peer-one" />)
      await flushPromises()
    })
    await act(async () => {
      checkbox(container).click()
    })
    expect(checkbox(container).checked).toBe(true)

    await act(async () => {
      buttonByText(container, 'Export support data').click()
      await flushPromises()
    })
    expect(exportSupportBundle).toHaveBeenCalledTimes(1)

    await act(async () => {
      root.render(<Harness peerId="peer-two" />)
      await flushPromises()
    })
    expect(checkbox(container).checked).toBe(false)
    expect(buttonByText(container, 'Export support data').disabled).toBe(true)

    await act(async () => {
      resolveExport?.({
        draft: {},
        confirmation: { audit_receipt: 'receipt-peer-switch' },
        data: cloneFixture(supportBundleFixture),
      })
      await flushPromises()
    })

    expect(createObjectURL).not.toHaveBeenCalled()
    expect(revokeObjectURL).not.toHaveBeenCalled()
    expect(click).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('Support data exported.')

    click.mockRestore()
    root.unmount()
    queryClient.clear()
    container.remove()
  })

  it('ignores a pending support export after diagnostics unmounts', async () => {
    let resolveExport: ((value: unknown) => void) | null = null
    const exportSupportBundle = vi.fn(() => new Promise((resolve) => {
      resolveExport = resolve
    }))
    const client = diagnosticsClient({ exportSupportBundle })
    const createObjectURL = vi.fn(() => 'blob:unmounted')
    const revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)

    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(<MeshDiagnosticsResource client={client} route={hostileRoute()} />)
      await flushPromises()
    })
    await act(async () => {
      checkbox(container).click()
    })
    await act(async () => {
      buttonByText(container, 'Export support data').click()
      await flushPromises()
    })
    expect(exportSupportBundle).toHaveBeenCalledTimes(1)

    await act(async () => {
      root.unmount()
      await flushPromises()
    })
    await act(async () => {
      resolveExport?.({
        draft: {},
        confirmation: { audit_receipt: 'receipt-unmounted' },
        data: cloneFixture(supportBundleFixture),
      })
      await flushPromises()
    })

    expect(createObjectURL).not.toHaveBeenCalled()
    expect(revokeObjectURL).not.toHaveBeenCalled()
    expect(click).not.toHaveBeenCalled()

    click.mockRestore()
    container.remove()
  })

  it('dedupes concurrent diagnostics loads inside one query scope', async () => {
    const client = diagnosticsClient()
    const queryClient = createAuroraQueryClient({ defaultOptions: { queries: { retry: false } } })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <AuroraQueryProvider client={client} queryClient={queryClient} queryScope={{ backend: 'unit', peerId: 'peer-one' }}>
          <MeshDiagnosticsResource client={client} route={hostileRoute()} />
          <MeshDiagnosticsResource client={client} route={hostileRoute()} />
        </AuroraQueryProvider>,
      )
      await flushPromises()
    })

    expect(client.registry.getWebRTCDiagnostics).toHaveBeenCalledTimes(1)
    expect(client.mesh.getStatus).toHaveBeenCalledTimes(1)
    expect(client.capabilities.listCatalog).toHaveBeenCalledTimes(1)
    expect(client.diagnostics.getSupportBundle).toHaveBeenCalledTimes(1)

    root.unmount()
    queryClient.clear()
    container.remove()
  })

  it('keeps diagnostics query data separated by peer scope', async () => {
    const client = diagnosticsClient()
    const queryClient = createAuroraQueryClient({ defaultOptions: { queries: { retry: false } } })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <>
          <AuroraQueryProvider client={client} queryClient={queryClient} queryScope={{ backend: 'unit', peerId: 'peer-one' }}>
            <MeshDiagnosticsResource client={client} route={hostileRoute()} />
          </AuroraQueryProvider>
          <AuroraQueryProvider client={client} queryClient={queryClient} queryScope={{ backend: 'unit', peerId: 'peer-two' }}>
            <MeshDiagnosticsResource client={client} route={hostileRoute()} />
          </AuroraQueryProvider>
        </>,
      )
      await flushPromises()
    })

    expect(client.registry.getWebRTCDiagnostics).toHaveBeenCalledTimes(2)
    expect(client.mesh.getStatus).toHaveBeenCalledTimes(2)
    expect(client.capabilities.listCatalog).toHaveBeenCalledTimes(2)
    expect(client.diagnostics.getSupportBundle).toHaveBeenCalledTimes(2)

    root.unmount()
    queryClient.clear()
    container.remove()
  })

  it('projects thin-peer changes locally and refetches server diagnostics only on refresh', async () => {
    const client = diagnosticsClient()
    const thinPeer = thinPeerController(thinPeerSnapshot({ status: 'authorized' }))
    const queryClient = createAuroraQueryClient({ defaultOptions: { queries: { retry: false } } })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <AuroraQueryProvider client={client} queryClient={queryClient} queryScope={{ backend: 'unit', peerId: 'peer-thin' }}>
          <MeshDiagnosticsResource client={client} route={hostileRoute()} thinPeer={thinPeer} />
        </AuroraQueryProvider>,
      )
      await flushPromises()
    })

    expect(client.registry.getWebRTCDiagnostics).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('2026-07-28T00:00:00Z')

    await act(async () => {
      thinPeer.emitTestSnapshot(thinPeerSnapshot({ status: 'authorized', updatedAt: '2026-07-28T00:01:00Z' }))
      await flushPromises()
    })

    expect(container.textContent).toContain('2026-07-28T00:01:00Z')
    expect(client.registry.getWebRTCDiagnostics).toHaveBeenCalledTimes(1)

    await act(async () => {
      buttonByText(container, 'Refresh').click()
      await flushPromises()
    })

    expect(client.registry.getWebRTCDiagnostics).toHaveBeenCalledTimes(2)
    expect(client.mesh.getStatus).toHaveBeenCalledTimes(2)
    expect(client.capabilities.listCatalog).toHaveBeenCalledTimes(2)
    expect(client.diagnostics.getSupportBundle).toHaveBeenCalledTimes(2)

    root.unmount()
    queryClient.clear()
    container.remove()
  })

  it('shows a safe failure message and skips download side effects when protected export fails', async () => {
    const exportSupportBundle = vi.fn().mockRejectedValue(new Error('Gateway.GetSupportBundle WebRTC transport failed'))
    const client = diagnosticsClient({ exportSupportBundle })
    const createObjectURL = vi.fn(() => 'blob:unexpected')
    const revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)

    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(<MeshDiagnosticsResource client={client} route={hostileRoute()} />)
      await flushPromises()
    })
    await act(async () => {
      checkbox(container).click()
    })
    await act(async () => {
      buttonByText(container, 'Export support data').click()
      await flushPromises()
    })

    expect(exportSupportBundle).toHaveBeenCalledTimes(1)
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(revokeObjectURL).not.toHaveBeenCalled()
    expect(click).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Could not connect to this Aurora device. Try again or reconnect the device.')
    expect(container.textContent).not.toContain('Gateway.GetSupportBundle')

    click.mockRestore()
    root.unmount()
    container.remove()
  })

  it.each([
    ['top-level redaction flag is false', (bundle: MutableSupportBundle) => { bundle.secrets_redacted = false }],
    ['top-level redaction flag is missing', (bundle: MutableSupportBundle) => { delete bundle.secrets_redacted }],
    ['nested redaction flag is false', (bundle: MutableSupportBundle) => { bundle.redaction = { ...bundle.redaction, secrets_redacted: false } }],
    ['nested redaction flag is missing', (bundle: MutableSupportBundle) => {
      bundle.redaction = { ...bundle.redaction }
      delete bundle.redaction.secrets_redacted
    }],
  ])('blocks support-data download when %s', async (_case, mutateBundle) => {
    const unsafeBundle = cloneFixture(supportBundleFixture) as MutableSupportBundle
    mutateBundle(unsafeBundle)
    const exportSupportBundle = vi.fn().mockResolvedValue({
      draft: {},
      confirmation: { audit_receipt: 'receipt-unsafe' },
      data: unsafeBundle,
    })
    const client = diagnosticsClient({ exportSupportBundle })
    const createObjectURL = vi.fn(() => 'blob:unexpected')
    const revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)

    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(<MeshDiagnosticsResource client={client} route={hostileRoute()} />)
      await flushPromises()
    })
    await act(async () => {
      checkbox(container).click()
    })
    await act(async () => {
      buttonByText(container, 'Export support data').click()
      await flushPromises()
    })

    expect(exportSupportBundle).toHaveBeenCalledTimes(1)
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(revokeObjectURL).not.toHaveBeenCalled()
    expect(click).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('Support data exported.')
    expect(container.textContent).toContain('Could not connect to this Aurora device. Try again or reconnect the device.')

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

type MutableSupportBundle = Omit<GatewaySupportBundleResponse, 'redaction' | 'secrets_redacted'> & {
  redaction?: Partial<GatewaySupportBundleResponse['redaction']>
  secrets_redacted?: boolean
}

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

function disabledRoute(): RouteAvailability {
  return {
    ...hostileRoute(),
    explanation: 'Troubleshooting is not available for this account.',
    blockers: ['Permission required'],
    routeable: false,
    disabled: true,
    requiresAdminAction: true,
  }
}

function deniedRoute(): RouteAvailability {
  return {
    ...disabledRoute(),
    state: 'denied',
    explanation: 'Access is required before troubleshooting information can be shown.',
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

type DiagnosticsAuthSnapshot = ReturnType<AuroraClient['auth']['snapshot']>

type MutableAuthDiagnosticsClient = AuroraClient & {
  emitTestAuth(overrides: Partial<DiagnosticsAuthSnapshot>): void
}

function diagnosticsClientWithMutableAuth(
  options: { exportSupportBundle?: ReturnType<typeof vi.fn> } = {},
): MutableAuthDiagnosticsClient {
  const baseClient = diagnosticsClient(options)
  let currentAuth = baseClient.auth.snapshot()
  const listeners = new Set<() => void>()

  // Partial SDK test double: diagnosticsClient supplies only the AuroraClient methods MeshDiagnosticsResource reads.
  return {
    ...baseClient,
    auth: {
      snapshot: vi.fn(() => currentAuth),
      subscribe: vi.fn((listener: () => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }),
    },
    emitTestAuth(overrides: Partial<DiagnosticsAuthSnapshot>) {
      currentAuth = { ...currentAuth, ...overrides }
      for (const listener of listeners) listener()
    },
  } as unknown as MutableAuthDiagnosticsClient
}

function diagnosticsClient({ exportSupportBundle }: { exportSupportBundle?: ReturnType<typeof vi.fn> } = {}): AuroraClient {
  return {
    auth: {
      snapshot: vi.fn(() => ({
        state: 'authenticated',
        principalId: 'principal-001',
        deviceId: 'device-001',
        peerId: 'peer-one',
        credentialKind: 'session',
        source: 'test',
        tokenExpiresAt: null,
        status: 200,
        isAdmin: true,
        effectivePermissions: ['admin:diagnostics'],
      })),
      subscribe: vi.fn(() => () => undefined),
    },
    transport: {
      kind: 'test',
    },
    registry: {
      getWebRTCDiagnostics: vi.fn().mockResolvedValue(cloneFixture(webrtcDiagnosticsFixture)),
    },
    mesh: {
      getStatus: vi.fn().mockResolvedValue({ ok: true, data: cloneFixture(meshStatusFixture) }),
    },
    capabilities: {
      listCatalog: vi.fn().mockResolvedValue(cloneFixture(capabilityCatalogFixture)),
    },
    diagnostics: {
      getSupportBundle: vi.fn().mockResolvedValue({ ok: true, data: cloneFixture(supportBundleFixture) }),
      exportSupportBundle: exportSupportBundle ?? vi.fn().mockResolvedValue({
        draft: {},
        confirmation: { audit_receipt: 'receipt-001' },
        data: cloneFixture(supportBundleFixture),
      }),
    },
  } as unknown as AuroraClient
}

type ThinPeerTestController = BrowserWebRtcPeerController & {
  emitTestSnapshot(snapshot: BrowserWebRtcSnapshot): void
  emitTestRoster(roster: MeshPeerRosterSnapshot): void
  getSelectedCandidatePairEvidence: ReturnType<typeof vi.fn>
}

function thinPeerController(initialSnapshot: BrowserWebRtcSnapshot): ThinPeerTestController {
  let current = initialSnapshot
  let currentRoster = thinPeerRoster(initialSnapshot)
  const listeners = new Set<(snapshot: BrowserWebRtcSnapshot) => void>()
  const rosterListeners = new Set<(roster: MeshPeerRosterSnapshot) => void>()
  return {
    snapshot: vi.fn(() => current),
    roster: vi.fn(() => currentRoster),
    subscribe: vi.fn((listener: (snapshot: BrowserWebRtcSnapshot) => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }),
    subscribeRoster: vi.fn((listener: (roster: MeshPeerRosterSnapshot) => void) => {
      rosterListeners.add(listener)
      return () => {
        rosterListeners.delete(listener)
      }
    }),
    getSelectedCandidatePairEvidence: vi.fn().mockResolvedValue({ roundTripTimeMs: 42 }),
    emitTestSnapshot(nextSnapshot: BrowserWebRtcSnapshot) {
      current = nextSnapshot
      currentRoster = thinPeerRoster(nextSnapshot)
      for (const listener of listeners) listener(nextSnapshot)
    },
    emitTestRoster(nextRoster: MeshPeerRosterSnapshot) {
      currentRoster = nextRoster
      for (const listener of rosterListeners) listener(nextRoster)
    },
  } as unknown as ThinPeerTestController
}

function thinPeerRoster(snapshot: BrowserWebRtcSnapshot): MeshPeerRosterSnapshot {
  return {
    primaryPeerId: snapshot.expectedStablePeerId ?? undefined,
    peers: snapshot.expectedStablePeerId ? [{ peerId: snapshot.expectedStablePeerId, primary: true, nodeName: snapshot.nodeName, snapshot }] : [],
    discovered: [],
    updatedAt: snapshot.updatedAt ?? '1970-01-01T00:00:00Z',
  }
}

function thinPeerSnapshot(overrides: Partial<BrowserWebRtcSnapshot> = {}): BrowserWebRtcSnapshot {
  return {
    state: 'authorized',
    status: 'authorized',
    connectionMode: 'webrtc-preferred',
    expectedStablePeerId: 'peer-thin',
    connectedSignalingPeerId: 'signal-thin',
    nodeName: 'Kitchen display',
    icePathCategory: 'direct',
    protocolCapabilities: [],
    reconnectCount: 0,
    pendingCallCount: 0,
    pendingStreamCount: 0,
    pendingSubscriptionCount: 0,
    updatedAt: '2026-07-28T00:00:00Z',
    secureContext: true,
    visible: true,
    focused: true,
    hasHttpFallback: false,
    secretsPersisted: true,
    ...overrides,
  } as unknown as BrowserWebRtcSnapshot
}

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
}

async function blobText(blob: Blob | undefined): Promise<string> {
  if (!blob) throw new Error('download blob missing')
  if (typeof blob.text === 'function') return blob.text()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('blob read failed'))
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.readAsText(blob)
  })
}
