import { defineConfig } from '@playwright/test'
import path from 'node:path'

const artifactDir =
  process.env.AURORA_HOSTED_MESH_NODE_ARTIFACT_DIR ??
  path.join(process.cwd(), 'reports', 'hosted-mesh-node')

export default defineConfig({
  testDir: '.',
  testMatch: 'hosted-mesh-node.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 300_000,
  expect: {
    timeout: 30_000,
  },
  outputDir: path.join(artifactDir, 'playwright-results'),
  reporter: [['line']],
  use: {
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
    viewport: {
      width: 412,
      height: 915,
    },
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
