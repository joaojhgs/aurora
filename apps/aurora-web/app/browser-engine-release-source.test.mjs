import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { loadSelectedBrowserEngineSource } from '../scripts/browser-engine-release-source.mjs'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(appRoot, '..', '..')

describe('browser engine release source', () => {
  it('uses the canonical selected Sherpa source in packaging and verification', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(repoRoot, 'tools/voice-runtime/phase4_manifest.json'), 'utf8'),
    )
    const selected = manifest.artifacts.find(
      (artifact) => artifact.id.startsWith('sherpa-onnx-source-') && artifact.status === 'selected',
    )

    expect(loadSelectedBrowserEngineSource(repoRoot)).toEqual({
      id: selected.id,
      version: selected.version,
      sha256: selected.sha256,
    })

    for (const scriptName of ['package-web-release.mjs', 'assert-web-release-artifact-clean.mjs']) {
      const script = readFileSync(resolve(appRoot, 'scripts', scriptName), 'utf8')
      expect(script).toContain("from './browser-engine-release-source.mjs'")
      expect(script).not.toContain('sherpa-onnx-source-v1.13.4')
    }
  })
})
