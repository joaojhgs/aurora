import {
  AURORA_NODE_CONFIG_V2_DRAFT_CONTEXT,
  emptyAuroraNodeConfigDocument,
  emptyAuroraNodeConfigDocumentV2,
  sanitizeAuroraNodeConfigDocument,
  sanitizeAuroraNodeConfigDocumentV2,
  serializeAuroraNodeConfigDocumentV2,
  updateAuroraNodeConfigDocumentV2,
  type AuroraNodeConfigDocumentV1,
  type AuroraNodeConfigDocumentV2,
  type AuroraNodeConfigSaveAck
} from './node-config.js'

const MAX_NATIVE_NODE_CONFIG_BYTES = 65_536
const DRAFT_HANDLE_PATTERN = /^[0-9a-f]{64}$/u

declare const nativeReadReceiptBrand: unique symbol

/** A read result whose private native context is bound to this store instance. */
export interface AuroraNativeNodeConfigReadReceipt {
  readonly document: AuroraNodeConfigDocumentV2
  readonly [nativeReadReceiptBrand]: true
}

/** The bounded command surface required by the native node-policy store. */
export interface AuroraNativeNodeConfigTransport {
  nodeConfigPolicyRead(documentToken: string): Promise<unknown>
  nodeConfigPolicyCompareAndSwap(
    request: AuroraNativeNodeConfigCompareAndSwapRequest
  ): Promise<unknown>
}

/**
 * Compatibility store for callers of the former V1 native node-config API.
 * Non-speech fields are projected through coordinator-backed V2 receipts;
 * speech policy is preserved on every save and clear.
 */
export function createAuroraNodeConfigV1PolicyStore(
  transport: AuroraNativeNodeConfigTransport,
  options: { evidence?: string | undefined } = {}
): {
  readonly evidence?: string
  load(): Promise<AuroraNodeConfigDocumentV1 | null>
  save(document: AuroraNodeConfigDocumentV1): Promise<void>
  clear(): Promise<void>
} {
  const policy = createAuroraNativeNodeConfigStore(transport)
  const enqueue = createWriteQueue()
  const contexts = new WeakMap<object, AuroraNativeNodeConfigReadReceipt>()
  const projectV1 = (document: AuroraNodeConfigDocumentV2): AuroraNodeConfigDocumentV1 =>
    sanitizeAuroraNodeConfigDocument({
      version: 1,
      updatedAtMs: document.updatedAtMs,
      services: document.services,
      expose: document.expose
    })

  return {
    evidence: options.evidence ?? 'Native coordinator-backed non-speech node-config compatibility store',
    load: async () => {
      const receipt = await policy.read()
      const marker = {}
      contexts.set(marker, receipt)
      const document = projectV1(receipt.document)
      Object.defineProperty(document, AURORA_NODE_CONFIG_V2_DRAFT_CONTEXT, {
        value: marker,
        enumerable: true
      })
      return document
    },
    save: (document) => enqueue(async () => {
      const marker = Reflect.get(document, AURORA_NODE_CONFIG_V2_DRAFT_CONTEXT)
      if (typeof marker !== 'object' || marker === null) {
        throw new AuroraNativeNodeConfigError('draft_unavailable')
      }
      const receipt = contexts.get(marker)
      if (receipt === undefined) throw new AuroraNativeNodeConfigError('draft_unavailable')
      const legacy = sanitizeAuroraNodeConfigDocument(document)
      const current = receipt.document
      const next = sanitizeAuroraNodeConfigDocumentV2({
        ...current,
        revision: current.revision + 1,
        updatedAtMs: legacy.updatedAtMs,
        services: legacy.services,
        expose: legacy.expose
      })
      contexts.delete(marker)
      await policy.save(receipt, next)
    }),
    clear: () => enqueue(async () => {
      const receipt = await policy.read()
      const current = receipt.document
      const legacy = emptyAuroraNodeConfigDocument(Date.now())
      const next = sanitizeAuroraNodeConfigDocumentV2({
        ...current,
        revision: current.revision + 1,
        updatedAtMs: legacy.updatedAtMs,
        services: legacy.services,
        expose: legacy.expose
      })
      await policy.save(receipt, next)
    })
  }
}

