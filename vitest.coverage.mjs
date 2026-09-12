/**
 * Shared Vitest coverage settings for every TypeScript workspace package.
 *
 * One definition so the five packages cannot drift apart in what they measure
 * or exclude. Coverage stays opt-in per run (`--coverage`), so the default
 * `test` scripts remain fast; CI calls `test:coverage` and uploads the lcov
 * report to Codecov under the `typescript` flag.
 */

/** Paths that are never meaningful coverage targets, in any package. */
const SHARED_EXCLUDES = Object.freeze([
  '**/dist/**',
  '**/node_modules/**',
  '**/*.d.ts',
  '**/*.config.{ts,mts,mjs,js}',
  // Test code itself, wherever it lives.
  '**/tests/**',
  '**/test/**',
  '**/*.test.{ts,tsx}',
  '**/*.spec.{ts,tsx}',
  // Code generated from the Python contract inventory. Its correctness is
  // guaranteed by `make check-sdk-backend-contracts`, not by unit tests.
  '**/src/generated/**',
  '**/src/generated-contracts.ts',
  '**/src-tauri/**',
])

/**
 * Build a Vitest `coverage` block.
 *
 * @param {object} [options]
 * @param {string[]} [options.include] Globs to measure. Defaults to `src/**`.
 * @param {string[]} [options.exclude] Extra excludes on top of the shared set.
 * @returns {import('vitest/config').ViteUserConfig['test']['coverage']}
 */
export function coverageConfig(options = {}) {
  return {
    provider: 'v8',
    // `text-summary` keeps CI logs readable; `lcov` is what Codecov ingests.
    reporter: ['text-summary', 'lcov'],
    reportsDirectory: './coverage',
    // Measure every source file, not only the ones a test happened to import.
    // Without this an untested module is silently absent from the denominator
    // and the reported percentage flatters the package.
    all: true,
    include: options.include ?? ['src/**/*.{ts,tsx}'],
    exclude: [...SHARED_EXCLUDES, ...(options.exclude ?? [])],
  }
}
