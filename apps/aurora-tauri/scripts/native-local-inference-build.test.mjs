import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { resolveLlamaCppRuntime } from './native-local-inference-build.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const lock = JSON.parse(readFileSync(join(repoRoot, 'tools/local-inference/llama.cpp.lock.json'), 'utf8'))
const libraries = [
  'libllama-common.a',
  'libllama-common-base.a',
  'libllama.a',
  'libggml.a',
  'libggml-cpu.a',
  'libggml-base.a',
  'libcpp-httplib.a',
]

test('reuses only a matching target cache and honors an explicit verified runtime', (t) => {
  const root = makeRepo(t)
  const cached = writeRuntime(root, 'android-arm64')
  let calls = 0

  const result = resolveLlamaCppRuntime({
    repoRoot: root,
    targets: ['android-arm64'],
    env: { AURORA_LLAMA_CPP_ANDROID_ARM64_LIB_DIR: cached },
    runCommand: () => { calls += 1; return { status: 0 } },
  })

  assert.equal(calls, 0)
  assert.equal(result.env.AURORA_LLAMA_CPP_ANDROID_ARM64_LIB_DIR, cached)
  assert.deepEqual(result.records.map(({ target }) => target), ['android-arm64'])
})

test('builds a missing pinned target using the repository interpreter and target ABI env', (t) => {
  const root = makeRepo(t)
  const commandCalls = []
  const result = resolveLlamaCppRuntime({
    repoRoot: root,
    targets: ['android-x86_64'],
    env: { ANDROID_NDK_HOME: '/ndk' },
    runCommand: (command, args, options) => {
      commandCalls.push({ command, args, cwd: options.cwd, ndk: options.env.ANDROID_NDK_HOME })
      writeRuntime(root, 'android-x86_64')
      return { status: 0 }
    },
  })

  assert.equal(commandCalls.length, 1)
  assert.deepEqual(commandCalls[0].args.slice(-2), ['--target', 'android-x86_64'])
  assert.equal(commandCalls[0].ndk, '/ndk')
  assert.match(commandCalls[0].command, /(?:\.venv\/bin\/python|uv)$/)
  assert.equal(result.env.AURORA_LLAMA_CPP_ANDROID_X86_64_LIB_DIR, join(root, '.artifacts/local-inference/runtime/android-x86_64'))
})

test('does not reuse a mismatched generic Android cache when the target cache is available', (t) => {
  const root = makeRepo(t)
  const wrongTarget = writeRuntime(root, 'android-x86_64')
  writeRuntime(root, 'android-arm64')
  let calls = 0

  const result = resolveLlamaCppRuntime({
    repoRoot: root,
    targets: ['android-arm64'],
    env: { AURORA_LLAMA_CPP_LIB_DIR: wrongTarget },
    runCommand: () => { calls += 1; return { status: 0 } },
  })
  assert.equal(calls, 0)
  assert.equal(result.env.AURORA_LLAMA_CPP_ANDROID_ARM64_LIB_DIR, join(root, '.artifacts/local-inference/runtime/android-arm64'))
})

test('selects the iOS simulator target and preserves an explicit CI path', (t) => {
  const root = makeRepo(t)
  const explicit = writeRuntime(root, 'ios-simulator-arm64')
  const result = resolveLlamaCppRuntime({
    repoRoot: root,
    targets: ['ios-simulator-arm64'],
    env: { AURORA_LLAMA_CPP_LIB_DIR: explicit, CI: 'true' },
    runCommand: () => { throw new Error('verified explicit CI runtime should be reused') },
  })

  assert.equal(result.env.AURORA_LLAMA_CPP_LIB_DIR, explicit)
  assert.equal(result.records[0].target, 'ios-simulator-arm64')
})

function makeRepo(t) {
  const root = mkdtempSync(join(tmpdir(), 'aurora-llama-runtime-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'tools/local-inference'), { recursive: true })
  writeFileSync(join(root, 'tools/local-inference/llama.cpp.lock.json'), JSON.stringify(lock))
  return root
}

function writeRuntime(root, target) {
  const runtime = join(root, '.artifacts/local-inference/runtime', target)
  mkdirSync(join(runtime, 'include/llama-common'), { recursive: true })
  mkdirSync(join(runtime, 'include/vendor'), { recursive: true })
  const fileSha = {}
  for (const name of libraries) {
    const bytes = Buffer.from('!<arch>\nfixture')
    writeFileSync(join(runtime, name), bytes)
    fileSha[name] = createHash('sha256').update(bytes).digest('hex')
  }
  for (const header of ['include/llama.h', 'include/llama-common/chat.h', 'include/llama-common/json.h', 'include/vendor/json.hpp']) {
    const path = join(runtime, header)
    mkdirSync(join(path, '..'), { recursive: true })
    const bytes = Buffer.from(`fixture:${header}`)
    writeFileSync(path, bytes)
    fileSha[header] = createHash('sha256').update(bytes).digest('hex')
  }
  writeFileSync(join(runtime, 'aurora-llama-runtime.json'), JSON.stringify({
    format: 1,
    link_kind: 'static',
    source: {
      version: lock.source.version,
      commit: lock.source.commit,
      archive_sha256: lock.source.archive_sha256,
      archive_bytes: lock.source.archive_bytes,
    },
    target,
    static_libraries: libraries,
    include_dirs: ['include', 'include/llama-common', 'include/vendor'],
    file_sha256: fileSha,
  }))
  return runtime
}
