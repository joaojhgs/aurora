import { defineConfig } from 'vitest/config'

import { coverageConfig } from '../../vitest.coverage.mjs'

export default defineConfig({
  test: {
    coverage: coverageConfig({
      // The web shell is a Next app: its sources live under `app/`, not `src/`.
      include: ['app/**/*.{ts,tsx}', 'src/**/*.{ts,tsx}'],
    }),
  },
})
