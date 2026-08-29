import { defineConfig } from '@playwright/test'
import path from 'node:path'

const artifactDir =
  process.env.AURORA_THREE_NODE_ARTIFACT_DIR
  ?? path.join(process.cwd(), 'reports', 'android-three-node')

export default defineConfig({
  testDir: '.',
  testMatch: 'android-three-node-main-live.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 360_000,
  expect: { timeout: 30_000 },
  outputDir: path.join(artifactDir, 'playwright-results'),
  reporter: [['line']],
  use: {
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    viewport: { width: 412, height: 915 },
  },
  projects: [{
    name: 'chromium',
    use: {
      browserName: 'chromium',
      launchOptions: {
        args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
      },
    },
  }],
})
