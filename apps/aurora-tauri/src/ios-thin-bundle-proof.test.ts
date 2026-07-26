// @vitest-environment node

import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const prepareScript = resolve(packageRoot, 'scripts/prepare-ios-thin-bundle.mjs')
const frontendScript = resolve(packageRoot, 'scripts/build-ios-thin-frontend.mjs')

interface GeneratedIosThinConfig {
  build: {
    beforeBuildCommand: string
  }
  app: {
    security: {
      capabilities: string[]
      csp: string
    }
  }
  bundle: {
    externalBin: string[]
    resources: Record<string, string>
  }
}

interface IosThinPrepareReport {
  bundleMode: string
  connectionMode: string
  gatewayOrigin: string | null
  signalingOrigin: string | null
  pythonSidecarStaged: boolean
  secretsRedacted: boolean
}

function prepare(origins: string, connectionMode?: string) {
  const root = mkdtempSync(join(tmpdir(), 'aurora-ios-thin-proof-'))
  const configPath = join(root, 'tauri.ios-thin.conf.json')
  const reportPath = join(root, 'ios-thin-bundle-prepare.json')
  execFileSync(process.execPath, [prepareScript], {
    cwd: packageRoot,
    env: {
      ...process.env,
      AURORA_TAURI_IOS_ALLOWED_REMOTE_ORIGINS: origins,
      AURORA_TAURI_IOS_THIN_CONFIG_PATH: configPath,
      AURORA_TAURI_IOS_THIN_REPORT_PATH: reportPath,
      ...(connectionMode
        ? { AURORA_TAURI_THIN_CONNECTION_MODE: connectionMode }
        : {}),
    },
  })
  return {
    config: JSON.parse(readFileSync(configPath, 'utf8')) as GeneratedIosThinConfig,
    report: JSON.parse(readFileSync(reportPath, 'utf8')) as IosThinPrepareReport,
  }
}

