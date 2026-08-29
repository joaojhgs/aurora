import { describe, expect, it } from 'vitest'

import {
  TOOLING_METHODS,
  parseToolingExportCatalogPage
} from '../src/index.js'
import {
  canonicalToolGlobalId,
  computeProjectionChecksum,
  computeProjectionPageHash,
  providerServiceInstanceId,
  toolSchemaHash
} from '../src/local-tools/index.js'
import { createPeerStorageE2EHarness } from './helpers/peerStorageE2EHarness.js'
import {
  buildToolingInteropProjectionPage,
  loadToolingInteropVectors
} from './helpers/toolingInteropFixtures.js'

describe('Tooling Python interop vectors', () => {
  it('loads Python-authoritative canonical identity vectors through the SDK fixture helper', () => {
    const vectors = loadToolingInteropVectors()

    expect(vectors.method_ids).toMatchObject({
      get_tools: 'Tooling.GetTools',
      get_export_catalog: TOOLING_METHODS.getExportCatalog,
      prepare_execution: TOOLING_METHODS.prepareExecution,
      execute_tool: TOOLING_METHODS.executeTool
    })
    expect(vectors.provider_service_instance_id).toBe(providerServiceInstanceId(vectors.stable_peer_id))
    for (const entry of vectors.positive) {
      expect(entry.global_tool_id).toBe(canonicalToolGlobalId(vectors.stable_peer_id, entry.tool_contract_id))
      expect(entry.tool.global_tool_id).toBe(entry.global_tool_id)
      expect(entry.tool.provider_service_instance_id).toBe(vectors.provider_service_instance_id)
      expect(entry.schema_hash).toBe(toolSchemaHash(entry.tool))
      expect(entry.tool.argument_visibility).toEqual(expect.any(Object))
      if (entry.reordered_tool) {
        expect(toolSchemaHash(entry.reordered_tool)).toBe(entry.schema_hash)
        expect(entry.reordered_schema_hash).toBe(entry.schema_hash)
      }
    }
  })

  it('parses the canonical projection page with the current SDK consumer', () => {
    const page = buildToolingInteropProjectionPage()
    const parsed = parseToolingExportCatalogPage(page)

    expect(parsed).toEqual({ ok: true, page })
    expect(page.page_hash).toBe(computeProjectionPageHash(page))
    expect(page.final_checksum).toBe(computeProjectionChecksum(page.tools, page.retirements, page.blocked_tools))
  })

  it('keeps projection checksums stable for reordered tool, blocked, and retirement inputs', () => {
    const page = buildToolingInteropProjectionPage()
    expect(computeProjectionChecksum(
      [...page.tools].reverse(),
      [...page.retirements].reverse(),
      [...(page.blocked_tools ?? [])].reverse()
    )).toBe(page.final_checksum)
  })

  it('rejects negative projection vectors through the current SDK consumer', () => {
    const vectors = loadToolingInteropVectors()
    for (const entry of vectors.negative) {
      const page = buildToolingInteropProjectionPage(vectors) as unknown as Record<string, unknown>
      applyFixturePatch(page, entry.patch)
      expect(parseToolingExportCatalogPage(page), entry.case).toMatchObject({
        ok: false,
        reasonCode: 'invalid_projection_page'
      })
    }
  })

  it('provides a reusable peer/storage E2E harness without production dependencies', () => {
    const vectors = loadToolingInteropVectors()
    const harness = createPeerStorageE2EHarness(vectors.stable_peer_id)

    harness.writeRecord({
      namespace: 'tooling-projection',
      key: vectors.provider_service_instance_id,
      value: { checksum: vectors.projection.final_checksum }
    })
    harness.grantCapability({
      peerId: 'peer-recipient',
      capabilityId: 'Tooling.ExecuteTool',
      grantedAtRevision: vectors.projection.authority_revision.auth_grant_revision
    })

    expect(harness.readRecord('tooling-projection', vectors.provider_service_instance_id)).toEqual({
      checksum: vectors.projection.final_checksum
    })
    expect(harness.listPeerGrants('peer-recipient')).toEqual([{
      peerId: 'peer-recipient',
      capabilityId: 'Tooling.ExecuteTool',
      grantedAtRevision: 5
    }])
    harness.clear()
    expect(harness.records).toEqual([])
    expect(harness.grants).toEqual([])
  })

  it('records no parser-boundary gaps outside production helper coverage', () => {
    expect(loadToolingInteropVectors()).not.toHaveProperty('current_dependency_gaps')
  })
})

function applyFixturePatch(payload: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [rawPath, value] of Object.entries(patch)) {
    const path = rawPath.split('.')
    let target: unknown = payload
    for (const segment of path.slice(0, -1)) {
      target = Array.isArray(target)
        ? target[Number(segment)]
        : (target as Record<string, unknown>)[segment]
    }
    const key = path.at(-1)
    if (key === undefined) continue
    if (Array.isArray(target)) {
      if (value === null) target.splice(Number(key), 1)
      else target[Number(key)] = value
    } else if (target && typeof target === 'object') {
      const record = target as Record<string, unknown>
      if (value === null) delete record[key]
      else record[key] = value
    }
  }
}
