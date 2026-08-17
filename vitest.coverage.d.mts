/**
 * Types for `vitest.coverage.mjs`.
 *
 * The helper stays plain JavaScript because Vitest loads it while building each
 * package's config, but `apps/aurora-web` typechecks its own `vitest.config.ts`
 * under noImplicitAny, so the untyped import has to be declared here.
 */

export interface CoverageConfigOptions {
  /** Globs to measure. Defaults to `src/**\/*.{ts,tsx}`. */
  include?: string[]
  /** Extra excludes applied on top of the shared set. */
  exclude?: string[]
}

export interface CoverageConfig {
  provider: 'v8'
  reporter: string[]
  reportsDirectory: string
  all: boolean
  include: string[]
  exclude: string[]
}

export function coverageConfig(options?: CoverageConfigOptions): CoverageConfig
