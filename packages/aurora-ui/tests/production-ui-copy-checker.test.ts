// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const checker = join(repoRoot, 'scripts/check_production_ui_copy.py')

describe('production UI copy checker', () => {
  it('handles empty attributes, comments, and URLs without false positives', () => {
    const dir = fixtureDir()
    const file = join(dir, 'safe-render.tsx')
    writeFileSync(file, `
      // runtime transport fallback should be ignored in comments
      export function SafeRender() {
        const docs = "https://aurora.example.test/docs"
        console.info("runtime", docs)
        return <img alt="" title="" />
      }
    `)

    expect(runChecker(file).ok).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it('detects forbidden JSX text and attributes', () => {
    const dir = fixtureDir()
    const file = join(dir, 'unsafe-render.tsx')
    writeFileSync(file, `
      export function UnsafeRender() {
        return <section aria-label="Transport details"><p>Runtime status</p></section>
      }
    `)

    const result = runChecker(file)
    expect(result.ok).toBe(false)
    expect(result.stderr).toContain('transport')
    expect(result.stderr).toContain('runtime')
    rmSync(dir, { recursive: true, force: true })
  })

  it('detects rendered return, ternary, and template literals', () => {
    const dir = fixtureDir()
    const file = join(dir, 'copy-flow.tsx')
    writeFileSync(file, `
      export function copyForState(kind: string) {
        const label = kind === "bad" ? "Fallback route" : \`Runtime \${kind}\`
        return label
      }
    `)

    const result = runChecker(file)
    expect(result.ok).toBe(false)
    expect(result.stderr).toContain('fallback')
    expect(result.stderr).toContain('runtime')
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps imports, internal codes, and logs out of rendered-copy matching', () => {
    const dir = fixtureDir()
    const file = join(dir, 'internal-only.tsx')
    writeFileSync(file, `
      import { WebRTCMode } from "./runtime"
      const mode = "webrtc-preferred"
      const id = "aurora-thin-local"
      console.debug("runtime transport", mode, id)
      export function InternalOnly() {
        return <p>Ready</p>
      }
    `)

    expect(runChecker(file).ok).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it('distinguishes hidden thrown errors from rendered diagnostics', () => {
    const dir = fixtureDir()
    const hidden = join(dir, 'hidden-error.tsx')
    const rendered = join(dir, 'rendered-error.tsx')
    writeFileSync(hidden, `
      function internalFailure() {
        throw new Error("Runtime transport failed")
      }
      export function HiddenError() {
        return <p>Ready</p>
      }
    `)
    writeFileSync(rendered, `
      export function RenderedError() {
        return <p role="alert">Runtime transport failed</p>
      }
    `)

    expect(runChecker(hidden).ok).toBe(true)
    const result = runChecker(rendered)
    expect(result.ok).toBe(false)
    expect(result.stderr).toContain('runtime')
    expect(result.stderr).toContain('transport')
    rmSync(dir, { recursive: true, force: true })
  })

  it('ignores data attributes and non-rendered registries', () => {
    const dir = fixtureDir()
    const file = join(dir, 'registry.tsx')
    writeFileSync(file, `
      const ROUTES = [
        { id: "runtime", label: "Runtime transport", href: "/runtime" },
      ]
      export function RegistryHost() {
        return <div data-thin-peer="runtime-transport">Ready</div>
      }
    `)

    expect(runChecker(file).ok).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it('ignores non-rendered persistence mappings returned from helpers', () => {
    const dir = fixtureDir()
    const file = join(dir, 'mode-persistence.tsx')
    writeFileSync(file, `
      function nodeModeForSelection(mode: string) {
        if (mode === "connect") return "remote-console"
        return "local-provider"
      }
      export function ModePersistence() {
        void nodeModeForSelection("connect")
        return <p>Ready</p>
      }
    `)

    expect(runChecker(file).ok).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it('allows dynamic errors after product-safe mapping', () => {
    const dir = fixtureDir()
    const file = join(dir, 'safe-dynamic.tsx')
    writeFileSync(file, `
      function safeErrorCopy(_error: unknown) {
        return { title: "Connection needs attention" }
      }
      export function SafeDynamic({ error }: { error: unknown }) {
        const copy = safeErrorCopy(error)
        return <p role="alert">{copy.title}</p>
      }
    `)

    expect(runChecker(file).ok).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it('detects raw dynamic error messages in rendered alerts and setters', () => {
    const dir = fixtureDir()
    const file = join(dir, 'raw-error-message.tsx')
    writeFileSync(file, `
      export function RawErrorMessage({ error }: { error: Error }) {
        setMessage(error.message)
        return <AlertDescription>{error.message}</AlertDescription>
      }
    `)

    const result = runChecker(file)
    expect(result.ok).toBe(false)
    expect(result.stderr).toContain('error.message')
    rmSync(dir, { recursive: true, force: true })
  })

  it('detects raw method identifiers in titles and disabled reasons', () => {
    const dir = fixtureDir()
    const file = join(dir, 'raw-method-id.tsx')
    writeFileSync(file, `
      export function RawMethodId({ method }: { method: { busTopic: string } }) {
        return <Button title={method.busTopic} disabledReason={method.busTopic}>Run</Button>
      }
    `)

    const result = runChecker(file)
    expect(result.ok).toBe(false)
    expect(result.stderr).toContain('method.busTopic')
    rmSync(dir, { recursive: true, force: true })
  })

  it('detects tooling-style JSX return expressions that render raw diagnostics', () => {
    const dir = fixtureDir()
    const file = join(dir, 'tooling-return.tsx')
    writeFileSync(file, `
      export function ToolingReturn({ error }: { error: string }) {
        return <Card title="Tools"><AlertDescription>{error}</AlertDescription></Card>
      }
    `)

    const result = runChecker(file)
    expect(result.ok).toBe(false)
    expect(result.stderr).toContain('error')
    rmSync(dir, { recursive: true, force: true })
  })

  it('scans arbitrary production files without path bypasses', () => {
    const dir = fixtureDir()
    const nested = join(dir, 'feature-panel.tsx')
    writeFileSync(nested, 'export function FeaturePanel() { return <p>Thin route</p> }')

    const result = runChecker(dir)
    expect(result.ok).toBe(false)
    expect(result.stderr).toContain('thin')
    rmSync(dir, { recursive: true, force: true })
  })

  it('scans production ts files beyond the shared copy modules', () => {
    const dir = fixtureDir()
    const file = join(dir, 'copy-helper.ts')
    writeFileSync(file, `
      export function statusCopy() {
        return { title: "Runtime transport failed" }
      }
    `)

    const result = runChecker(file)
    expect(result.ok).toBe(false)
    expect(result.stderr).toContain('runtime')
    expect(result.stderr).toContain('transport')
    rmSync(dir, { recursive: true, force: true })
  })

  it('permits only the standardized advanced connection labels in their real component', () => {
    expect(runChecker('packages/aurora-ui/src/web-thin-connection-panel.tsx').ok).toBe(true)
  })
})

function fixtureDir(): string {
  return mkdtempSync(join(tmpdir(), 'aurora-copy-'))
}

function runChecker(path: string): { ok: boolean; stderr: string } {
  try {
    execFileSync('python', [checker, path], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true, stderr: '' }
  } catch (error) {
    const failure = error as { stderr?: string }
    return { ok: false, stderr: failure.stderr ?? '' }
  }
}
