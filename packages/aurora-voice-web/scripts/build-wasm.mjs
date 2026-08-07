import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(scriptDir, '..')
const repoRoot = resolve(packageDir, '..', '..')
const rustDir = join(repoRoot, 'rust')
const outDir = join(packageDir, 'dist', 'wasm')
const wasmInput = join(rustDir, 'target', 'wasm32-unknown-unknown', 'release', 'aurora_voice_wasm.wasm')
const maxCoreBytes = 143 * 1024
const maxLoaderBytes = 48 * 1024
const forbiddenExtensions = new Set(['.onnx', '.gguf', '.bin', '.safetensors', '.pt', '.pth', '.tflite', '.wav', '.flac', '.mp3'])

run('cargo', ['+1.88.0', 'build', '--locked', '-p', 'aurora-voice-wasm', '--target', 'wasm32-unknown-unknown', '--release'], rustDir)
assertWasmBindgenVersion()

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

run('wasm-bindgen', ['--target', 'web', '--out-dir', outDir, '--out-name', 'aurora_voice_wasm', wasmInput], rustDir)
validateArtifacts()

function assertWasmBindgenVersion() {
  const result = spawnSync('wasm-bindgen', ['--version'], { encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`wasm-bindgen --version failed with status ${result.status}`)
  const version = `${result.stdout}${result.stderr}`.trim().split(/\s+/).at(-1)
  if (version !== '0.2.126') throw new Error(`wasm-bindgen 0.2.126 required, found ${version ?? 'unknown'}`)
}

function validateArtifacts() {
  const required = [
    'aurora_voice_wasm.js',
    'aurora_voice_wasm.d.ts',
    'aurora_voice_wasm_bg.wasm',
    'aurora_voice_wasm_bg.wasm.d.ts'
  ]
  for (const file of required) {
    const path = join(outDir, file)
    if (!existsSync(path)) throw new Error(`missing wasm artifact: ${file}`)
  }
  for (const file of readdirSync(outDir)) {
    const path = join(outDir, file)
    const size = statSync(path).size
    if (forbiddenExtensions.has(extname(file))) throw new Error(`unexpected model artifact: ${file}`)
    if (file.endsWith('.wasm') && size > maxCoreBytes) throw new Error(`wasm core too large: ${size}`)
    if (file.endsWith('.js') && size > maxLoaderBytes) throw new Error(`wasm loader too large: ${size}`)
    if (size <= 0) throw new Error(`empty wasm artifact: ${file}`)
  }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`)
}