/** Coordinator-backed V2 storage; initialization and migration belong to the native owner. */
export function createAuroraNodeConfigV2PolicyStore(
  transport: AuroraNativeNodeConfigTransport,
  options: { evidence?: string | undefined } = {}
): {
  readonly evidence?: string
  load(): Promise<AuroraNodeConfigDocumentV2>
  save(document: AuroraNodeConfigDocumentV2): Promise<AuroraNodeConfigSaveAck>
  saveCas(draft: unknown, expectedRevision: number): Promise<{
    document: AuroraNodeConfigDocumentV2
    acknowledgement: AuroraNodeConfigSaveAck
  }>
  clear(): Promise<void>
} {
  const policy = createAuroraNativeNodeConfigStore(transport)
  const enqueue = createWriteQueue()
  const contexts = new WeakMap<object, AuroraNativeNodeConfigReadReceipt>()

  return {
    evidence: options.evidence ?? 'Tauri native-owned v2 speech policy storage',
    load: async () => {
      const receipt = await policy.read()
      const marker = {}
      contexts.set(marker, receipt)
      const document = { ...receipt.document }
      Object.defineProperty(document, AURORA_NODE_CONFIG_V2_DRAFT_CONTEXT, {
        value: marker,
        enumerable: true
      })
      return document
    },
    save: async (_document) => {
      // The coordinator owns canonical initialization. Once it is readable,
      // edits must carry the revision observed by an explicit read.
      await policy.read()
      throw new Error('Node config v2 save requires saveCas')
    },
    saveCas: (draft, expectedRevision) => enqueue(async () => {
      if (typeof draft !== 'object' || draft === null) {
        throw new AuroraNativeNodeConfigError('draft_unavailable')
      }
      const marker = Reflect.get(draft, AURORA_NODE_CONFIG_V2_DRAFT_CONTEXT)
      if (typeof marker !== 'object' || marker === null) {
        throw new AuroraNativeNodeConfigError('draft_unavailable')
      }
      const receipt = contexts.get(marker)
      if (receipt === undefined) throw new AuroraNativeNodeConfigError('draft_unavailable')
      const updated = updateAuroraNodeConfigDocumentV2(receipt.document, draft, expectedRevision)
      contexts.delete(marker)
      const saved = await policy.save(receipt, updated.document)
      return { document: saved.document, acknowledgement: updated.acknowledgement }
    }),
    clear: () => enqueue(async () => {
      const receipt = await policy.read()
      const defaults = emptyAuroraNodeConfigDocumentV2(Date.now())
      const updated = updateAuroraNodeConfigDocumentV2(
        receipt.document,
        { ...defaults, revision: receipt.document.revision + 1 },
        receipt.document.revision
      )
      await policy.save(receipt, updated.document)
    })
  }
}

function createWriteQueue(): <T>(operation: () => Promise<T>) => Promise<T> {
  let writeChain: Promise<unknown> = Promise.resolve()
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const next = writeChain.then(operation, operation)
    writeChain = next.then(() => undefined, () => undefined)
    return next
  }
}

export interface AuroraNativeNodeConfigCompareAndSwapRequest {
  documentToken: string
  draftHandle: string
  expectedRevision: number
  draftJson: string
}

function currentNodeConfigDocumentToken(): string {
  const nativeWindow = (globalThis as typeof globalThis & {
    window?: { __AURORA_NODE_CONFIG_DOCUMENT_TOKEN__?: unknown }
  }).window
  const token = nativeWindow?.__AURORA_NODE_CONFIG_DOCUMENT_TOKEN__
  if (typeof token !== 'string' || token.length !== 64 || !DRAFT_HANDLE_PATTERN.test(token)) {
    throw new Error('Native node settings are unavailable for this page.')
  }
  return token
}

export type AuroraNativeNodeConfigErrorCode =
  | 'read_unavailable'
  | 'invalid_document'
  | 'draft_unavailable'
  | 'save_unavailable'
  | 'invalid_acknowledgement'

const ERROR_MESSAGES: Record<AuroraNativeNodeConfigErrorCode, string> = {
  read_unavailable: 'Device settings could not be read.',
  invalid_document: 'Device settings are invalid.',
  draft_unavailable: 'Read the device settings again before saving.',
  save_unavailable: 'Device settings could not be saved.',
  invalid_acknowledgement: 'The saved device settings could not be confirmed.'
}

/** Fixed, content-free failures from the native node-policy bridge. */
export class AuroraNativeNodeConfigError extends Error {
  readonly code: AuroraNativeNodeConfigErrorCode

  constructor(code: AuroraNativeNodeConfigErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'AuroraNativeNodeConfigError'
    this.code = code
  }
}

/** A confirmed native save result; it does not claim runtime effectiveness. */
export interface AuroraNativeNodeConfigSaveResult {
  readonly document: AuroraNodeConfigDocumentV2
  readonly savedRevision: number
}

interface PrivateReadContext {
  readonly documentToken: string
  readonly draftHandle: string
  readonly revision: number
}

