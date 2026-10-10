import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  AuroraNodeConfigRevisionConflictError,
  AuroraNodeConfigValidationError,
  emptyAuroraNodeConfigDocument,
  emptyAuroraNodeConfigDocumentV2,
  migrateAuroraNodeConfigDocumentV2,
  sanitizeAuroraNodeConfigDocumentV2,
  updateAuroraNodeConfigDocumentV2,
  type AuroraNodeConfigDocumentV2,
  type AuroraNodeConfigDocumentV1,
} from '../src/node-config.js'

const fixtureDirectory = resolve(
  process.cwd(),
  '../../rust/crates/aurora-voice-core/tests/fixtures',
)

interface PathPatch {
  path: string[]
  value: unknown
}

interface CrossLanguageVectors {
  defaultV1Fixture: string
  defaultV2Fixture: string
  migration: {
    input: string
    now: number
    expectedSnapshotFixture: string
  }
  acceptedStage: {
    inputPatches: PathPatch[]
    expectedPatches: PathPatch[]
  }
  safeNumberSpellings: Array<{ needle: string; replacement: string }>
  rawTokenObjectCases: Array<{ name: string; needle: string; replacement: string }>
  rawJsonStringControl: { needle: string; replacement: string; expectedLanguage: string }
  rawDuplicateControls: { revisionNeedle: string; overwrittenLoneSurrogate: string }
  enumStringControls: Array<{
    path: string[]
    value: string
    enableExperimental?: boolean
  }>
  snapshotNumberSpellings: {
    snapshotVersionNeedle: string
    snapshotVersionReplacement: string
    snapshotTimestampNeedle: string
    snapshotTimestampReplacement: string
  }
  duplicateKeys: {
    needle: string
    firstInvalidLastValid: string
    firstValidLastInvalid: string
  }
  rejectedPatches: Array<PathPatch & { name: string }>
  removedPaths: Array<{ name: string; path: string[] }>
  invalidObjectShapes: Array<{ name: string; path: string[] }>
  invalidMigrationObjectShapes: Array<{ name: string; input: string }>
  sparseMigrations: Array<{
    name: string
    input: string
    now: number
    sttRouting: unknown
    ttsRouting: unknown
  }>
  ordinaryUpdate: {
    draftPatches: PathPatch[]
    expectedPatches: PathPatch[]
    expectedRevision: number
    now: number
  }
  staleConflict: { expectedRevision: number }
  unicodeBoundary: {
    needle: string
    cases: Array<{
      name: string
      replacement: string
      sdkCodeUnit?: number
      sdkValue?: string
      rust: 'accept' | 'reject'
    }>
  }
  intentionalRustSafeguards: {
    draftSnapshot: null
    maxSafeRevision: number
    sdkMaxIncrement: number
    description: string
  }
}

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(fixtureDirectory, name), 'utf8')) as unknown
}

function readVectors(): CrossLanguageVectors {
  return readFixture('node_policy_cross_language_vectors.json') as CrossLanguageVectors
}

function setPath(value: unknown, path: string[], replacement: unknown): void {
  const [leaf, ...reverseParents] = [...path].reverse()
  if (leaf === undefined) throw new Error('vector path must not be empty')
  const parents = reverseParents.reverse()
  let cursor = value as Record<string, unknown>
  for (const key of parents) {
    const next = cursor[key]
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      throw new Error(`vector parent ${key} must be an object`)
    }
    cursor = next as Record<string, unknown>
  }
  cursor[leaf] = replacement
}

function applyPatches(base: unknown, patches: PathPatch[]): unknown {
  const copy = structuredClone(base)
  for (const patch of patches) setPath(copy, patch.path, patch.value)
  return copy
}

function removePath(value: unknown, path: string[]): void {
  const [leaf, ...reverseParents] = [...path].reverse()
  if (leaf === undefined) throw new Error('vector path must not be empty')
  const parents = reverseParents.reverse()
  let cursor = value as Record<string, unknown>
  for (const key of parents) {
    const next = cursor[key]
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      throw new Error(`vector parent ${key} must be an object`)
    }
    cursor = next as Record<string, unknown>
  }
  delete cursor[leaf]
}

