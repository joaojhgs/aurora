import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Deterministic unified version for tests: the plain repo-root VERSION value,
// never a branch-derived dev label.
const auroraVersion = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'VERSION'),
  'utf8',
).trim()

export default defineConfig({
  define: {
    __AURORA_VERSION_LABEL__: JSON.stringify(auroraVersion),
  },
  test: {
    setupFiles: ['./tests/setup-web-storage.ts'],
    testTimeout: 10_000,
    hookTimeout: 20_000,
    slowTestThreshold: 1_000,
    retry: 0,
  },
})