/**
 * Create a store backed only by the native profile-selected node-policy owner.
 * Handles remain private to this store and are consumed by one accepted write
 * attempt; no local persistence or legacy storage fallback is used.
 */
export function createAuroraNativeNodeConfigStore(
  transport: AuroraNativeNodeConfigTransport
): {
  read(): Promise<AuroraNativeNodeConfigReadReceipt>
  save(
    receipt: AuroraNativeNodeConfigReadReceipt,
    draft: unknown
  ): Promise<AuroraNativeNodeConfigSaveResult>
} {
  const contexts = new WeakMap<object, PrivateReadContext>()

  const read = async (): Promise<AuroraNativeNodeConfigReadReceipt> => {
    let documentToken: string
    let response: unknown
    try {
      documentToken = currentNodeConfigDocumentToken()
      response = await transport.nodeConfigPolicyRead(documentToken)
    } catch {
      throw new AuroraNativeNodeConfigError('read_unavailable')
    }

    try {
      const envelope = exactRecord(response, ['documentJson', 'draftHandle'])
      if (envelope === null) throw new Error()
      const document = parseStrictDocument(envelope.documentJson)
      const draftHandle = envelope.draftHandle
      if (
        typeof draftHandle !== 'string' ||
        draftHandle.length !== 64 ||
        !DRAFT_HANDLE_PATTERN.test(draftHandle)
      ) {
        throw new Error()
      }
      const receipt = Object.freeze({ document }) as AuroraNativeNodeConfigReadReceipt
      contexts.set(receipt, { documentToken, draftHandle, revision: document.revision })
      return receipt
    } catch {
      throw new AuroraNativeNodeConfigError('invalid_document')
    }
  }

  const save = async (
    receipt: AuroraNativeNodeConfigReadReceipt,
    draft: unknown
  ): Promise<AuroraNativeNodeConfigSaveResult> => {
    if (!isObject(receipt)) throw new AuroraNativeNodeConfigError('draft_unavailable')
    const context = contexts.get(receipt)
    if (context === undefined) throw new AuroraNativeNodeConfigError('draft_unavailable')

    let document: AuroraNodeConfigDocumentV2
    let draftJson: string
    const expectedRevision = context.revision + 1
    try {
      if (!Number.isSafeInteger(expectedRevision)) throw new Error()
      document = sanitizeAuroraNodeConfigDocumentV2(draft)
      if (document.revision !== expectedRevision) throw new Error()
      draftJson = serializeAuroraNodeConfigDocumentV2(document)
      if (utf8ByteLength(draftJson) > MAX_NATIVE_NODE_CONFIG_BYTES) throw new Error()
    } catch {
      throw new AuroraNativeNodeConfigError('invalid_document')
    }

    // Consume before invoking: synchronous throws and all unknown outcomes are
    // accepted attempts and require a new explicit native read.
    if (!contexts.delete(receipt)) {
      throw new AuroraNativeNodeConfigError('draft_unavailable')
    }
    let acknowledgement: unknown
    try {
      acknowledgement = await transport.nodeConfigPolicyCompareAndSwap({
        documentToken: context.documentToken,
        draftHandle: context.draftHandle,
        expectedRevision: context.revision,
        draftJson
      })
    } catch {
      throw new AuroraNativeNodeConfigError('save_unavailable')
    }

    try {
      const envelope = exactRecord(acknowledgement, ['documentJson', 'savedRevision'])
      if (envelope === null) throw new Error()
      const savedDocument = parseStrictDocument(envelope.documentJson)
      const savedRevision = envelope.savedRevision
      if (
        !Number.isSafeInteger(savedRevision) ||
        (savedRevision as number) < 1 ||
        savedRevision !== expectedRevision ||
        savedDocument.revision !== expectedRevision
      ) {
        throw new Error()
      }
      return Object.freeze({ document: savedDocument, savedRevision: expectedRevision })
    } catch {
      throw new AuroraNativeNodeConfigError('invalid_acknowledgement')
    }
  }

  return Object.freeze({ read, save })
}

function parseStrictDocument(value: unknown): AuroraNodeConfigDocumentV2 {
  if (
    typeof value !== 'string' ||
    value.length > MAX_NATIVE_NODE_CONFIG_BYTES ||
    utf8ByteLength(value) > MAX_NATIVE_NODE_CONFIG_BYTES
  ) {
    throw new Error()
  }
  return sanitizeAuroraNodeConfigDocumentV2(JSON.parse(value) as unknown)
}

function exactRecord(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> | null {
  if (!isObject(value) || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
  ) {
    return null
  }
  return value as Record<string, unknown>
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}
