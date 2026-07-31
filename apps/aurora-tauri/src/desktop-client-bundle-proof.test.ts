// @vitest-environment node

import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const packageRoot = resolve(__dirname, '..')
const repoRoot = resolve(packageRoot, '..', '..')
const script = join(packageRoot, 'scripts', 'assert-client-bundle-clean.mjs')
const prepare = join(packageRoot, 'scripts', 'prepare-client-bundle.mjs')
const buildFrontend = join(packageRoot, 'scripts', 'build-desktop-client-frontend.mjs')

interface ClientProofContext {
  root: string
  configPath: string
  prepareReportPath: string
  proofReportPath: string
}

function createClientProofContext(): ClientProofContext {
  const root = mkdtempSync(join(tmpdir(), 'aurora-client-proof-context-'))
  return {
    root,
    configPath: join(root, 'tauri.client.conf.json'),
    prepareReportPath: join(root, 'desktop-client-bundle-prepare.json'),
    proofReportPath: join(root, 'desktop-client-bundle-proof.json')
  }
}

function prepareClient(
  context: ClientProofContext,
  extra: NodeJS.ProcessEnv = {},
) {
  execFileSync(process.execPath, [prepare], {
    cwd: packageRoot,
    env: clientEnv(context, extra)
  })
}

function runProof(context: ClientProofContext, bundleDir: string) {
  return spawnSync(process.execPath, [script], {
    cwd: packageRoot,
    env: clientEnv(context, { AURORA_TAURI_THIN_BUNDLE_DIR: bundleDir }),
    encoding: 'utf8'
  })
}

function clientEnv(context: ClientProofContext, extra: NodeJS.ProcessEnv = {}) {
  return {
    ...process.env,
    AURORA_TAURI_CLIENT_CONFIG_PATH: context.configPath,
    AURORA_TAURI_CLIENT_REPORT_PATH: context.prepareReportPath,
    AURORA_TAURI_CLIENT_PROOF_REPORT_PATH: context.proofReportPath,
    ...extra
  }
}

