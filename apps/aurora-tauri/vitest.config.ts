import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['./src/test/setup-web-storage.ts'],
    testTimeout: 10_000,
    hookTimeout: 20_000,
    slowTestThreshold: 1_000,
    retry: 0,
  },
})
