import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

const runtimeTargets = {
  'android-arm64': 'AURORA_LLAMA_CPP_ANDROID_ARM64_LIB_DIR',
  'android-x86_64': 'AURORA_LLAMA_CPP_ANDROID_X86_64_LIB_DIR',
  'ios-simulator-arm64': 'AURORA_LLAMA_CPP_LIB_DIR',
}
const requiredStaticLibraries = [
  'libllama-common.a',
  'libllama-common-base.a',
  'libllama.a',
  'libggml.a',
  'libggml-cpu.a',
  'libggml-base.a',
  'libcpp-httplib.a',
]
const requiredRuntimeFiles = [
  ...requiredStaticLibraries,
  'include/llama.h',
  'include/llama-common/chat.h',
  'include/llama-common/json.h',
]

export function resolveLlamaCppRuntime({
  targets,
  env = process.env,
  repoRoot,
  runCommand = spawnSync,
}) {
  const root = resolve(repoRoot)
  const lock = JSON.parse(readFileSync(join(root, 'tools/local-inference/llama.cpp.lock.json'), 'utf8'))
  const outputRoot = join(root, '.artifacts/local-inference/runtime')
  const resolvedEnv = { ...env }
  const records = []

  for (const target of targets) {
    const envName = runtimeTargets[target]
    if (!envName) throw new Error(`Unsupported pinned llama.cpp runtime target ${target}`)

    const targetSpecific = env[envName]
    const generic = target.startsWith('android-') ? env.AURORA_LLAMA_CPP_LIB_DIR : undefined
    let runtimePath = targetSpecific || generic
      ? resolve(targetSpecific ?? generic)
      : join(outputRoot, target)
    let metadata = verifyRuntime(runtimePath, target, lock)

    if (!metadata && targetSpecific) {
      throw new Error(`${envName} does not identify a verified ${target} runtime for the pinned llama.cpp source`)
    }
    if (!metadata && generic) {
      runtimePath = join(outputRoot, target)
      metadata = verifyRuntime(runtimePath, target, lock)
    }
    if (!metadata) {
      const python = existsSync(join(root, '.venv/bin/python'))
        ? { command: join(root, '.venv/bin/python'), prefix: [] }
        : { command: 'uv', prefix: ['run', '--no-sync', 'python'] }
      const result = runCommand(
        python.command,
        [...python.prefix, join(root, 'tools/local-inference/build_llama_native.py'), '--target', target],
        { cwd: root, env, stdio: 'inherit' },
      )
      if (result.error) throw result.error
      if (result.status !== 0) throw new Error(`Pinned llama.cpp runtime build failed for ${target}`)
      runtimePath = join(outputRoot, target)
      metadata = verifyRuntime(runtimePath, target, lock)
      if (!metadata) throw new Error(`Pinned llama.cpp builder did not produce a verified ${target} runtime`)
    }

    resolvedEnv[envName] = runtimePath
    records.push({
      target,
      version: metadata.source.version,
      sourceCommit: metadata.source.commit,
      linkKind: metadata.link_kind,
      staticLibraries: metadata.static_libraries,
    })
  }

  return { env: resolvedEnv, records }
}

function verifyRuntime(runtimePath, target, lock) {
  let metadata
  try {
    const stat = lstatSync(runtimePath)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null
    metadata = JSON.parse(readFileSync(join(runtimePath, 'aurora-llama-runtime.json'), 'utf8'))
  } catch {
    return null
  }

  if (
    metadata.format !== 1
    || metadata.link_kind !== 'static'
    || metadata.target !== target
    || metadata.source?.commit !== lock.source.commit
    || metadata.source?.version !== lock.source.version
    || metadata.source?.archive_sha256 !== lock.source.archive_sha256
    || metadata.source?.archive_bytes !== lock.source.archive_bytes
    || !Array.isArray(metadata.static_libraries)
    || !Array.isArray(metadata.include_dirs)
    || requiredStaticLibraries.some((name) => !metadata.static_libraries.includes(name))
    || ['include', 'include/llama-common', 'include/vendor'].some((name) => !metadata.include_dirs.includes(name))
    || !metadata.file_sha256
    || typeof metadata.file_sha256 !== 'object'
    || requiredRuntimeFiles.some((name) => !Object.hasOwn(metadata.file_sha256, name))
  ) return null

  for (const [relativePath, expectedHash] of Object.entries(metadata.file_sha256)) {
    if (
      typeof expectedHash !== 'string'
      || !/^[0-9a-f]{64}$/.test(expectedHash)
      || relativePath.startsWith('/')
      || relativePath.split(/[\\/]/).some((part) => part === '' || part === '.' || part === '..')
    ) return null
    const candidate = resolve(runtimePath, relativePath)
    if (!candidate.startsWith(`${resolve(runtimePath)}${sep}`)) return null
    try {
      let current = resolve(runtimePath)
      for (const part of relativePath.split(/[\\/]/)) {
        current = join(current, part)
        const stat = lstatSync(current)
        if (stat.isSymbolicLink()) return null
      }
      if (!lstatSync(candidate).isFile()) return null
      const bytes = readFileSync(candidate)
      if (requiredStaticLibraries.includes(relativePath) && !bytes.subarray(0, 8).equals(Buffer.from('!<arch>\n'))) return null
      const actualHash = createHash('sha256').update(bytes).digest('hex')
      if (actualHash !== expectedHash) return null
    } catch {
      return null
    }
  }
  for (const relativePath of metadata.include_dirs) {
    try {
      const directory = resolve(runtimePath, relativePath)
      if (!directory.startsWith(`${resolve(runtimePath)}${sep}`)) return null
      if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) return null
    } catch {
      return null
    }
  }
  return Object.keys(metadata.file_sha256).length > 0 ? metadata : null
}
