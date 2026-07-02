import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

function repoText(path: string) {
  return readFileSync(resolve(repoRoot, path), 'utf8')
}

describe('Tauri dev local sidecar bootstrap contract', () => {
  it('routes pnpm tauri commands through the Aurora wrapper', () => {
    const packageJson = JSON.parse(repoText('apps/aurora-tauri/package.json')) as { scripts: Record<string, string> }

    expect(packageJson.scripts.tauri).toBe('node ./scripts/tauri-cli.mjs')
    expect(packageJson.scripts['test:dev-bootstrap']).toContain('tauri-dev-bootstrap.test.ts')
    expect(packageJson.scripts['tauri:smoke:linux']).toContain('test:dev-bootstrap')
  })

  it('auto-configures tauri dev as the local Python sidecar stack', () => {
    const wrapper = repoText('apps/aurora-tauri/scripts/tauri-cli.mjs')

    expect(wrapper).toContain("if (args[0] === 'dev')")
    expect(wrapper).toContain("env.AURORA_ARCHITECTURE_MODE ??= 'threads'")
    expect(wrapper).toContain("env.AURORA_TAURI_DEV_AUTOSIDECAR ??= '1'")
    expect(wrapper).toContain("env.AURORA_TAURI_SIDECAR_ARGS ??= 'main.py'")
    expect(wrapper).toContain("env.AURORA_TAURI_SIDECAR_PROGRAM = 'uv'")
    expect(wrapper).toContain("env.AURORA_TAURI_SIDECAR_ARGS ??= 'run python main.py'")
    expect(wrapper).toContain("env.AURORA_GATEWAY_URL ??= 'http://127.0.0.1:8000'")
    expect(wrapper).toContain("'.venv'")
    expect(wrapper).toContain('AURORA_TAURI_SIDECAR_PROGRAM')
    expect(wrapper).toContain('if (existsSync(venvPython))')
    expect(wrapper).toContain('env.AURORA_TAURI_SIDECAR_PROGRAM = venvPython')
    expect(wrapper).toContain('real local stack: enabled (Vite + Tauri + Rust-supervised Python sidecar)')
    expect(wrapper).toContain('sidecar cwd')
    expect(wrapper).toContain('architecture mode')
  })

  it('keeps package build profiles explicit while normal dev stays one command', () => {
    const packageJson = JSON.parse(repoText('apps/aurora-tauri/package.json')) as { scripts: Record<string, string> }
    const prepare = repoText('apps/aurora-tauri/scripts/prepare-sidecar.mjs')
    const readme = repoText('apps/aurora-tauri/README.md')
    const buildDocs = repoText('docs/TAURI_DESKTOP_BUILD.md')

    expect(packageJson.scripts['build:bundle']).toBe('pnpm build:bundle:thin')
    for (const profile of ['thin', 'local-cpu', 'local-cuda', 'local-rocm', 'local-metal', 'local-vulkan', 'local-sycl', 'local-rpc', 'full']) {
      expect(packageJson.scripts[`build:bundle:${profile}`]).toContain(`node ./scripts/prepare-sidecar.mjs --profile ${profile}`)
      expect(packageJson.scripts[`build:bundle:${profile}`]).toContain('pnpm tauri build --config src-tauri/tauri.release.conf.json --no-sign')
      expect(packageJson.scripts[`prepare:sidecar:${profile}`]).toBe(`node ./scripts/prepare-sidecar.mjs --profile ${profile}`)
    }
    expect(prepare).toContain("sidecarProfile = cliProfile ?? process.env.AURORA_TAURI_SIDECAR_PROFILE ?? 'thin'")
    expect(prepare).toContain("'thin'")
    expect(readme).toContain('pnpm --filter @aurora/tauri-ui tauri dev')
    expect(readme).toContain('You should not need to run `prepare:sidecar`, build a PyInstaller sidecar, or export `AURORA_TAURI_SIDECAR_SOURCE` for day-to-day development.')
    expect(readme).toContain('Desktop thin: set `VITE_AURORA_GATEWAY_URL`')
    expect(buildDocs).toContain('Desktop thin')
    expect(buildDocs).toContain('`VITE_AURORA_GATEWAY_URL`/HTTP transport')
  })

  it('keeps development sidecar startup separate from package/release sidecar staging', () => {
    const wrapper = repoText('apps/aurora-tauri/scripts/tauri-cli.mjs')
    const docs = repoText('docs/TAURI_DESKTOP_BUILD.md')

    expect(wrapper).not.toContain('prepare-sidecar')
    expect(wrapper).not.toContain('AURORA_TAURI_SIDECAR_SOURCE')
    expect(docs).toContain('pnpm --filter @aurora/tauri-ui tauri dev')
    expect(docs).toContain('Do not run `prepare:sidecar` or set `AURORA_TAURI_SIDECAR_SOURCE` just to use `tauri dev`.')
    expect(docs).toContain('Vite, Rust/Tauri, and Python service logs should appear in the same terminal')
  })
})