describe('desktop client bundle artifact proof', () => {
  it('passes on a bundle tree without Python sidecar artifacts', () => {
    const context = createClientProofContext()
    prepareClient(context)
    const root = mkdtempSync(join(tmpdir(), 'aurora-client-clean-'))
    mkdirSync(join(root, 'deb', 'Aurora', 'usr', 'bin'), { recursive: true })
    writeFileSync(join(root, 'deb', 'Aurora', 'usr', 'bin', 'aurora'), 'native shell placeholder\n')

    const result = runProof(context, root)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Desktop client bundle proof passed')
    const proofText = readFileSync(context.proofReportPath, 'utf8')
    expect(proofText).toContain('aurora-thin-peer-credentials')
    expect(proofText).not.toContain('aurora-sidecar-status')
  })

  it('fails on forbidden Python sidecar filenames inside an artifact tree', () => {
    const context = createClientProofContext()
    prepareClient(context)
    const root = mkdtempSync(join(tmpdir(), 'aurora-client-forbidden-'))
    mkdirSync(join(root, 'resources', 'app', 'services', 'config'), { recursive: true })
    writeFileSync(join(root, 'resources', 'app', 'services', 'config', 'config_defaults.json'), '{}\n')
    writeFileSync(join(root, 'aurora-sidecar-x86_64-unknown-linux-gnu'), '#!/bin/sh\n')

    const result = runProof(context, root)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Desktop client bundle proof failed')
    expect(result.stderr).toContain('aurora-sidecar')
    expect(result.stderr).toContain('config_defaults')
  })

  it('generates a runtime-configurable policy without compiled endpoints', () => {
    const context = createClientProofContext()
    prepareClient(context, {
      AURORA_TAURI_ALLOWED_REMOTE_ORIGINS:
        'https://gateway.example.invalid wss://signaling.example.invalid',
      AURORA_TAURI_THIN_CONNECTION_MODE: 'webrtc-only',
    })

    const config = JSON.parse(readFileSync(context.configPath, 'utf8'))
    const report = JSON.parse(readFileSync(context.prepareReportPath, 'utf8'))
    expect(config.app.security.csp).toContain("connect-src 'self' http: https: ws: wss:")
    expect(config.app.security.csp).not.toContain('gateway.example.invalid')
    expect(config.app.security.csp).not.toContain('signaling.example.invalid')
    expect(config.bundle.externalBin).toEqual([])
    expect(config.bundle.resources).toEqual({})
    expect(report).toMatchObject({
      bundleMode: 'desktop-client',
      connectionMode: 'runtime-configurable',
      gatewayOrigin: null,
      signalingOrigin: null,
      runtimeConfiguredEndpoints: true,
    })
  })

  it('fails closed when an existing desktop archive cannot be listed or extracted', () => {
    const context = createClientProofContext()
    prepareClient(context)
    const root = mkdtempSync(join(tmpdir(), 'aurora-client-broken-archive-'))
    writeFileSync(join(root, 'Aurora_0.1.0_amd64.deb'), 'not a deb archive\n')

    const result = runProof(context, root)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('failed to inspect deb archive')
    expect(result.stderr).toContain('none were successfully inspected')
  })

  it('does not inject endpoint defaults into the desktop frontend build', () => {
    const root = mkdtempSync(join(tmpdir(), 'aurora-desktop-client-pnpm-'))
    const envPath = join(root, 'frontend-env.json')
    const pnpmStub = join(root, 'pnpm')
    mkdirSync(join(packageRoot, 'dist', 'assets'), { recursive: true })
    writeFileSync(
      join(packageRoot, 'dist', 'assets', 'stale-live-hook.js'),
      '__AURORA_DESKTOP_LIVE_E2E__\naurora.desktop_live_e2e.hook_payload.v1\n',
    )
    writeFileSync(
      pnpmStub,
      `#!/usr/bin/env node\nconst fs = require('node:fs')\nfs.writeFileSync(${JSON.stringify(envPath)}, JSON.stringify({ argv: process.argv.slice(2), gateway: process.env.VITE_AURORA_GATEWAY_URL, signaling: process.env.VITE_AURORA_SIGNALING_URL, connectionMode: process.env.VITE_AURORA_CONNECTION_MODE, runtimeMode: process.env.VITE_AURORA_RUNTIME_MODE }, null, 2))\n`,
    )
    chmodSync(pnpmStub, 0o755)

    const result = spawnSync(process.execPath, [buildFrontend], {
      cwd: packageRoot,
      env: {
        ...process.env,
        PATH: `${root}${delimiter}${process.env.PATH ?? ''}`,
        AURORA_TAURI_ALLOWED_REMOTE_ORIGINS:
          'https://unused-gateway.example.invalid wss://signaling.example.invalid',
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

  it('keeps neutral desktop commands as canonical aliases without thin compile flags', () => {
    const rootPackage = JSON.parse(
      readFileSync(join(repoRoot, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> }
    const packageJson = JSON.parse(
      readFileSync(join(packageRoot, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> }

    expect(rootPackage.scripts['dev:desktop-client']).toBe(
      'pnpm --filter @aurora/tauri-ui dev:desktop-client',
    )
    expect(rootPackage.scripts['dev:desktop-full']).toBe(
      'pnpm --filter @aurora/tauri-ui dev:desktop-full',
    )
    expect(rootPackage.scripts['dev:desktop-thin']).toBe(
      'pnpm dev:desktop-client',
    )
    expect(rootPackage.scripts['dev:desktop-local']).toBe(
      'pnpm dev:desktop-full',
    )

    expect(packageJson.scripts['dev:desktop-client']).toBe(
      'AURORA_TAURI_DEV_AUTOSIDECAR=0 VITE_AURORA_WEBRTC_ALLOW_INSECURE_LOOPBACK=1 pnpm tauri dev --config src-tauri/tauri.client.conf.json',
    )
    expect(packageJson.scripts['dev:desktop-full']).toBe('pnpm tauri dev')
    expect(packageJson.scripts['dev:desktop-thin']).toBe(
      'pnpm dev:desktop-client',
    )
    expect(packageJson.scripts['dev:desktop-local']).toBe(
      'pnpm dev:desktop-full',
    )
    expect(packageJson.scripts['build:bundle:desktop-thin']).toBe(
      'pnpm build:bundle:desktop-client',
    )
    expect(packageJson.scripts['build:bundle:desktop-client']).toContain(
      'src-tauri/tauri.client.conf.json',
    )

    for (const [name, scriptValue] of Object.entries(packageJson.scripts)) {
      if (name.includes('desktop-client') || name === 'dev:desktop-full') {
        expect(scriptValue).not.toMatch(/THIN|desktop-thin|WEBRTC_THIN_CLIENT/)
      }
    }
  })

  it('keeps endpoint and connection-mode environment defaults out of the Tauri runtime', () => {
    const runtimeSource = readFileSync(
      join(packageRoot, 'src', 'aurora-client.ts'),
      'utf8',
    )
    const envTypes = readFileSync(
      join(packageRoot, 'src', 'vite-env.d.ts'),
      'utf8',
    )

    for (const name of [
      'VITE_AURORA_GATEWAY_URL',
      'VITE_AURORA_SIGNALING_URL',
      'VITE_AURORA_CONNECTION_MODE',
    ]) {
      expect(runtimeSource).not.toContain(name)
      expect(envTypes).not.toContain(name)
    }
    expect(runtimeSource).toContain('thinProfileDocument')
    expect(runtimeSource).toContain('const runtimeProfileConfigured = configuredRuntimeProfile')
    expect(runtimeSource).toContain('requiresOnboarding: !runtimeProfileConfigured')
  })

})
