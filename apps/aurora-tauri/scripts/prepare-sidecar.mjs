import { copyFileSync, chmodSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const packageRoot = resolve(dirname(new URL(import.meta.url).pathname), '..')
const srcTauriRoot = join(packageRoot, 'src-tauri')
const binaryStem = 'aurora-sidecar'
const source = process.env.AURORA_TAURI_SIDECAR_SOURCE
const targetTriple = process.env.AURORA_TAURI_TARGET_TRIPLE ?? detectHostTriple()
const extension = process.platform === 'win32' ? '.exe' : ''
const outputDir = join(srcTauriRoot, 'binaries')
const outputPath = join(outputDir, `${binaryStem}-${targetTriple}${extension}`)

if (!source) {
  throw new Error(
    'AURORA_TAURI_SIDECAR_SOURCE must point to a prebuilt Aurora sidecar executable before running a Tauri bundle build.'
  )
}

const sourcePath = resolve(source)
if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
  throw new Error(`AURORA_TAURI_SIDECAR_SOURCE is not a file: ${sourcePath}`)
}

mkdirSync(outputDir, { recursive: true })
copyFileSync(sourcePath, outputPath)
if (process.platform !== 'win32') {
  chmodSync(outputPath, 0o755)
}

console.log(`Prepared ${basename(outputPath)} from ${sourcePath}`)

function detectHostTriple() {
  try {
    return execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).trim()
  } catch {
    const verbose = execFileSync('rustc', ['-Vv'], { encoding: 'utf8' })
    const host = verbose
      .split(/\r?\n/)
      .find((line) => line.startsWith('host:'))
      ?.replace('host:', '')
      .trim()
    if (host) return host
    throw new Error('Unable to detect Rust host target triple for Tauri sidecar naming.')
  }
}
