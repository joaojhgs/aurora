import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const webStorageTerms = ['local' + 'Storage', 'session' + 'Storage']

describe('Tauri secure storage policy', () => {
  it('keeps credential persistence out of browser web storage', () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
    const files = [
      'apps/aurora-tauri/src/aurora-client.ts',
      'packages/aurora-sdk/src/tauri.ts'
    ]

    for (const file of files) {
      const source = readFileSync(resolve(repoRoot, file), 'utf8')
      for (const term of webStorageTerms) {
        expect(source, `${file} must not reference ${term}`).not.toContain(term)
      }
    }
  })
})
