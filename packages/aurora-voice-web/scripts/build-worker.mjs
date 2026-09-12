import { existsSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(scriptDir, '..')
const outDir = join(packageDir, 'dist')
const workerEntry = join(outDir, 'voice-worker.js')
const bundledWorker = join(outDir, 'voice-worker.bundle.js')
const staleWorkerMap = join(outDir, 'voice-worker.js.map')
const wasmCore = join(outDir, 'wasm', 'aurora_voice_wasm_bg.wasm')
const maxWorkerBytes = 96 * 1024

if (!existsSync(workerEntry)) throw new Error('missing worker entry; run build:typescript first')
if (!existsSync(wasmCore)) throw new Error('missing wasm core; run build:wasm first')

await build({
  entryPoints: [workerEntry],
  outfile: bundledWorker,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  legalComments: 'none',
  sourcemap: false,
  logLevel: 'silent'
})

renameSync(bundledWorker, workerEntry)
rmSync(staleWorkerMap, { force: true })
validateWorker()

function validateWorker() {
  const source = readFileSync(workerEntry, 'utf8')
  const size = statSync(workerEntry).size
  if (size <= 0) throw new Error('empty bundled voice worker')
  if (size > maxWorkerBytes) throw new Error(`bundled voice worker too large: ${size}`)
  if (/\b(?:import|export)\s+(?:[^'"]+\s+from\s+)?['"]\.\//.test(source) || /\bimport\(\s*['"]\.\//.test(source)) {
    throw new Error('bundled voice worker still contains relative JavaScript imports')
  }
  if (!source.includes('aurora_voice_wasm_bg.wasm')) {
    throw new Error('bundled voice worker lost the generated wasm core reference')
  }
}
