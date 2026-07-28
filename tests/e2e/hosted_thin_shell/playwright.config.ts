import { defineConfig } from '@playwright/test'
import path from 'node:path'

const artifactDir =
  process.env.AURORA_HOSTED_THIN_ARTIFACT_DIR ??
  path.join(process.cwd(), 'reports', 'hosted-thin-shell')

export default defineConfig({
  testDir: '.',
  testMatch: 'hosted-thin-shell.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  expect: {
    timeout: 30_000,
  },
  outputDir: path.join(artifactDir, 'playwright-results'),
  reporter: [['line']],
  use: {
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        launchOptions: {
          args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
        },
      },
    },
  ],
})
