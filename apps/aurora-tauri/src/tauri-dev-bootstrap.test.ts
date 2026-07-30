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
    expect(packageJson.scripts['dev:smoke']).toBe('node ./scripts/tauri-dev-smoke.mjs')
    const linuxSmoke = packageJson.scripts['tauri:smoke:linux']
    const regressionGate = packageJson.scripts['test:ci-regression-gates'] ?? linuxSmoke

    expect(packageJson.scripts['test:dev-bootstrap']).toContain('tauri-dev-bootstrap.test.ts')
    expect(linuxSmoke).toContain('test:ci-regression-gates')
    expect(regressionGate).toContain('test:dev-bootstrap')
  })

  it('exposes neutral web, desktop-client, desktop-full, and standalone Python dev entrypoints', () => {
    const rootPackage = JSON.parse(repoText('package.json')) as { scripts: Record<string, string> }
    const tauriPackage = JSON.parse(repoText('apps/aurora-tauri/package.json')) as { scripts: Record<string, string> }
    const webPackage = JSON.parse(repoText('apps/aurora-web/package.json')) as { scripts: Record<string, string> }
    const wrapper = repoText('apps/aurora-tauri/scripts/tauri-cli.mjs')
    const hostedPeerRunner = repoText('scripts/hosted_peer_e2e.sh')
    const hostedThinAlias = repoText('scripts/hosted_thin_shell_e2e.sh')
    const tauriRuntime = repoText('apps/aurora-tauri/src/aurora-client.ts')

    expect(rootPackage.scripts.tauri).toBe('pnpm --filter @aurora/tauri-ui tauri')
    expect(rootPackage.scripts['dev:web']).toBe(
      'pnpm --filter @aurora/web dev:web',
    )
    expect(rootPackage.scripts['dev:desktop-client']).toBe(
      'pnpm --filter @aurora/tauri-ui dev:desktop-client',
    )
    expect(rootPackage.scripts['dev:desktop-full']).toBe(
      'pnpm --filter @aurora/tauri-ui dev:desktop-full',
    )
    expect(rootPackage.scripts['dev:desktop-local']).toBe('pnpm dev:desktop-full')
    expect(rootPackage.scripts['dev:desktop-thin']).toBe('pnpm dev:desktop-client')
    expect(rootPackage.scripts['dev:web-thin']).toBe('pnpm dev:web')
    expect(rootPackage.scripts['dev:python']).toBe('pnpm dev:python-service')
    expect(rootPackage.scripts['test:hosted-peer:live']).toBe(
      'scripts/hosted_peer_e2e.sh',
    )
    expect(rootPackage.scripts['test:web-thin:live']).toBe(
      'pnpm test:hosted-peer:live',
    )
    expect(hostedPeerRunner).not.toContain(
      'NEXT_PUBLIC_AURORA_WEBRTC_THIN_CLIENT',
    )
    expect(hostedPeerRunner).toContain(
      '--config tests/e2e/hosted_peer/playwright.config.ts',
    )
    expect(hostedThinAlias).toContain(
      'exec "$ROOT/scripts/hosted_peer_e2e.sh" "$@"',
    )
    for (const rolloutFlag of [
      'VITE_AURORA_MESH_NODE_RUNTIME_V1',
      'VITE_AURORA_LOCAL_TOOL_PROVIDER_V1',
      'VITE_AURORA_LIGHTWEIGHT_ORCHESTRATOR_V1',
    ]) {
      expect(tauriRuntime).toContain(rolloutFlag)
    }
    expect(rootPackage.scripts['dev:python-service']).toContain(
      'AURORA_ARCHITECTURE_MODE=threads',
    )
    expect(rootPackage.scripts['dev:python-service']).toContain(
      'AURORA_UI_ACTIVATE=false',
    )
    expect(rootPackage.scripts['dev:python-service']).toContain(
      'uv run python main.py',
    )

    expect(tauriPackage.scripts['dev:desktop-full']).toBe('pnpm tauri dev')
    expect(tauriPackage.scripts['dev:desktop-local']).toBe('pnpm dev:desktop-full')
    expect(tauriPackage.scripts['dev:desktop-client']).toContain(
      'AURORA_TAURI_DEV_AUTOSIDECAR=0',
    )
    expect(tauriPackage.scripts['dev:desktop-client']).toContain(
      '--config src-tauri/tauri.client.conf.json',
    )
    expect(tauriPackage.scripts['dev:desktop-client']).not.toMatch(
      /THIN|desktop-thin|WEBRTC_THIN_CLIENT|prepare-sidecar|AURORA_TAURI_SIDECAR_/,
    )
    expect(tauriPackage.scripts['dev:desktop-thin']).toBe('pnpm dev:desktop-client')
    expect(webPackage.scripts['dev:web']).toContain('next dev')
    expect(webPackage.scripts['dev:web']).not.toMatch(/THIN|WEBRTC_THIN_CLIENT/)
    expect(webPackage.scripts['dev:web-thin']).toBe('pnpm dev:web')
    expect(wrapper).toContain(
      "if (env.AURORA_TAURI_DEV_AUTOSIDECAR !== '0') applyDevSidecarDefaults(env)",
    )
    expect(wrapper).toContain(
      'desktop client: enabled (Vite + Tauri shell, no Rust-supervised Python sidecar)',
    )
  })

  it('auto-configures tauri dev as the local Python sidecar stack', () => {
    const wrapper = repoText('apps/aurora-tauri/scripts/tauri-cli.mjs')

    expect(wrapper).toContain("if (args[0] === 'dev')")
    expect(wrapper).toContain("env.AURORA_ARCHITECTURE_MODE ??= 'threads'")
    expect(wrapper).toContain("env.AURORA_TAURI_DEV_AUTOSIDECAR ??= '1'")
    expect(wrapper).toContain("env.AURORA_TAURI_SIDECAR_ARGS ??= 'main.py'")
    expect(wrapper).toContain("env.AURORA_TAURI_SIDECAR_PROGRAM = 'uv'")
    expect(wrapper).toContain(
      "env.AURORA_TAURI_SIDECAR_ARGS ??= 'run --no-dev --extra sidecar-thin python main.py'"
    )
    expect(wrapper).toContain("env.AURORA_GATEWAY_URL ??= 'http://127.0.0.1:8000'")
    expect(wrapper).toContain("'.venv'")
    expect(wrapper).toContain('AURORA_TAURI_SIDECAR_PROGRAM')
    expect(wrapper).toContain('if (existsSync(venvPython))')
    expect(wrapper).toContain('env.AURORA_TAURI_SIDECAR_PROGRAM = venvPython')
    expect(wrapper).toContain('[tauri] real local stack: enabled (Vite + Tauri + Rust-supervised Python sidecar)')
    expect(wrapper).toContain('sidecar cwd')
    expect(wrapper).toContain('architecture mode')
    expect(wrapper).toContain("process.once(signal, () => forwardShutdownSignal(signal))")
    expect(wrapper).toContain('child.kill(signal)')
  })

  it('keeps package build profiles explicit while normal dev stays one command', () => {
    const packageJson = JSON.parse(repoText('apps/aurora-tauri/package.json')) as { scripts: Record<string, string> }
    const prepare = repoText('apps/aurora-tauri/scripts/prepare-sidecar.mjs')
    const readme = repoText('apps/aurora-tauri/README.md')
    const buildDocs = repoText('docs/TAURI_DESKTOP_BUILD.md')

    expect(packageJson.scripts['build:bundle']).toBe('pnpm build:bundle:desktop-local')
    expect(packageJson.scripts['build:bundle:thin']).toBe('pnpm build:bundle:desktop-client')
    expect(packageJson.scripts['build:bundle:thin']).not.toContain('prepare-sidecar')
    expect(packageJson.scripts['build:bundle:linux-rpm:desktop-client']).toContain(
      'src-tauri/tauri.client.conf.json',
    )
    expect(packageJson.scripts['build:bundle:linux-rpm:desktop-client']).not.toMatch(
      /thin|THIN/,
    )
    expect(packageJson.scripts['build:bundle:linux-rpm:thin']).toBe(
      'pnpm build:bundle:linux-rpm:desktop-client',
    )
    for (const profile of ['desktop-local-minimal', 'local-cpu', 'local-cuda', 'local-rocm', 'local-metal', 'local-vulkan', 'local-sycl', 'local-rpc', 'full']) {
      expect(packageJson.scripts[`build:bundle:${profile}`]).toContain(`node ./scripts/prepare-sidecar.mjs --profile ${profile}`)
      expect(packageJson.scripts[`build:bundle:${profile}`]).toContain('pnpm tauri build --config src-tauri/tauri.release.conf.json --no-sign')
      expect(packageJson.scripts[`prepare:sidecar:${profile}`]).toBe(`node ./scripts/prepare-sidecar.mjs --profile ${profile}`)
    }
    expect(prepare).toContain("sidecarProfile = cliProfile ?? process.env.AURORA_TAURI_SIDECAR_PROFILE ?? 'desktop-local-minimal'")
    expect(prepare).toContain("sidecarProfile === 'desktop-local-minimal' ? 'thin'")
    expect(readme).toContain('pnpm --filter @aurora/tauri-ui tauri dev')
    expect(readme).toContain('You should not need to run `prepare:sidecar`, build a PyInstaller sidecar, or export `AURORA_TAURI_SIDECAR_SOURCE` for day-to-day development.')
    expect(readme).toContain('Desktop thin: first-run onboarding asks only')
    expect(buildDocs).toContain('Desktop thin')
    expect(buildDocs).toContain('nonsecret connection profile')
  })

  it('keeps development sidecar startup separate from package/release sidecar staging', () => {
    const wrapper = repoText('apps/aurora-tauri/scripts/tauri-cli.mjs')
    const docs = repoText('docs/TAURI_DESKTOP_BUILD.md')

    expect(wrapper).not.toContain('prepare-sidecar')
    expect(wrapper).not.toContain('AURORA_TAURI_SIDECAR_SOURCE')
    expect(docs).toContain('pnpm --filter @aurora/tauri-ui tauri dev')
    expect(docs).toContain('Do not run `prepare:sidecar` or set `AURORA_TAURI_SIDECAR_SOURCE` just to use `tauri dev`.')
    expect(docs).toContain('Vite, Rust/Tauri, and Python service logs should appear in the same terminal')
    expect(docs).toContain('Closing the Tauri window hides Aurora to the tray; explicit tray Quit or Ctrl-C stops the supervised Python sidecar.')
    expect(docs).toContain('`[vite]` for frontend bundler output')
    expect(docs).toContain('`[tauri]` for wrapper/Rust shell output')
    expect(docs).toContain('`[aurora][stdout]`')
  })

  it('keeps bundled sidecar state in the writable Tauri application data directory', () => {
    const rustShell = repoText('apps/aurora-tauri/src-tauri/src/lib.rs')
    const pythonMain = repoText('main.py')
    const configManager = repoText('app/services/config/config_manager.py')

    expect(rustShell).toContain('app.path().app_data_dir()')
    expect(rustShell).toContain('if launch.bundled')
    expect(rustShell).toContain('AURORA_TAURI_SIDECAR_CONFIG_FILE')
    expect(rustShell).toContain('command.env("AURORA_CONFIG_FILE"')
    expect(rustShell).toContain('command.env("AURORA_ENV_FILE"')
    expect(rustShell).toContain('command.env("AURORA_DATA_DIR"')
    expect(pythonMain).toContain('load_dotenv(os.environ.get("AURORA_ENV_FILE", ".env"))')
    expect(configManager).toContain('os.environ.get("AURORA_ENV_FILE", ".env")')
  })

  it('fails the desktop dev smoke when Gateway, process, or log evidence is missing', () => {
    const packageJson = JSON.parse(repoText('apps/aurora-tauri/package.json')) as { scripts: Record<string, string> }
    const smoke = repoText('apps/aurora-tauri/scripts/tauri-dev-smoke.mjs')
    const workflow = repoText('.github/workflows/tauri-desktop.yml')

    expect(packageJson.scripts['dev:smoke']).toBe('node ./scripts/tauri-dev-smoke.mjs')
    expect(smoke).toContain("requiredGatewayPaths = ['/api/health', '/api/registry', '/api/services']")
    expect(smoke).toContain("AURORA_TAURI_DEV_SMOKE_REQUIRE_LOGS ?? '[tauri],[aurora]['")
    expect(smoke).toContain('tauri dev exited before Gateway/log readiness')
    expect(smoke).toContain('timed out waiting for Gateway/log readiness')
    expect(smoke).toContain('writeFileSync(reportPath')
    expect(smoke).toContain('lastGatewayError')
    expect(smoke).toContain("detached: process.platform !== 'win32'")
    expect(smoke).toContain('process.kill(-child.pid, signal)')
    expect(smoke).toContain("terminateOwnedTree('SIGKILL')")
    expect(workflow).toContain('xvfb-run -a pnpm --filter @aurora/tauri-ui dev:smoke')
    expect(workflow).toContain('apps/aurora-tauri/reports/tauri-dev-smoke.json')
  })
})