describe('iOS thin bundle policy', () => {
  it('generates a Python-free overlay with exact operator origins', () => {
    const { config, report } = prepare(
      'https://gateway.operator.example wss://signal.operator.example',
    )

    expect(config.app.security.capabilities).toEqual([
      'aurora-ios-thin',
      'aurora-mobile-mesh',
    ])
    expect(config.app.security.csp).toContain(
      "connect-src 'self' https://gateway.operator.example wss://signal.operator.example",
    )
    expect(config.app.security.csp).not.toContain('https://*')
    expect(config.app.security.csp).not.toContain('wss://*')
    expect(config.bundle.externalBin).toEqual([])
    expect(config.bundle.resources).toEqual({})
    expect(config.build.beforeBuildCommand).not.toMatch(/python|prepare-sidecar/i)
    expect(JSON.stringify(config)).not.toMatch(/aurora-sidecar|site-packages/i)
    expect(report).toMatchObject({
      bundleMode: 'ios-thin',
      connectionMode: 'webrtc-preferred',
      gatewayOrigin: 'https://gateway.operator.example',
      signalingOrigin: 'wss://signal.operator.example',
      pythonSidecarStaged: false,
      secretsRedacted: true,
    })
  })

  it('supports a true WebRTC-only package with WSS signaling and no HTTP Gateway', () => {
    const { config, report } = prepare(
      'https://unused-gateway.operator.example wss://signal.operator.example',
      'webrtc-only',
    )

    expect(config.app.security.csp).toContain(
      "connect-src 'self' wss://signal.operator.example",
    )
    expect(config.app.security.csp).not.toContain('https://')
    expect(report).toMatchObject({
      connectionMode: 'webrtc-only',
      gatewayOrigin: null,
      signalingOrigin: 'wss://signal.operator.example',
    })
  })

  it.each([
    'https://*.operator.example',
    'http://gateway.operator.example',
    'ws://signal.operator.example',
    'https://user:secret@gateway.operator.example',
    'https://gateway.operator.example/api',
    'https://gateway.operator.example?mode=thin',
    'wss://signal.operator.example/#room',
  ])('rejects non-exact or insecure origin %s', (origin) => {
    const root = mkdtempSync(join(tmpdir(), 'aurora-ios-thin-reject-'))
    const result = spawnSync(process.execPath, [prepareScript], {
      cwd: packageRoot,
      env: {
        ...process.env,
        AURORA_TAURI_IOS_ALLOWED_REMOTE_ORIGINS: origin,
        AURORA_TAURI_IOS_THIN_CONFIG_PATH: join(root, 'config.json'),
        AURORA_TAURI_IOS_THIN_REPORT_PATH: join(root, 'report.json'),
      },
      encoding: 'utf8',
    })

    expect(result.status).not.toBe(0)
  })

  it.each([
    ['http-only', 'wss://signal.operator.example'],
    ['webrtc-only', 'https://gateway.operator.example'],
    [
      'webrtc-only',
      'https://gateway.operator.example https://not-signaling.operator.example',
    ],
    ['webrtc-preferred', 'wss://signal.operator.example'],
    [
      'webrtc-preferred',
      'https://gateway.operator.example https://not-signaling.operator.example',
    ],
    ['invalid-mode', 'https://gateway.operator.example wss://signal.operator.example'],
  ])('rejects connection mode %s with incompatible origins', (connectionMode, origins) => {
    const root = mkdtempSync(join(tmpdir(), 'aurora-ios-thin-mode-reject-'))
    const result = spawnSync(process.execPath, [prepareScript], {
      cwd: packageRoot,
      env: {
        ...process.env,
        AURORA_TAURI_IOS_ALLOWED_REMOTE_ORIGINS: origins,
        AURORA_TAURI_THIN_CONNECTION_MODE: connectionMode,
        AURORA_TAURI_IOS_THIN_CONFIG_PATH: join(root, 'config.json'),
        AURORA_TAURI_IOS_THIN_REPORT_PATH: join(root, 'report.json'),
      },
      encoding: 'utf8',
    })

    expect(result.status).not.toBe(0)
  })

  it('passes a WSS-only WebRTC mode to the iOS frontend build', () => {
    for (const connectionMode of ['webrtc-only', 'webrtc-preferred']) {
      const rejected = spawnSync(process.execPath, [frontendScript], {
        cwd: packageRoot,
        env: {
          ...process.env,
          AURORA_TAURI_IOS_ALLOWED_REMOTE_ORIGINS:
            'https://gateway.operator.example https://not-signaling.operator.example',
          AURORA_TAURI_THIN_CONNECTION_MODE: connectionMode,
        },
        encoding: 'utf8',
      })
      expect(rejected.status, connectionMode).not.toBe(0)
      expect(rejected.stderr).toContain(
        `${connectionMode} requires an exact WSS signaling origin.`,
      )
    }

    const root = mkdtempSync(join(tmpdir(), 'aurora-ios-thin-pnpm-'))
    const envPath = join(root, 'frontend-env.json')
    const pnpmStub = join(root, 'pnpm')
    writeFileSync(
      pnpmStub,
      `#!/usr/bin/env node\nconst fs = require('node:fs')\nfs.writeFileSync(${JSON.stringify(envPath)}, JSON.stringify({ argv: process.argv.slice(2), gateway: process.env.VITE_AURORA_GATEWAY_URL, signaling: process.env.VITE_AURORA_SIGNALING_URL, connectionMode: process.env.VITE_AURORA_CONNECTION_MODE, runtimeMode: process.env.VITE_AURORA_RUNTIME_MODE }, null, 2))\n`,
    )
    chmodSync(pnpmStub, 0o755)

    const result = spawnSync(process.execPath, [frontendScript], {
      cwd: packageRoot,
      env: {
        ...process.env,
        PATH: `${root}${delimiter}${process.env.PATH ?? ''}`,
        AURORA_TAURI_IOS_ALLOWED_REMOTE_ORIGINS:
          'https://unused-gateway.operator.example wss://signal.operator.example',
        AURORA_TAURI_THIN_CONNECTION_MODE: 'webrtc-only',
      },
      encoding: 'utf8',
    })

    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(readFileSync(envPath, 'utf8'))).toMatchObject({
      argv: ['build'],
      gateway: '',
      signaling: 'wss://signal.operator.example',
      connectionMode: 'webrtc-only',
      runtimeMode: 'ios-thin',
    })
  })

  it('routes the simulator build through the generated exact-origin overlay', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(packageRoot, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> }
    const wrapper = readFileSync(
      resolve(packageRoot, 'scripts/build-ios-thin-bundle.mjs'),
      'utf8',
    )
    const frontendBuilder = readFileSync(
      resolve(packageRoot, 'scripts/build-ios-thin-frontend.mjs'),
      'utf8',
    )

    expect(packageJson.scripts['ios:prepare:thin']).toContain(
      'prepare-ios-thin-bundle.mjs',
    )
    expect(packageJson.scripts['ios:build:thin:simulator']).toContain(
      'build-ios-thin-bundle.mjs',
    )
    expect(wrapper).toContain('AURORA_TAURI_IOS_THIN_CONFIG_PATH')
    expect(wrapper).toContain("'--config',")
    expect(wrapper).toContain("'aarch64-sim'")
    expect(wrapper).toContain('pythonSidecarStaged: false')
    expect(frontendBuilder).toContain("'webrtc-only', 'webrtc-preferred'")
    expect(frontendBuilder).toContain(
      'requires an exact WSS signaling origin',
    )
  })
})
