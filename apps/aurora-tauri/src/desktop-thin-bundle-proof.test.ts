// @vitest-environment node

import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const packageRoot = resolve(__dirname, '..')
const script = join(packageRoot, 'scripts', 'assert-thin-bundle-clean.mjs')
const prepare = join(packageRoot, 'scripts', 'prepare-thin-bundle.mjs')
const buildFrontend = join(packageRoot, 'scripts', 'build-desktop-thin-frontend.mjs')

interface ThinProofContext {
  root: string
  configPath: string
  prepareReportPath: string
  proofReportPath: string
}

function createThinProofContext(): ThinProofContext {
  const root = mkdtempSync(join(tmpdir(), 'aurora-thin-proof-context-'))
  return {
    root,
    configPath: join(root, 'tauri.thin.conf.json'),
    prepareReportPath: join(root, 'desktop-thin-bundle-prepare.json'),
    proofReportPath: join(root, 'desktop-thin-bundle-proof.json')
  }
}

function prepareThin(
  context: ThinProofContext,
  extra: NodeJS.ProcessEnv = {},
) {
  execFileSync(process.execPath, [prepare], {
    cwd: packageRoot,
    env: thinEnv(context, extra)
  })
}

function runProof(context: ThinProofContext, bundleDir: string) {
  return spawnSync(process.execPath, [script], {
    cwd: packageRoot,
    env: thinEnv(context, { AURORA_TAURI_THIN_BUNDLE_DIR: bundleDir }),
    encoding: 'utf8'
  })
}

function thinEnv(context: ThinProofContext, extra: NodeJS.ProcessEnv = {}) {
  return {
    ...process.env,
    AURORA_TAURI_THIN_CONFIG_PATH: context.configPath,
    AURORA_TAURI_THIN_REPORT_PATH: context.prepareReportPath,
    AURORA_TAURI_THIN_PROOF_REPORT_PATH: context.proofReportPath,
    ...extra
  }
}

describe('desktop-thin bundle artifact proof', () => {
  it('passes on a bundle tree without Python sidecar artifacts', () => {
    const context = createThinProofContext()
    prepareThin(context)
    const root = mkdtempSync(join(tmpdir(), 'aurora-thin-clean-'))
    mkdirSync(join(root, 'deb', 'Aurora', 'usr', 'bin'), { recursive: true })
    writeFileSync(join(root, 'deb', 'Aurora', 'usr', 'bin', 'aurora'), 'native shell placeholder\n')

    const result = runProof(context, root)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Desktop-thin bundle proof passed')
    const proofText = readFileSync(context.proofReportPath, 'utf8')
    expect(proofText).toContain('aurora-thin-peer-credentials')
    expect(proofText).not.toContain('aurora-sidecar-status')
  })

  it('fails on forbidden Python sidecar filenames inside an artifact tree', () => {
    const context = createThinProofContext()
    prepareThin(context)
    const root = mkdtempSync(join(tmpdir(), 'aurora-thin-forbidden-'))
    mkdirSync(join(root, 'resources', 'app', 'services', 'config'), { recursive: true })
    writeFileSync(join(root, 'resources', 'app', 'services', 'config', 'config_defaults.json'), '{}\n')
    writeFileSync(join(root, 'aurora-sidecar-x86_64-unknown-linux-gnu'), '#!/bin/sh\n')

    const result = runProof(context, root)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Desktop-thin bundle proof failed')
    expect(result.stderr).toContain('aurora-sidecar')
    expect(result.stderr).toContain('config_defaults')
  })

  it('generates a runtime-configurable policy without compiled endpoints', () => {
    const context = createThinProofContext()
    prepareThin(context, {
      AURORA_TAURI_ALLOWED_REMOTE_ORIGINS:
        'https://gateway.example.invalid wss://signaling.example.invalid',
      AURORA_TAURI_THIN_CONNECTION_MODE: 'webrtc-only',
    })

    const config = JSON.parse(readFileSync(context.configPath, 'utf8'))
    const report = JSON.parse(readFileSync(context.prepareReportPath, 'utf8'))
    expect(config.app.security.csp).toContain("connect-src 'self' http: https: ws: wss:")
    expect(config.app.security.csp).not.toContain('gateway.example.invalid')
    expect(config.app.security.csp).not.toContain('signaling.example.invalid')
    expect(report).toMatchObject({
      connectionMode: 'runtime-configurable',
      gatewayOrigin: null,
      signalingOrigin: null,
      runtimeConfiguredEndpoints: true,
    })
  })

  it('fails closed when an existing desktop archive cannot be listed or extracted', () => {
    const context = createThinProofContext()
    prepareThin(context)
    const root = mkdtempSync(join(tmpdir(), 'aurora-thin-broken-archive-'))
    writeFileSync(join(root, 'Aurora_0.1.0_amd64.deb'), 'not a deb archive\n')

    const result = runProof(context, root)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('failed to inspect deb archive')
    expect(result.stderr).toContain('none were successfully inspected')
  })

  it('does not inject endpoint defaults into the desktop frontend build', () => {
    const root = mkdtempSync(join(tmpdir(), 'aurora-desktop-thin-pnpm-'))
    const envPath = join(root, 'frontend-env.json')
    const pnpmStub = join(root, 'pnpm')
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
    expect(JSON.parse(readFileSync(envPath, 'utf8'))).toMatchObject({
      argv: ['build'],
      gateway: '',
      signaling: '',
      connectionMode: '',
      runtimeMode: 'desktop-thin',
    })
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
