import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SHERPA_SOURCE_ID_PREFIX = 'sherpa-onnx-source-'

/**
 * Load the selected Sherpa source identity from the canonical voice-runtime manifest.
 *
 * @param {string} repoRoot
 * @returns {{ id: string, version: string, sha256: string }}
 */
export function loadSelectedBrowserEngineSource(repoRoot) {
  const manifestPath = join(repoRoot, 'tools', 'voice-runtime', 'phase4_manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const selectedSources = (manifest.artifacts ?? []).filter((artifact) =>
    artifact?.status === 'selected'
      && artifact?.kind === 'source'
      && artifact?.id?.startsWith(SHERPA_SOURCE_ID_PREFIX)
  )

  if (selectedSources.length !== 1) {
    throw new Error(`expected one selected Sherpa source in ${manifestPath}, found ${selectedSources.length}`)
  }

  const [{ id, version, sha256 }] = selectedSources
  if (typeof id !== 'string' || typeof version !== 'string' || !/^[a-f0-9]{64}$/u.test(sha256)) {
    throw new Error(`selected Sherpa source identity is invalid in ${manifestPath}`)
  }

  return { id, version, sha256 }
}
