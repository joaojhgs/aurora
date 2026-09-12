import { defineConfig } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const readyPath = process.env.WEBRTC_INTEROP_READY
const artifactDir =
  process.env.WEBRTC_INTEROP_ARTIFACT_DIR ??
  path.join(process.cwd(), 'reports', 'webrtc-interop', 'playwright')
const ready = readyPath
  ? (JSON.parse(readFileSync(readyPath, 'utf8')) as {
      suppressHostCandidates?: boolean
      timeoutMs?: number
    })
  : {}

export default defineConfig({
  testDir: '.',
  testMatch: 'live-interop.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: Math.max(60_000, (ready.timeoutMs ?? 45_000) + 30_000),
  expect: {
    timeout: 10_000,
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
    {
      name: 'firefox',
      use: {
        browserName: 'firefox',
        launchOptions: ready.suppressHostCandidates
          ? {
              firefoxUserPrefs: {
                'media.peerconnection.ice.no_host': true,
              },
            }
          : undefined,
      },
    },
    {
      name: 'webkit',
      use: {
        browserName: 'webkit',
      },
    },
  ],
})
