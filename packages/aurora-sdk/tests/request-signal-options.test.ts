import { describe, expect, it, vi } from 'vitest'
import {
  AuroraClient,
  AuroraError,
  MockAuroraTransport,
  backupListFixture,
  cloneFixture,
  capabilityCatalogFixture,
  meshStatusFixture,
  pendingToolApprovalsFixture,
  routeExplainFixture,
  schedulerJobsFixture,
  supportBundleFixture,
  toolCatalogFixture,
  toolingApprovalGrantsFixture,
  toolingMcpStatusFixture,
  toolingSharingPolicyFixture
} from '../src/index.js'
import { configSchemaMetadataFixture } from '../src/fixtures.js'

import type { AuroraTransportRequest } from '../src/transport.js'

interface SignalCarrier {
  method: string
  signal?: AbortSignal | undefined
}

describe('Aurora SDK request signal options', () => {
  it('never reuses an unsigned capability read for a cancellable query', async () => {
    const read = vi.fn(() => cloneFixture(capabilityCatalogFixture))
    const client = new AuroraClient({
      transport: MockAuroraTransport.empty().register('Gateway.GetCapabilityCatalog', read)
    })
    await client.capabilities.listCatalog()
    const aborted = new AbortController()
    aborted.abort()
    await expect(client.capabilities.listCatalog({}, { signal: aborted.signal }))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(read).toHaveBeenCalledTimes(1)

    await client.capabilities.listCatalog({}, { signal: new AbortController().signal })
    await client.capabilities.listCatalog({}, { signal: new AbortController().signal })
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('invalidates cached capability and route reads on account and peer changes', async () => {
    const catalog = vi.fn(() => cloneFixture(capabilityCatalogFixture))
    const route = vi.fn(() => cloneFixture(routeExplainFixture))
    const client = new AuroraClient({ transport: MockAuroraTransport.empty()
      .register('Gateway.GetCapabilityCatalog', catalog)
      .register('Gateway.ExplainRoute', route) })
    const readBoth = async () => {
      await client.capabilities.listCatalog()
      await client.routes.explain({ topic: 'TTS.Synthesize' })
    }
    client.auth.setAuthenticated('user-a', ['read'], null, { peerId: 'peer-a' })
    await readBoth()
    await readBoth()
    expect(catalog).toHaveBeenCalledTimes(1)
    expect(route).toHaveBeenCalledTimes(1)

    client.auth.setAuthenticated('user-b', ['read'], null, { peerId: 'peer-b' })
    await readBoth()
    expect(catalog).toHaveBeenCalledTimes(2)
    expect(route).toHaveBeenCalledTimes(2)

    client.auth.setAnonymous()
    await readBoth()
    expect(catalog).toHaveBeenCalledTimes(3)
    expect(route).toHaveBeenCalledTimes(3)
  })

  it('threads caller AbortSignal through focused service request helpers', async () => {
    const controller = new AbortController()
    const seen: SignalCarrier[] = []
    const record = <T,>(value: T) => (request: SignalCarrier) => {
      seen.push({ method: request.method, signal: request.signal })
      return cloneFixture(value)
    }
    const transport = MockAuroraTransport.empty()
      .register('Backup.List', record(backupListFixture))
      .register('Gateway.GetMeshStatus', record(meshStatusFixture))
      .register('Auth.MeshListPeers', record({ peers: [] }))
      .register('Gateway.GetSupportBundle', record(supportBundleFixture))
      .register('Config.GetSchemaMetadata', record(configSchemaMetadataFixture))
      .register('Auth.AuditLog', record({ events: [], total: 0, secrets_redacted: true }))
      .register('Tooling.GetSharingPolicy', record({ policy: toolingSharingPolicyFixture }))
      .register('Tooling.ListApprovalGrants', record(toolingApprovalGrantsFixture))
      .register('Orchestrator.ListPendingToolApprovals', record(pendingToolApprovalsFixture))
      .register('Tooling.GetMCPStatus', record(toolingMcpStatusFixture))
      .register('Gateway.GetRegistry', record(registryFixture()))
      .register('Auth.ListPrincipals', record({ principals: [] }))
      .register('Auth.ListTokens', record({ tokens: [] }))
      .register('Scheduler.ListJobs', record(schedulerJobsFixture))
      .register('DB.GetMessages', record({ messages: [], total: 0, has_more: false }))
      .register('DB.RAGListNamespaces', record({ namespaces: [] }))
      .register('DB.RAGSearchRemote', record({ decision: 'allowed', items: [], denial_reason: null, policy_decision_id: 'policy-1', correlation_id: 'correlation-1' }))
      .register('Gateway.ExplainRoute', record(routeExplainFixture))
      .register('Gateway.GetCapabilityCatalog', record(capabilityCatalogFixture))
      .register('Tooling.GetToolCatalog', record(toolCatalogFixture))

    const client = new AuroraClient({ transport })

    await client.backups.list({ limit: 1 }, { signal: controller.signal })
    await client.mesh.getStatus({ signal: controller.signal })
    await client.mesh.listPeers({}, { signal: controller.signal })
    await client.diagnostics.getSupportBundle({}, { signal: controller.signal })
    await client.config.getSchemaMetadata({}, { signal: controller.signal })
    await client.authApi.auditLog({ limit: 1 }, { signal: controller.signal })
    await client.tools.getPageView(toolCatalogFixture, { signal: controller.signal })
    await client.registry.listMethods({ signal: controller.signal })
    await client.permissions.listCatalog({ signal: controller.signal })
    await client.authApi.listPrincipals({}, { signal: controller.signal })
    await client.tokens.list({}, { signal: controller.signal })
    await client.scheduler.listJobs({}, { signal: controller.signal })
    await client.scheduler.listNormalizedJobs({}, { signal: controller.signal })
    await client.memory.listMessages({}, { signal: controller.signal })
    await client.memory.listNamespaces({}, { signal: controller.signal })
    await client.memory.search({ namespace: 'main.memory', query: 'mesh' }, { signal: controller.signal })
    await client.routes.explain({ topic: 'TTS.Synthesize' }, { signal: controller.signal })
    await client.routes.evaluatePolicy({ routeRequest: { topic: 'TTS.Synthesize' }, privacyClass: 'personal', dataClasses: ['personal'] }, { signal: controller.signal })
    await client.tools.listApprovalCards({}, { signal: controller.signal })
    await client.tools.loadApprovalCards({ signal: controller.signal })

    expect(seen.map((request) => request.method)).toEqual(expect.arrayContaining([
      'Gateway.GetRegistry',
      'Auth.ListPrincipals',
      'Auth.ListTokens',
      'Scheduler.ListJobs',
      'DB.GetMessages',
      'DB.RAGListNamespaces',
      'DB.RAGSearchRemote',
      'Gateway.ExplainRoute',
      'Gateway.GetCapabilityCatalog',
      'Tooling.GetToolCatalog',
    ]))
    expect(seen.every((request) => request.signal === controller.signal)).toBe(true)
  })


  it('does not issue newly signal-aware read helper requests when the caller signal is already aborted', async () => {
    const requestSpy = vi.fn()
    const record = <T,>(value: T) => (request: SignalCarrier) => {
      requestSpy(request)
      return cloneFixture(value)
    }
    const transport = MockAuroraTransport.empty()
      .register('Gateway.GetRegistry', record(registryFixture()))
      .register('Auth.ListPrincipals', record({ principals: [] }))
      .register('Auth.ListTokens', record({ tokens: [] }))
      .register('Scheduler.ListJobs', record(schedulerJobsFixture))
      .register('DB.GetMessages', record({ messages: [], total: 0, has_more: false }))
      .register('DB.RAGListNamespaces', record({ namespaces: [] }))
      .register('DB.RAGSearchRemote', record({ decision: 'allowed', items: [], denial_reason: null, policy_decision_id: 'policy-1', correlation_id: 'correlation-1' }))
      .register('Gateway.ExplainRoute', record(routeExplainFixture))
      .register('Gateway.GetCapabilityCatalog', record(capabilityCatalogFixture))
      .register('Tooling.GetToolCatalog', record(toolCatalogFixture))
    const client = new AuroraClient({ transport })
    const controller = new AbortController()
    controller.abort()

    await expect(client.registry.listMethods({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    await expect(client.permissions.listCatalog({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    await expect(client.authApi.listPrincipals({}, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    await expect(client.tokens.list({}, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    await expect(client.scheduler.listNormalizedJobs({}, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    await expect(client.memory.listMessages({}, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    await expect(client.memory.listNamespaces({}, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    await expect(client.memory.search({ namespace: 'main.memory', query: 'mesh' }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    await expect(client.routes.explain({ topic: 'TTS.Synthesize' }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    await expect(client.routes.evaluatePolicy({ routeRequest: { topic: 'TTS.Synthesize' }, privacyClass: 'personal', dataClasses: ['personal'] }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    await expect(client.tools.listApprovalCards({}, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    await expect(client.tools.loadApprovalCards({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(requestSpy).not.toHaveBeenCalled()
  })


  it('does not issue request-result transport calls when the caller signal is already aborted', async () => {
    const requestSpy = vi.fn()
    const transport = MockAuroraTransport.empty()
      .register('Backup.List', (request) => {
        requestSpy(request)
        return cloneFixture(backupListFixture)
      })
    const client = new AuroraClient({ transport })
    const controller = new AbortController()
    controller.abort()

    await expect(client.backups.list({ limit: 1 }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(requestSpy).not.toHaveBeenCalled()
  })

  it('does not issue Tooling page-view subrequests when the caller signal is already aborted', async () => {
    const requestSpy = vi.fn()
    const transport = MockAuroraTransport.empty()
      .register('Tooling.GetSharingPolicy', (request) => {
        requestSpy(request)
        return { policy: cloneFixture(toolingSharingPolicyFixture) }
      })
      .register('Tooling.ListApprovalGrants', (request) => {
        requestSpy(request)
        return cloneFixture(toolingApprovalGrantsFixture)
      })
      .register('Orchestrator.ListPendingToolApprovals', (request) => {
        requestSpy(request)
        return cloneFixture(pendingToolApprovalsFixture)
      })
      .register('Auth.AuditLog', (request) => {
        requestSpy(request)
        return { events: [], total: 0, secrets_redacted: true }
      })
      .register('Tooling.GetMCPStatus', (request) => {
        requestSpy(request)
        return cloneFixture(toolingMcpStatusFixture)
      })
    const client = new AuroraClient({ transport })
    const controller = new AbortController()
    controller.abort()

    await expect(client.tools.getPageView(toolCatalogFixture, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(requestSpy).not.toHaveBeenCalled()
  })

  it('keeps Tooling page-view cancellation terminal after aggregate requests settle', async () => {
    const controller = new AbortController()
    const transport = MockAuroraTransport.empty()
      .register('Tooling.GetSharingPolicy', () => {
        controller.abort()
        return { policy: cloneFixture(toolingSharingPolicyFixture) }
      })
      .register('Tooling.ListApprovalGrants', () => cloneFixture(toolingApprovalGrantsFixture))
      .register('Orchestrator.ListPendingToolApprovals', () => cloneFixture(pendingToolApprovalsFixture))
      .register('Auth.AuditLog', () => ({ events: [], total: 0, secrets_redacted: true }))
      .register('Tooling.GetMCPStatus', () => cloneFixture(toolingMcpStatusFixture))
    const client = new AuroraClient({ transport })

    await expect(client.tools.getPageView(toolCatalogFixture, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it.each(['request', 'requestResult', 'requestPeer'] as const)(
    'preserves in-flight caller cancellation when %s transport normalizes the abort',
    async (method) => {
      const controller = new AbortController()
      let rejectRequest!: (error: unknown) => void
      let markStarted!: () => void
      const started = new Promise<void>((resolve) => { markStarted = resolve })
      const transport = MockAuroraTransport.empty().register('Backup.List', () => {
        markStarted()
        return new Promise((_, reject) => { rejectRequest = reject })
      })
      const peerTransport = Object.assign(transport, {
        requestPeer: <TData, TPayload>(_peerId: string, request: AuroraTransportRequest<TPayload>) =>
          transport.request<TData, TPayload>(request),
      })
      const client = new AuroraClient({ transport: peerTransport })
      const applyAuthError = vi.spyOn(client.auth, 'applyError')
      const pending = method === 'requestPeer'
        ? client.requestPeer('peer-a', 'Backup.List', {}, { signal: controller.signal })
        : client[method]('Backup.List', {}, { signal: controller.signal })
      const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' })

      await started
      controller.abort()
      rejectRequest(new AuroraError({ code: 'timeout', message: 'Transport cancelled request' }))

      await cancelled
      expect(applyAuthError).not.toHaveBeenCalled()
    },
  )

  it.each(['request', 'requestResult', 'requestPeer'] as const)(
    'discards a late successful %s response after caller cancellation',
    async (method) => {
      const controller = new AbortController()
      let finishRequest!: (data: unknown) => void
      let markStarted!: () => void
      const started = new Promise<void>((resolve) => { markStarted = resolve })
      const transport = MockAuroraTransport.empty().register('Backup.List', () => {
        markStarted()
        return new Promise((resolve) => { finishRequest = resolve })
      })
      const peerTransport = Object.assign(transport, {
        requestPeer: <TData, TPayload>(_peerId: string, request: AuroraTransportRequest<TPayload>) =>
          transport.request<TData, TPayload>(request),
      })
      const client = new AuroraClient({ transport: peerTransport })
      const pending = method === 'requestPeer'
        ? client.requestPeer('peer-a', 'Backup.List', {}, { signal: controller.signal })
        : client[method]('Backup.List', {}, { signal: controller.signal })
      const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' })

      await started
      controller.abort()
      finishRequest(cloneFixture(backupListFixture))

      await cancelled
    },
  )


})

function registryFixture() {
  return {
    modules: [
      {
        module: 'TTS',
        version: '1.0.0',
        summary: 'Text to speech',
        capabilities: [],
        methods: [
          {
            name: 'Synthesize',
            summary: 'Synthesize speech',
            bus_topic: 'TTS.Synthesize',
            exposure: 'both',
            input_model: null,
            output_model: null,
            required_perms: ['tts:use'],
            method_type: 'use',
          },
        ],
      },
    ],
    digest: 'registry-test',
    service_count: 1,
    method_count: 1,
  }
}
