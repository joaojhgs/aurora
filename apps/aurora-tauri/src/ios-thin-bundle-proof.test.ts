// @vitest-environment node

import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const prepareScript = resolve(packageRoot, 'scripts/prepare-ios-client-bundle.mjs')
const frontendScript = resolve(packageRoot, 'scripts/build-ios-client-frontend.mjs')

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
  runtimeConfiguredEndpoints: boolean
  pythonSidecarStaged: boolean
  secretsRedacted: boolean
}

function prepare(extra: NodeJS.ProcessEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aurora-ios-client-proof-'))
  const configPath = join(root, 'tauri.ios-client.conf.json')
  const reportPath = join(root, 'ios-client-bundle-prepare.json')
  execFileSync(process.execPath, [prepareScript], {
    cwd: packageRoot,
    env: {
      ...process.env,
      AURORA_TAURI_IOS_CLIENT_CONFIG_PATH: configPath,
      AURORA_TAURI_IOS_CLIENT_REPORT_PATH: reportPath,
      ...extra,
    },
  })
  return {
    config: JSON.parse(readFileSync(configPath, 'utf8')) as GeneratedIosThinConfig,
    report: JSON.parse(readFileSync(reportPath, 'utf8')) as IosThinPrepareReport,
  }
}

describe('iOS client bundle policy', () => {
  it('generates a Python-free overlay with runtime-configurable endpoints', () => {
    const { config, report } = prepare({
      AURORA_TAURI_IOS_ALLOWED_REMOTE_ORIGINS:
        'https://gateway.operator.example wss://signal.operator.example',
      AURORA_TAURI_THIN_CONNECTION_MODE: 'webrtc-only',
    })

    expect(config.app.security.capabilities).toEqual([
      'aurora-ios-thin',
      'aurora-mobile-mesh',
    ])
    expect(config.app.security.csp).toContain(
      "connect-src 'self' http://ipc.localhost http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:* https: wss:",
    )
    expect(config.app.security.csp).not.toContain('gateway.operator.example')
    expect(config.app.security.csp).not.toContain('signal.operator.example')
    expect(config.bundle.externalBin).toEqual([])
    expect(config.bundle.resources).toEqual({})
    expect(config.build.beforeBuildCommand).not.toMatch(/python|prepare-sidecar/i)
    expect(JSON.stringify(config)).not.toMatch(/aurora-sidecar|site-packages/i)
    expect(report).toMatchObject({
      bundleMode: 'ios-client',
      connectionMode: 'runtime-configurable',
      gatewayOrigin: null,
      signalingOrigin: null,
      runtimeConfiguredEndpoints: true,
      pythonSidecarStaged: false,
      secretsRedacted: true,
    })
  })

  it('does not require endpoint env to generate the iOS thin overlay', () => {
    const { config, report } = prepare()

    expect(config.app.security.csp).toContain("connect-src 'self' http://ipc.localhost http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:* https: wss:")
    expect(report).toMatchObject({
      connectionMode: 'runtime-configurable',
      gatewayOrigin: null,
      signalingOrigin: null,
      runtimeConfiguredEndpoints: true,
    })
  })

  it('does not inject endpoint defaults into the iOS frontend build', () => {
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
    const frontendEnv = JSON.parse(readFileSync(envPath, 'utf8'))
    expect(frontendEnv).toMatchObject({
      argv: ['build'],
      gateway: '',
      signaling: '',
      connectionMode: '',
    })
    expect(frontendEnv.runtimeMode).toBeUndefined()
  })

  it('routes the simulator build through the generated runtime-configurable overlay', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(packageRoot, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> }
    const wrapper = readFileSync(
      resolve(packageRoot, 'scripts/build-ios-client-bundle.mjs'),
      'utf8',
    )
    const frontendBuilder = readFileSync(
      resolve(packageRoot, 'scripts/build-ios-client-frontend.mjs'),
      'utf8',
    )

    expect(packageJson.scripts['ios:prepare:client']).toContain('prepare-ios-client-bundle.mjs')
    expect(packageJson.scripts['ios:prepare:thin']).toBe('pnpm ios:prepare:client')
    expect(packageJson.scripts['ios:build:client:simulator']).toContain(
      'build-ios-client-bundle.mjs',
    )
    expect(packageJson.scripts['ios:build:thin:simulator']).toBe(
      'pnpm ios:build:client:simulator',
    )
    expect(wrapper).toContain('AURORA_TAURI_IOS_CLIENT_CONFIG_PATH')
    expect(wrapper).toContain("'--config',")
    expect(wrapper).toContain("'aarch64-sim'")
    expect(wrapper).toContain("join(srcTauriRoot, 'gen', 'apple', 'build')")
    expect(wrapper).toContain(
      'rmSync(appleBuildRoot, { recursive: true, force: true })',
    )
    expect(wrapper).toContain('pythonSidecarStaged: false')
    expect(frontendBuilder).toContain("VITE_AURORA_GATEWAY_URL: ''")
    expect(frontendBuilder).toContain("VITE_AURORA_SIGNALING_URL: ''")
    for (const [name, command] of Object.entries(packageJson.scripts)) {
      if (!name.includes('ios:') || !name.includes(':client')) continue
      expect(command, `${name} must not compile a thin role`).not.toMatch(
        /THIN|ios-thin|VITE_AURORA_RUNTIME_MODE|WEBRTC_THIN_CLIENT/,
      )
    }
  })

  it('allows runtime HTTP/WS endpoints through the iOS WebView transport policy', () => {
    const plist = readFileSync(
      resolve(packageRoot, 'src-tauri/Info.ios.plist'),
      'utf8',
    )

    expect(plist).toContain('<key>NSAppTransportSecurity</key>')
    expect(plist).toContain('<key>NSAllowsArbitraryLoads</key>')
    expect(plist).toContain('<key>NSAllowsArbitraryLoadsInWebContent</key>')
  })
})
