import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const appIntentsSource = readFileSync(
  resolve(
    repoRoot,
    'apps/aurora-tauri/src-tauri/ios/AuroraNativePlugin/Sources/AuroraNativePlugin/AuroraAppIntents.swift',
  ),
  'utf8',
)

const visibleCopyConstructors = [
  /TypeDisplayRepresentation\(name: "([^"]*)"\)/gu,
  /IntentDescription\("([^"]*)"\)/gu,
  /@Parameter\([^\n]*?(?:title|description): "([^"]*)"/gu,
  /IntentDialog\("([^"]*)"\)/gu,
]

describe('iOS AppIntents product copy', () => {
  it('keeps encoded routing fields out of Shortcuts-visible copy', () => {
    const visibleCopy = visibleCopyConstructors.flatMap((pattern) =>
      Array.from(appIntentsSource.matchAll(pattern), (match) => match[1] ?? ''),
    )

    expect(visibleCopy.length).toBeGreaterThan(0)
    expect(visibleCopy.join(' ')).not.toMatch(/backend|correlation|handoff|orchestrator/iu)
    expect(appIntentsSource).not.toMatch(/subtitle:\s*"\\\((?:backendMethod|correlationId)\)/u)
    expect(appIntentsSource).toContain('public let backendMethod: String')
    expect(appIntentsSource).toContain('public let correlationId: String')
  })
})
