import { describe, expect, it } from 'vitest'

import {
  TOOLING_METHODS,
  parseToolingExportCatalogPage
} from '../src/index.js'
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
    expect(encodeURIComponent(vectors.stable_peer_id)).toBe(vectors.percent_encoded_stable_peer_id)
    expect(vectors.provider_service_instance_id).toBe(`local:${vectors.percent_encoded_stable_peer_id}:Tooling`)
    for (const entry of vectors.positive) {
      expect(encodeURIComponent(entry.tool_contract_id)).toBe(entry.percent_encoded_tool_contract_id)
      expect(entry.tool.global_tool_id).toBe(entry.global_tool_id)
      expect(entry.tool.provider_service_instance_id).toBe(vectors.provider_service_instance_id)
      expect(entry.tool.argument_visibility).toEqual(expect.any(Object))
      if (entry.reordered_schema_hash) {
        expect(entry.reordered_schema_hash).toBe(entry.schema_hash)
      }
    }
  })

  it('parses the canonical projection page with the current SDK consumer', () => {
    const page = buildToolingInteropProjectionPage()
    const parsed = parseToolingExportCatalogPage(page)

    expect(parsed).toEqual({ ok: true, page })
    expect(page.page_hash).toBe('79047d6945baba99751152a12ab3a61b289d9dc6784ef0a18d4817ae1d0b55a7')
    expect(page.final_checksum).toBe('1db104fb4e829eed38233f914b43155812eaf16db4655ef1008c02368f681729')
  })

  it('rejects negative projection vectors through the current SDK consumer', () => {
    const vectors = loadToolingInteropVectors()
    for (const entry of vectors.negative) {
      if (entry.case === 'oversized_service_instance_rejected') continue
      const page = buildToolingInteropProjectionPage(vectors) as unknown as Record<string, unknown>
      for (const [key, value] of Object.entries(entry.patch)) {
        if (value === null) delete page[key]
        else page[key] = value
      }
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

  it('records base dependency gaps instead of inventing duplicate production hashing', () => {
    expect(loadToolingInteropVectors().current_dependency_gaps).toEqual([
      'No production TypeScript API computes Tooling canonical global IDs, schema hashes, projection page hashes, or final checksums at this base; SDK tests consume Python-authoritative vectors through current projection-page parsing only.',
      'Python ToolingToolInfo currently accepts non-aurora global_tool_id strings and provider_service_instance_id values without enforcing the local:<percent-encoded-peer>:Tooling pattern; stricter negative identity validation depends on the future generated contract/parser lane.',
      'The current SDK projection-page parser accepts oversized service_instance_id values that Python rejects at max_length=256; full parity depends on the generated boundary parser lane.'
    ])
  })
})