describe('Rust and TypeScript node-policy V2 value parity', () => {
  const vectors = readVectors()
  const defaultV1 = readFixture(vectors.defaultV1Fixture)
  const defaultV2 = readFixture(vectors.defaultV2Fixture)
  const baseV1Text = readFileSync(resolve(fixtureDirectory, vectors.defaultV1Fixture), 'utf8')
  const baseV2Text = readFileSync(resolve(fixtureDirectory, vectors.defaultV2Fixture), 'utf8')

  it('matches the shared default-document golden vectors', () => {
    expect(emptyAuroraNodeConfigDocument(100)).toEqual(defaultV1)
    expect(emptyAuroraNodeConfigDocumentV2(100)).toEqual(defaultV2)
  })

  it('matches the shared V1 migration and embedded-snapshot vector', () => {
    const migrated = migrateAuroraNodeConfigDocumentV2(
      JSON.parse(vectors.migration.input) as unknown,
      vectors.migration.now,
    )
    const expected = structuredClone(defaultV2) as AuroraNodeConfigDocumentV2
    expected.legacyV1Snapshot = readFixture(vectors.migration.expectedSnapshotFixture) as AuroraNodeConfigDocumentV1
    expect(migrated).toEqual(expected)
  })

  it('migrates sparse V1 maps while preserving their snapshot and unused timestamps', () => {
    for (const vector of vectors.sparseMigrations) {
      const input = JSON.parse(vector.input) as AuroraNodeConfigDocumentV1
      const migrated = migrateAuroraNodeConfigDocumentV2(input, vector.now)
      expect(migrated.services, vector.name).toEqual(input.services)
      expect(migrated.legacyV1Snapshot, vector.name).toEqual(input)
      expect(migrated.speech.stages.stt.routing, `${vector.name} STT`).toEqual(vector.sttRouting)
      expect(migrated.speech.stages.tts.routing, `${vector.name} TTS`).toEqual(vector.ttsRouting)

      const withUnusedUnsafeNow = migrateAuroraNodeConfigDocumentV2(
        input,
        Number.MAX_SAFE_INTEGER + 1,
      )
      expect(withUnusedUnsafeNow).toEqual(migrated)
    }
    expect(migrateAuroraNodeConfigDocumentV2(defaultV2, Number.MAX_SAFE_INTEGER + 1))
      .toEqual(defaultV2)
  })

  it('normalizes the same accepted stage, null, and unbounded model/language strings', () => {
    const input = applyPatches(defaultV2, vectors.acceptedStage.inputPatches)
    const expected = applyPatches(defaultV2, vectors.acceptedStage.expectedPatches)
    expect(sanitizeAuroraNodeConfigDocumentV2(input)).toEqual(expected)
  })

  it('accepts JavaScript-safe integral number spellings and normalizes them identically', () => {
    for (const vector of vectors.safeNumberSpellings) {
      expect(baseV2Text).toContain(vector.needle)
      const inputText = baseV2Text.replace(vector.needle, vector.replacement)
      expect(inputText).not.toBe(baseV2Text)
      expect(inputText).toContain(vector.replacement)
      expect(sanitizeAuroraNodeConfigDocumentV2(JSON.parse(inputText) as unknown)).toEqual(defaultV2)
    }

    const snapshotSpellings = vectors.snapshotNumberSpellings
    const v1WithSpellings = baseV1Text
      .replace(snapshotSpellings.snapshotVersionNeedle, snapshotSpellings.snapshotVersionReplacement)
      .replace(snapshotSpellings.snapshotTimestampNeedle, snapshotSpellings.snapshotTimestampReplacement)
    expect(v1WithSpellings).not.toBe(baseV1Text)
    const v2WithSnapshot = baseV2Text.replace(
      '"legacyV1Snapshot": null',
      `"legacyV1Snapshot": ${v1WithSpellings}`,
    )
    expect(v2WithSnapshot).not.toBe(baseV2Text)
    const parsedSnapshot = sanitizeAuroraNodeConfigDocumentV2(JSON.parse(v2WithSnapshot) as unknown)
    expect(parsedSnapshot.legacyV1Snapshot?.version).toBe(1)
    expect(parsedSnapshot.legacyV1Snapshot?.updatedAtMs).toBe(100)
  })

  it('keeps serde-private token-shaped objects ordinary and accepts token text in strings', () => {
    for (const vector of vectors.rawTokenObjectCases) {
      expect(baseV2Text).toContain(vector.needle)
      const inputText = baseV2Text.replace(vector.needle, vector.replacement)
      expect(inputText).not.toBe(baseV2Text)
      expect(inputText).toContain(vector.replacement)
      expect(() => sanitizeAuroraNodeConfigDocumentV2(JSON.parse(inputText) as unknown), vector.name)
        .toThrow(AuroraNodeConfigValidationError)
    }

    const stringControl = vectors.rawJsonStringControl
    expect(baseV2Text).toContain(stringControl.needle)
    const inputText = baseV2Text.replace(stringControl.needle, stringControl.replacement)
    expect(inputText).not.toBe(baseV2Text)
    const normalized = sanitizeAuroraNodeConfigDocumentV2(JSON.parse(inputText) as unknown)
    expect(normalized.speech.stages.stt.language).toBe(stringControl.expectedLanguage)

    const duplicate = vectors.rawDuplicateControls
    expect(baseV2Text).toContain(duplicate.revisionNeedle)
    const overwrittenSurrogate = baseV2Text.replace(
      duplicate.revisionNeedle,
      duplicate.overwrittenLoneSurrogate,
    )
    expect(overwrittenSurrogate).not.toBe(baseV2Text)
    expect(sanitizeAuroraNodeConfigDocumentV2(JSON.parse(overwrittenSurrogate) as unknown).revision)
      .toBe(1)
  })

  it('accepts only the shared string spellings for routing enums', () => {
    for (const control of vectors.enumStringControls) {
      const patches: PathPatch[] = [{ path: control.path, value: control.value }]
      if (control.enableExperimental) {
        patches.push({
          path: ['speech', 'stages', 'kws', 'experimentalRemote'],
          value: true,
        })
      }
      const input = applyPatches(defaultV2, patches)
      expect(sanitizeAuroraNodeConfigDocumentV2(input), `${control.path.join('.')}: ${control.value}`)
        .toEqual(input)
    }
  })

  it('uses JSON last-key-wins semantics for duplicate object keys', () => {
    expect(baseV2Text).toContain(vectors.duplicateKeys.needle)
    const firstInvalidLastValid = baseV2Text.replace(
      vectors.duplicateKeys.needle,
      vectors.duplicateKeys.firstInvalidLastValid,
    )
    expect(firstInvalidLastValid).not.toBe(baseV2Text)
    expect(firstInvalidLastValid).toContain('"prefer": "unsupported", "prefer": "local"')
    expect(sanitizeAuroraNodeConfigDocumentV2(JSON.parse(firstInvalidLastValid) as unknown)
      .services.tooling?.routing.prefer).toBe('local')

    const firstValidLastInvalid = baseV2Text.replace(
      vectors.duplicateKeys.needle,
      vectors.duplicateKeys.firstValidLastInvalid,
    )
    expect(firstValidLastInvalid).not.toBe(baseV2Text)
    expect(firstValidLastInvalid).toContain('"prefer": "local", "prefer": "unsupported"')
    expect(() => sanitizeAuroraNodeConfigDocumentV2(JSON.parse(firstValidLastInvalid) as unknown))
      .toThrow(AuroraNodeConfigValidationError)
  })

  it('rejects the same unknown, missing, unsafe, and policy-invalid vectors as Rust', () => {
    for (const patch of vectors.rejectedPatches) {
      const input = applyPatches(defaultV2, [{ path: patch.path, value: patch.value }])
      expect(() => sanitizeAuroraNodeConfigDocumentV2(input), patch.name)
        .toThrow(AuroraNodeConfigValidationError)
    }
    for (const removed of vectors.removedPaths) {
      const input = structuredClone(defaultV2)
      removePath(input, removed.path)
      expect(() => sanitizeAuroraNodeConfigDocumentV2(input), removed.name)
        .toThrow(AuroraNodeConfigValidationError)
    }
    for (const shape of vectors.invalidObjectShapes) {
      const input = applyPatches(defaultV2, [{ path: shape.path, value: [] }])
      expect(() => sanitizeAuroraNodeConfigDocumentV2(input), shape.name)
        .toThrow(AuroraNodeConfigValidationError)
    }
    for (const shape of vectors.invalidMigrationObjectShapes) {
      expect(
        () => migrateAuroraNodeConfigDocumentV2(JSON.parse(shape.input) as unknown),
        shape.name,
      ).toThrow(AuroraNodeConfigValidationError)
    }
  })

  it('matches ordinary candidate updates and stale revision conflicts', () => {
    const draft = applyPatches(defaultV2, vectors.ordinaryUpdate.draftPatches)
    const expected = applyPatches(defaultV2, vectors.ordinaryUpdate.expectedPatches)
    const result = updateAuroraNodeConfigDocumentV2(
      defaultV2 as AuroraNodeConfigDocumentV2,
      draft,
      vectors.ordinaryUpdate.expectedRevision,
      vectors.ordinaryUpdate.now,
    )
    expect(result.document).toEqual(expected)

    expect(() => updateAuroraNodeConfigDocumentV2(
      defaultV2 as AuroraNodeConfigDocumentV2,
      defaultV2,
      vectors.staleConflict.expectedRevision,
      vectors.ordinaryUpdate.now,
    )).toThrow(AuroraNodeConfigRevisionConflictError)
  })

  it('characterizes the exact JSON Unicode-scalar boundary shared with Rust', () => {
    for (const vector of vectors.unicodeBoundary.cases) {
      expect(baseV2Text).toContain(vectors.unicodeBoundary.needle)
      const rawInput = baseV2Text.replace(vectors.unicodeBoundary.needle, vector.replacement)
      expect(rawInput).not.toBe(baseV2Text)
      expect(rawInput).toContain(vector.replacement)

      const parsed = JSON.parse(rawInput) as unknown
      const normalized = sanitizeAuroraNodeConfigDocumentV2(parsed)
      const language = normalized.speech.stages.stt.language
      if (vector.sdkCodeUnit !== undefined) {
        expect(language).toHaveLength(1)
        expect(language?.charCodeAt(0)).toBe(vector.sdkCodeUnit)
      } else {
        expect(language).toBe(vector.sdkValue)
      }
    }
  })

  it('documents the two intentional Rust safeguards as SDK divergences', () => {
    const current = migrateAuroraNodeConfigDocumentV2(
      JSON.parse(vectors.migration.input) as unknown,
      vectors.migration.now,
    )
    const draft = structuredClone(current)
    draft.legacyV1Snapshot = vectors.intentionalRustSafeguards.draftSnapshot
    const sdkUpdate = updateAuroraNodeConfigDocumentV2(
      current,
      draft,
      current.revision,
      vectors.migration.now + 1,
    )
    expect(sdkUpdate.document.legacyV1Snapshot).toBeNull()

    const exhaustedCurrent = structuredClone(defaultV2) as AuroraNodeConfigDocumentV2
    exhaustedCurrent.revision = vectors.intentionalRustSafeguards.maxSafeRevision
    const exhaustedSdkUpdate = updateAuroraNodeConfigDocumentV2(
      exhaustedCurrent,
      exhaustedCurrent,
      exhaustedCurrent.revision,
      vectors.migration.now + 1,
    )
    expect(exhaustedSdkUpdate.document.revision)
      .toBe(vectors.intentionalRustSafeguards.sdkMaxIncrement)
    expect(vectors.intentionalRustSafeguards.description)
      .toContain('documented safeguard divergences, not parity failures')
  })
})
