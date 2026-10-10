import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AuroraNativeNodeConfigError,
  createAuroraNativeNodeConfigStore,
  type AuroraNativeNodeConfigCompareAndSwapRequest,
  type AuroraNativeNodeConfigTransport
} from '../src/native-node-config.js'
import {
  emptyAuroraNodeConfigDocument,
  emptyAuroraNodeConfigDocumentV2,
  sanitizeAuroraNodeConfigDocumentV2,
  serializeAuroraNodeConfigDocumentV2,
  type AuroraNodeConfigDocumentV1,
  type AuroraNodeConfigDocumentV2,
  type AuroraNodeFeatureOverrides
} from '../src/node-config.js'
import { TauriLocalTransport, type TauriInvoke } from '../src/tauri.js'

const HANDLE_A = 'a'.repeat(64)
const HANDLE_B = 'b'.repeat(64)
const DOCUMENT_TOKEN = 'c'.repeat(64)
const NEXT_DOCUMENT_TOKEN = 'e'.repeat(64)
const MAX_DOCUMENT_BYTES = 65_536

beforeEach(() => {
  vi.stubGlobal('window', { __AURORA_NODE_CONFIG_DOCUMENT_TOKEN__: DOCUMENT_TOKEN })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function document(revision = 1, updatedAtMs = 1_000): AuroraNodeConfigDocumentV2 {
  return { ...emptyAuroraNodeConfigDocumentV2(updatedAtMs), revision }
}

function documentJson(value = document()): string {
  return serializeAuroraNodeConfigDocumentV2(value)
}

function readReply(
  value: AuroraNodeConfigDocumentV2 = document(),
  draftHandle = HANDLE_A
): { documentJson: string; draftHandle: string } {
  return { documentJson: documentJson(value), draftHandle }
}

function successReply(request: AuroraNativeNodeConfigCompareAndSwapRequest): unknown {
  const candidate = JSON.parse(request.draftJson) as AuroraNodeConfigDocumentV2
  return {
    documentJson: documentJson({ ...candidate, updatedAtMs: 2_000 }),
    savedRevision: candidate.revision
  }
}

function createBoundary(
  reads: unknown[],
  save: (request: AuroraNativeNodeConfigCompareAndSwapRequest) => unknown | Promise<unknown> = successReply
) {
  const invocations: Array<{
    command: string
    args: Record<string, unknown> | undefined
  }> = []
  const invoke: TauriInvoke = async (command, args) => {
    invocations.push({ command, args })
    if (command === 'aurora_node_config_policy_read') return reads.shift()
    if (command === 'aurora_node_config_policy_compare_and_swap') {
      return save(args as unknown as AuroraNativeNodeConfigCompareAndSwapRequest)
    }
    throw new Error(`unexpected command ${command}`)
  }
  const transport = new TauriLocalTransport({ invoke })
  return {
    invocations,
    store: createAuroraNativeNodeConfigStore(transport)
  }
}

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(AuroraNativeNodeConfigError)
  expect(error).toMatchObject({ code })
}

function oversizedValidDocument(): AuroraNodeConfigDocumentV2 {
  const overrides: AuroraNodeFeatureOverrides = {}
  for (let index = 0; index < 256; index += 1) {
    const prefix = `f${index.toString(16).padStart(3, '0')}`
    const featureId = `${prefix}${'x'.repeat(128 - prefix.length)}`
    overrides[featureId] = { enabled: true }
  }
  const result = document(2)
  result.expose.featureOverrides = { tooling: overrides }
  const snapshot: AuroraNodeConfigDocumentV1 = emptyAuroraNodeConfigDocument(900)
  snapshot.expose.featureOverrides = { tooling: overrides }
  result.legacyV1Snapshot = snapshot
  return result
}

describe('native node-config SDK store', () => {
  it('binds a save to its exact read receipt and sends only the native command fields', async () => {
    const { invocations, store } = createBoundary([
      readReply(document(4), HANDLE_A),
      readReply(document(4), HANDLE_B)
    ])
    const receiptA = await store.read()
    vi.stubGlobal('window', { __AURORA_NODE_CONFIG_DOCUMENT_TOKEN__: NEXT_DOCUMENT_TOKEN })
    const receiptB = await store.read()
    receiptA.document.revision = 91

    const candidate = document(5, 1_100)
    const saved = await store.save(receiptA, candidate)

    expect(invocations.slice(0, 2)).toEqual([
      { command: 'aurora_node_config_policy_read', args: { documentToken: DOCUMENT_TOKEN } },
      { command: 'aurora_node_config_policy_read', args: { documentToken: NEXT_DOCUMENT_TOKEN } }
    ])
    expect(invocations[2]).toEqual({
      command: 'aurora_node_config_policy_compare_and_swap',
      args: {
        documentToken: DOCUMENT_TOKEN,
        draftHandle: HANDLE_A,
        expectedRevision: 4,
        draftJson: documentJson(candidate)
      }
    })
    expect(receiptB.document.revision).toBe(4)
    expect(Object.isFrozen(receiptA)).toBe(true)
    expect(Object.keys(receiptA)).toEqual(['document'])
    expect(JSON.stringify(receiptA)).not.toContain(HANDLE_A)
    expect(JSON.stringify(receiptA)).not.toContain(DOCUMENT_TOKEN)
    expect(saved.document.updatedAtMs).toBe(2_000)
    expect(saved.savedRevision).toBe(5)
    expect(Object.keys(saved).sort()).toEqual(['document', 'savedRevision'])
    expect(saved).not.toHaveProperty('effectiveRevision')
    expect(saved).not.toHaveProperty('pendingNextGeneration')
  })

  it('rejects cloned, forged, and foreign-store receipts without a save invoke', async () => {
    const first = createBoundary([readReply(document(3), HANDLE_A)])
    const second = createBoundary([readReply(document(3), HANDLE_B)])
    const receipt = await first.store.read()
    const foreignReceipt = await second.store.read()
    const draft = document(4)

    const cloned = { document: receipt.document }
    for (const invalid of [
      cloned as typeof receipt,
      foreignReceipt,
      { document: document(3) } as unknown as typeof receipt
    ]) {
      try {
        await first.store.save(invalid, draft)
        throw new Error('expected receipt rejection')
      } catch (error) {
        expectCode(error, 'draft_unavailable')
      }
    }
    expect(first.invocations).toHaveLength(1)
    expect(second.invocations).toHaveLength(1)
  })

  it('keeps independent read handles and permits their saves out of order', async () => {
    const { invocations, store } = createBoundary([
      readReply(document(8), HANDLE_A),
      readReply(document(8), HANDLE_B)
    ])
    const first = await store.read()
    const second = await store.read()

    await store.save(second, document(9))
    await store.save(first, document(9))

    expect(invocations.slice(2).map(({ args }) => args)).toEqual([
      { documentToken: DOCUMENT_TOKEN, draftHandle: HANDLE_B, expectedRevision: 8, draftJson: documentJson(document(9)) },
      { documentToken: DOCUMENT_TOKEN, draftHandle: HANDLE_A, expectedRevision: 8, draftJson: documentJson(document(9)) }
    ])
  })

  it('retains a receipt after local validation failure so the draft can be corrected', async () => {
    const { invocations, store } = createBoundary([readReply(document(1))])
    const receipt = await store.read()

    try {
      await store.save(receipt, document(3))
      throw new Error('expected revision validation failure')
    } catch (error) {
      expectCode(error, 'invalid_document')
    }
    expect(invocations).toHaveLength(1)

    await store.save(receipt, document(2))
    expect(invocations).toHaveLength(2)
  })

  it('rejects an oversized valid draft before consuming its receipt', async () => {
    const { invocations, store } = createBoundary([readReply(document(1))])
    const receipt = await store.read()
    const oversized = oversizedValidDocument()
    expect(new TextEncoder().encode(documentJson(oversized)).byteLength).toBeGreaterThan(MAX_DOCUMENT_BYTES)

    try {
      await store.save(receipt, oversized)
      throw new Error('expected size rejection')
    } catch (error) {
      expectCode(error, 'invalid_document')
    }
    expect(invocations).toHaveLength(1)

    await store.save(receipt, document(2))
    expect(invocations).toHaveLength(2)
  })

  it('consumes a receipt before a synchronous transport throw', async () => {
    const receiptResponse = readReply(document(1))
    const compareAndSwap = vi.fn((): Promise<unknown> => {
      throw new Error('private native transport detail')
    })
    const transport: AuroraNativeNodeConfigTransport = {
      nodeConfigPolicyRead: vi.fn(async (documentToken: string) => {
        expect(documentToken).toBe(DOCUMENT_TOKEN)
        return receiptResponse
      }),
      nodeConfigPolicyCompareAndSwap: compareAndSwap
    }
    const store = createAuroraNativeNodeConfigStore(transport)
    const receipt = await store.read()

    try {
      await store.save(receipt, document(2))
      throw new Error('expected transport failure')
    } catch (error) {
      expectCode(error, 'save_unavailable')
      expect((error as Error).message).not.toContain('private native transport detail')
    }
    try {
      await store.save(receipt, document(2))
      throw new Error('expected consumed receipt')
    } catch (error) {
      expectCode(error, 'draft_unavailable')
    }
    expect(compareAndSwap).toHaveBeenCalledTimes(1)
  })

  it('consumes a receipt when the transport rejects and never exposes the rejection', async () => {
    const receiptResponse = readReply(document(1))
    const compareAndSwap = vi.fn(async () => {
      throw new Error('secret handle or storage path')
    })
    const transport: AuroraNativeNodeConfigTransport = {
      nodeConfigPolicyRead: vi.fn(async (documentToken: string) => {
        expect(documentToken).toBe(DOCUMENT_TOKEN)
        return receiptResponse
      }),
      nodeConfigPolicyCompareAndSwap: compareAndSwap
    }
    const store = createAuroraNativeNodeConfigStore(transport)
    const receipt = await store.read()

    try {
      await store.save(receipt, document(2))
      throw new Error('expected transport failure')
    } catch (error) {
      expectCode(error, 'save_unavailable')
      expect((error as Error).message).not.toContain('secret handle or storage path')
    }
    expect(compareAndSwap).toHaveBeenCalledTimes(1)
  })

  it('allows at most one concurrent write attempt for a read receipt', async () => {
    let finishSave: ((value: unknown) => void) | undefined
    const pendingSave = new Promise<unknown>((resolve) => {
      finishSave = resolve
    })
    const { store, invocations } = createBoundary([readReply(document(1))], () => pendingSave)
    const receipt = await store.read()
    const first = store.save(receipt, document(2))
    const second = store.save(receipt, document(2))

    try {
      await second
      throw new Error('expected concurrent receipt rejection')
    } catch (error) {
      expectCode(error, 'draft_unavailable')
    }
    if (finishSave === undefined) throw new Error('save resolver was not initialized')
    finishSave({ documentJson: documentJson(document(2)), savedRevision: 2 })
    await first
    expect(invocations.filter(({ command }) => command === 'aurora_node_config_policy_compare_and_swap'))
      .toHaveLength(1)
  })

  it('allows only one write when draft inspection re-enters save for the same receipt', async () => {
    const { store, invocations } = createBoundary([readReply(document(1))])
    const receipt = await store.read()
    let nestedSave: Promise<unknown> | undefined
    const reentrantDraft = { ...document(2) }
    Object.defineProperty(reentrantDraft, 'version', {
      configurable: true,
      enumerable: true,
      get: () => {
        nestedSave = store.save(receipt, document(2))
        return 2
      }
    })

    try {
      await store.save(receipt, reentrantDraft)
      throw new Error('expected outer reentrant save rejection')
    } catch (error) {
      expectCode(error, 'draft_unavailable')
    }
    if (nestedSave === undefined) throw new Error('draft validation did not re-enter save')
    await nestedSave
    expect(invocations.filter(({ command }) => command === 'aurora_node_config_policy_compare_and_swap'))
      .toHaveLength(1)
  })

  it.each([
    ['version one document', { documentJson: JSON.stringify(emptyAuroraNodeConfigDocument(10)), draftHandle: HANDLE_A }],
    ['corrupt document text', { documentJson: '{not json', draftHandle: HANDLE_A }],
    ['malformed handle', { documentJson: documentJson(), draftHandle: 'abc' }],
    ['handle with trailing LF', { documentJson: documentJson(), draftHandle: `${HANDLE_A}\n` }],
    ['handle with trailing CRLF', { documentJson: documentJson(), draftHandle: `${HANDLE_A}\r\n` }],
    ['uppercase handle', { documentJson: documentJson(), draftHandle: HANDLE_A.toUpperCase() }],
    ['extra envelope field', { ...readReply(), effectiveRevision: 1 }],
    ['missing envelope field', { documentJson: documentJson() }]
  ])('rejects invalid native read response: %s', async (_name, response) => {
    const { store, invocations } = createBoundary([response])
    try {
      await store.read()
      throw new Error('expected invalid response')
    } catch (error) {
      expectCode(error, 'invalid_document')
    }
    expect(invocations).toEqual([{ command: 'aurora_node_config_policy_read', args: { documentToken: DOCUMENT_TOKEN } }])
  })

  it('enforces the exact UTF-8 byte limit for native document text', async () => {
    const exact = documentJson().padEnd(MAX_DOCUMENT_BYTES, ' ')
    expect(new TextEncoder().encode(exact).byteLength).toBe(MAX_DOCUMENT_BYTES)
    const accepted = createBoundary([{ documentJson: exact, draftHandle: HANDLE_A }])
    expect((await accepted.store.read()).document.revision).toBe(1)

    const oversized = createBoundary([{
      documentJson: `${exact} `,
      draftHandle: HANDLE_A
    }])
    try {
      await oversized.store.read()
      throw new Error('expected oversized response rejection')
    } catch (error) {
      expectCode(error, 'invalid_document')
    }
  })

  it('rejects a malformed or non-exact native acknowledgement after consuming the receipt', async () => {
    const { store, invocations } = createBoundary(
      [readReply(document(1))],
      (request) => ({
        documentJson: documentJson(document(2)),
        savedRevision: 2,
        effectiveRevision: request.expectedRevision + 1
      })
    )
    const receipt = await store.read()
    try {
      await store.save(receipt, document(2))
      throw new Error('expected acknowledgement rejection')
    } catch (error) {
      expectCode(error, 'invalid_acknowledgement')
    }
    try {
      await store.save(receipt, document(2))
      throw new Error('expected consumed receipt')
    } catch (error) {
      expectCode(error, 'draft_unavailable')
    }
    expect(invocations.filter(({ command }) => command === 'aurora_node_config_policy_compare_and_swap'))
      .toHaveLength(1)
  })

  it('rejects acknowledgements whose document and saved revision disagree', async () => {
    const { store } = createBoundary([readReply(document(4))], () => ({
      documentJson: documentJson(document(5)),
      savedRevision: 6
    }))
    const receipt = await store.read()
    try {
      await store.save(receipt, document(5))
      throw new Error('expected mismatched acknowledgement rejection')
    } catch (error) {
      expectCode(error, 'invalid_acknowledgement')
    }
  })

  it('returns only the native document and saved revision, never a runtime-effective claim', async () => {
    const nativeDocument = document(2, 3_000)
    const { store } = createBoundary([readReply(document(1))], () => ({
      documentJson: documentJson(nativeDocument),
      savedRevision: 2
    }))
    const receipt = await store.read()
    const result = await store.save(receipt, document(2, 1_100))

    expect(result.document.updatedAtMs).toBe(3_000)
    expect(result.savedRevision).toBe(2)
    expect(Object.keys(result).sort()).toEqual(['document', 'savedRevision'])
    expect(JSON.stringify(result)).not.toMatch(/effectiveRevision|pendingNextGeneration|draftHandle/u)
  })

  it('maps read transport errors to a fixed error with no legacy fallback', async () => {
    const calls: string[] = []
    const invoke: TauriInvoke = async (command) => {
      calls.push(command)
      throw new Error('private storage path and token')
    }
    const store = createAuroraNativeNodeConfigStore(new TauriLocalTransport({ invoke }))
    try {
      await store.read()
      throw new Error('expected read failure')
    } catch (error) {
      expectCode(error, 'read_unavailable')
      expect((error as Error).message).not.toMatch(/private storage path|token/u)
    }
    expect(calls).toEqual(['aurora_node_config_policy_read'])
    expect(calls).not.toContain('aurora_node_config_v2_get')
    expect(calls).not.toContain('aurora_node_config_get')
  })
})
