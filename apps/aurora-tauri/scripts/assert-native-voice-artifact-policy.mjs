#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(packageRoot, '..', '..')

const args = process.argv.slice(2)
const artifactRoot = resolve(
  readOption('--root')
    ?? process.env.AURORA_NATIVE_VOICE_ARTIFACT_ROOT
    ?? join(packageRoot, 'src-tauri', 'target', 'release', 'bundle'),
)
const reportPath = resolve(
  readOption('--report')
    ?? process.env.AURORA_NATIVE_VOICE_ARTIFACT_POLICY_REPORT_PATH
    ?? join(packageRoot, 'reports', 'native-voice-artifact-policy.json'),
)
const allowMissingRoot = args.includes('--allow-missing-root')

const MAX_ARCHIVE_DEPTH = 3
const MAX_ARCHIVE_ENTRIES = 20_000
const MAX_ARCHIVE_EXPANDED_BYTES = 128 * 1024 * 1024
const MAX_TEXT_BYTES = 2_000_000

const approvedNativeVoiceLibraryPatterns = [
  /(^|[/\\])libaurora[_-](native[_-])?voice[^/\\]*\.(so|dylib)$/i,
  /(^|[/\\])aurora[_-](native[_-])?voice[^/\\]*\.dll$/i,
  /(^|[/\\])libaurora[_-]voice[_-]runtime[^/\\]*\.(so|dylib)$/i,
  /(^|[/\\])aurora[_-]voice[_-]runtime[^/\\]*\.dll$/i,
]

const forbiddenPathPatterns = [
  { id: 'python-sidecar', pattern: /aurora-sidecar|prepare-sidecar|gateway-sidecar|bundled[-_]?gateway/i },
  { id: 'python-runtime', pattern: /(^|[/\\])python(\d+(\.\d+)?)?(\.exe)?$|libpython[^/\\]*\.(so|dylib|dll)|pyvenv\.cfg|site-packages|__pycache__|(^|[/\\])\.venv([/\\]|$)|(^|[/\\])venv([/\\]|$)|(^|[/\\])uv(\.exe)?$/i },
  { id: 'python-source', pattern: /(^|[/\\])main\.py$|(^|[/\\])app[/\\]services[/\\]config|config_defaults\.json/i },
  { id: 'speech-model-asset', pattern: /(^|[/\\])(kws|vad|stt|tts|speech|voice|pockettts|sherpa|whisper|tokenizer|tokens|voices?|models?|packs?)([/\\]|$).*\.(onnx|ort|bin|gguf|ggml|tflite|safetensors|pt|pth|ckpt|wav|flac|opus|json)$/i },
  { id: 'speech-model-file', pattern: /(^|[/\\]).*(kws|vad|stt|tts|speech|voice|pockettts|sherpa|whisper|tokenizer|tokens).*\.(onnx|ort|bin|gguf|ggml|tflite|safetensors|pt|pth|ckpt|wav|flac|opus|json)$/i },
  { id: 'browser-wasm-voice-runtime', pattern: /(^|[/\\]).*(voice|speech|local-speech|audio-worklet|audioworklet|wakeword).*\.(wasm|worker\.js|worklet\.js|mjs|js)$/i },
  { id: 'unapproved-pack', pattern: /pockettts|raven|non[-_ ]?commercial|cc[-_ ]?by[-_ ]?nc|creative[-_ ]commons[-_ ]?non[-_ ]?commercial/i },
  { id: 'secret-file', pattern: /(^|[/\\])(\.env(\..*)?|id_rsa|id_ed25519|credentials?\.json|service[-_]?account.*\.json|.*private[-_]?key.*\.(pem|key|json)|.*secret.*\.(json|txt|env))$/i },
]

const forbiddenTextPatterns = [
  { id: 'python-sidecar-text', pattern: /aurora-sidecar|prepare-sidecar|app\/services\/config\/config_defaults\.json|libpython|site-packages|\.venv|bundled[-_]?gateway/i },
  { id: 'browser-wasm-voice-text', pattern: /local-speech|voice[-_ ]?worker|audio[-_ ]?worklet|speech[-_ ]?wasm|wakeword[-_ ]?wasm/i },
  { id: 'unapproved-pack-text', pattern: /pockettts|raven|non[-_ ]?commercial|noncommercial|cc[-_ ]?by[-_ ]?nc|creative commons attribution-noncommercial/i },
  { id: 'private-key-text', pattern: /-----BEGIN (RSA |OPENSSH |EC |DSA |)?PRIVATE KEY-----/ },
  { id: 'api-secret-text', pattern: /\b(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|GOOGLE_APPLICATION_CREDENTIALS|OPENAI_API_KEY|ANTHROPIC_API_KEY|STRIPE_SECRET_KEY)\s*[:=]\s*['"]?[^'"\s]{12,}/i },
  { id: 'token-text', pattern: /\b(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/ },
]

const zipLikeExtensions = new Set(['.zip', '.apk', '.aab', '.ipa'])
const recognizedInstallerExtensions = new Set(['.deb', '.rpm', '.AppImage', '.dmg', '.msi'])
const textExtensions = new Set([
  '.json',
  '.toml',
  '.desktop',
  '.service',
  '.sh',
  '.txt',
  '.plist',
  '.xml',
  '.yml',
  '.yaml',
  '.js',
  '.mjs',
  '.cjs',
  '.html',
])

const failures = []
const report = {
  bundleMode: 'native-voice-desktop-client',
  artifactRoot: redacted(artifactRoot),
  allowMissingRoot,
  checkedFiles: 0,
  checkedArchives: 0,
  checkedArchiveEntries: 0,
  checkedInstallers: 0,
  checkedSymlinks: 0,
  extractedBytes: 0,
  approvedNativeVoiceLibraries: [],
  forbiddenMatches: [],
  secretsRedacted: true,
}

checkArtifactRoot()

report.approvedNativeVoiceLibraries.sort()
report.forbiddenMatches.sort((a, b) => `${a.id}:${a.location}`.localeCompare(`${b.id}:${b.location}`))

mkdirSync(dirname(reportPath), { recursive: true })
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)

if (failures.length) {
  console.error(`Native voice artifact policy failed. Wrote ${redacted(reportPath)}`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log(`Native voice artifact policy passed. Wrote ${redacted(reportPath)}`)

function readOption(name) {
  const index = args.indexOf(name)
  return index === -1 ? null : args[index + 1]
}

function checkArtifactRoot() {
  if (!existsSync(artifactRoot)) {
    if (allowMissingRoot) {
      report.artifactRootMissing = true
      return
    }
    addFailure('missing-artifact-root', redacted(artifactRoot), 'artifact root is missing')
    return
  }

  scanFilesystemPath(artifactRoot, '')
}

function scanFilesystemPath(path, rel, archiveDepth = 0) {
  const stat = lstatSync(path)
  const normalizedRel = normalizePath(rel)
  const location = normalizedRel ? `file:${normalizedRel}` : 'file:.'

  if (stat.isSymbolicLink()) {
    report.checkedSymlinks += 1
    let target = '<unreadable>'
    try {
      target = normalizePath(readlinkSync(path))
    } catch {}
    if (normalizedRel) checkPath(normalizedRel, location)
    if (target !== '<unreadable>' && isContainedSymlink(artifactRoot, path, target)) return
    checkPath(target, `${location}->${redacted(target)}`)
    addFailure('symlink-unsupported', location, `symbolic links are not allowed in release artifacts; target=${redacted(target)}`)
    return
  }

  if (stat.isDirectory()) {
    if (normalizedRel) checkPath(normalizedRel, location)
    for (const child of readdirSync(path).sort()) {
      scanFilesystemPath(join(path, child), normalizedRel ? `${normalizedRel}/${child}` : child, archiveDepth)
    }
    return
  }

  if (!stat.isFile()) return

  report.checkedFiles += 1
  checkPath(normalizedRel, location)
  recordApprovedNativeVoiceLibrary(normalizedRel)
  inspectRecognizedContainer(path, normalizedRel, archiveDepth)
  if (shouldScanText(path)) checkText(readFileSync(path), location)
}

function inspectRecognizedContainer(path, rel, archiveDepth) {
  const extension = installerExtension(path)
  if (zipLikeExtensions.has(extension)) {
    inspectZipLikeArchive(readFileSync(path), `archive:${rel}`, archiveDepth)
    return
  }
  if (extension === '.deb') {
    inspectDebInstaller(path, rel)
    return
  }
  if (extension === '.AppImage') {
    inspectAppImage(path, rel)
    return
  }
  if (extension === '.rpm') {
    addFailure('installer-inspection-unavailable', `installer:${rel}`, 'RPM inspection requires rpm2cpio and cpio; unavailable in the Node-core scanner path')
    return
  }
  if (['.dmg', '.msi', '.exe'].includes(extension)) {
    addFailure('installer-inspection-unsupported', `installer:${rel}`, `${extension} installer inspection is not available on this host; do not treat this artifact as policy-cleared`)
  }
}

function inspectDebInstaller(path, rel) {
  const extractDir = mkdtempSync(join(tmpdir(), 'aurora-native-voice-deb-'))
  try {
    execFileSync('dpkg-deb', ['-x', path, extractDir], { encoding: 'utf8', timeout: 120_000 })
    report.checkedInstallers += 1
    scanExtractedTree(extractDir, `deb:${rel}`)
  } catch (error) {
    addFailure('installer-inspection', `installer:${rel}`, `failed to extract DEB installer: ${errorMessage(error)}`)
  } finally {
    rmSync(extractDir, { recursive: true, force: true })
  }
}

function inspectAppImage(path, rel) {
  const extractDir = mkdtempSync(join(tmpdir(), 'aurora-native-voice-appimage-'))
  try {
    execFileSync(path, ['--appimage-extract'], { cwd: extractDir, encoding: 'utf8', timeout: 120_000 })
    const root = join(extractDir, 'squashfs-root')
    if (!existsSync(root)) throw new Error('AppImage extraction did not create squashfs-root')
    report.checkedInstallers += 1
    scanExtractedTree(root, `appimage:${rel}`, artifactRoot)
  } catch (error) {
    addFailure('installer-inspection', `installer:${rel}`, `failed to extract AppImage installer: ${errorMessage(error)}`)
  } finally {
    rmSync(extractDir, { recursive: true, force: true })
  }
}

function scanExtractedTree(root, prefix, externalRoot = null) {
  for (const extracted of walkFilesystem(root)) {
    const rel = normalizePath(relative(root, extracted))
    const stat = lstatSync(extracted)
    const location = `${prefix}:${rel}`
    if (stat.isSymbolicLink()) {
      report.checkedSymlinks += 1
      let target = '<unreadable>'
      try {
        target = normalizePath(readlinkSync(extracted))
      } catch {}
      checkPath(rel, location)
      if (target !== '<unreadable>' && isContainedSymlink(root, extracted, target, externalRoot)) continue
      checkPath(target, `${location}->${redacted(target)}`)
      addFailure('symlink-unsupported', location, `symbolic links are not allowed in release artifacts; target=${redacted(target)}`)
      continue
    }
    if (!stat.isFile()) continue
    report.checkedFiles += 1
    checkPath(rel, location)
    recordApprovedNativeVoiceLibrary(rel)
    inspectRecognizedContainer(extracted, `${prefix}/${rel}`, 0)
    if (shouldScanText(extracted)) checkText(readFileSync(extracted), location)
  }
}

function isContainedSymlink(root, linkPath, target, externalRoot = null) {
  if (!target || target.startsWith('<') || target.includes('\0')) return false
  const resolvedTarget = resolve(dirname(linkPath), target)
  return [root, externalRoot]
    .filter(Boolean)
    .some((candidateRoot) => {
      const relativeTarget = relative(resolve(candidateRoot), resolvedTarget)
      return relativeTarget === ''
        || (!relativeTarget.startsWith('..') && !relativeTarget.startsWith('/') && !relativeTarget.match(/^[A-Za-z]:[/\\]/))
    })
}

function inspectZipLikeArchive(buffer, label, depth) {
  if (depth >= MAX_ARCHIVE_DEPTH) {
    addFailure('archive-depth-limit', label, `nested archive depth exceeds ${MAX_ARCHIVE_DEPTH}`)
    return
  }

  let entries
  try {
    entries = parseZipCentralDirectory(buffer)
  } catch (error) {
    addFailure('archive-inspection', label, `failed to inspect archive: ${errorMessage(error)}`)
    return
  }

  if (report.checkedArchiveEntries + entries.length > MAX_ARCHIVE_ENTRIES) {
    addFailure('archive-entry-limit', label, `nested archives exceed global entry limit ${MAX_ARCHIVE_ENTRIES}`)
    return
  }

  report.checkedArchives += 1
  report.checkedArchiveEntries += entries.length
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const normalized = normalizePath(entry.name)
    const location = `${label}:${normalized}`
    validateArchiveEntryPath(normalized, location)
    checkPath(normalized, location)
    recordApprovedNativeVoiceLibrary(normalized)
    if (normalized.endsWith('/')) continue
    try {
      const content = readZipEntryContent(buffer, entry, location)
      if (!content) continue
      report.extractedBytes += content.length
      if (report.extractedBytes > MAX_ARCHIVE_EXPANDED_BYTES) {
        addFailure('archive-expanded-size-limit', label, `expanded archive bytes exceed ${MAX_ARCHIVE_EXPANDED_BYTES}`)
        return
      }
      if (isTextEntry(normalized)) checkText(content, location)
      if (zipLikeExtensions.has(extname(normalized).toLowerCase())) {
        inspectZipLikeArchive(content, location, depth + 1)
      }
    } catch (error) {
      addFailure('archive-inspection', location, `failed to inspect ZIP entry: ${errorMessage(error)}`)
    }
  }
}

function checkPath(value, location) {
  for (const { id, pattern } of forbiddenPathPatterns) {
    if (pattern.test(value)) addFailure(id, location, `matched forbidden path pattern ${pattern}`)
  }
}

function checkText(input, location) {
  const textBuffer = Buffer.isBuffer(input) ? input : readFileSync(input)
  if (textBuffer.length > MAX_TEXT_BYTES) return
  let text
  try {
    text = textBuffer.toString('utf8')
  } catch {
    return
  }
  for (const { id, pattern } of forbiddenTextPatterns) {
    if (pattern.test(text)) addFailure(id, location, `matched forbidden text pattern ${pattern}`)
  }
}

function recordApprovedNativeVoiceLibrary(value) {
  if (approvedNativeVoiceLibraryPatterns.some((pattern) => pattern.test(value))) {
    report.approvedNativeVoiceLibraries.push(value)
  }
}

function shouldScanText(path) {
  return textExtensions.has(extname(path).toLowerCase()) || basename(path).startsWith('.env')
}

function isTextEntry(path) {
  return textExtensions.has(extname(path).toLowerCase()) || basename(path).startsWith('.env')
}

function addFailure(id, location, message) {
  const failure = { id, location: sanitizeMessage(location), message: sanitizeMessage(message) }
  report.forbiddenMatches.push(failure)
  failures.push(`${id}: ${failure.location} ${failure.message}`)
}

function* walkFilesystem(root) {
  const stack = [root]
  while (stack.length) {
    const current = stack.pop()
    const stat = lstatSync(current)
    if (stat.isDirectory()) {
      for (const child of readdirSync(current).sort().reverse()) {
        stack.push(join(current, child))
      }
    }
    yield current
  }
}

function parseZipCentralDirectory(buffer) {
  const eocdOffset = findEndOfCentralDirectory(buffer)
  if (eocdOffset === -1) throw new Error('ZIP end of central directory not found')
  ensureReadable(buffer, eocdOffset, 22, 'ZIP end of central directory')
  const entryCount = buffer.readUInt16LE(eocdOffset + 10)
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16)
  const entries = []
  let offset = centralDirectoryOffset
  for (let index = 0; index < entryCount; index += 1) {
    ensureReadable(buffer, offset, 46, `ZIP central directory header ${index}`)
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`invalid ZIP central directory header at ${offset}`)
    }
    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localHeaderOffset = buffer.readUInt32LE(offset + 42)
    const nameStart = offset + 46
    const nameEnd = nameStart + nameLength
    ensureReadable(buffer, nameStart, nameLength + extraLength + commentLength, `ZIP central directory entry ${index}`)
    entries.push({
      name: buffer.subarray(nameStart, nameEnd).toString('utf8'),
      flags,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    })
    offset = nameEnd + extraLength + commentLength
  }
  return entries
}

function readZipEntryContent(buffer, entry, location) {
  if ((entry.flags & 0x0001) !== 0) {
    addFailure('archive-entry-encrypted', location, 'encrypted ZIP entries are unsupported')
    return null
  }
  if (![0, 8].includes(entry.method)) {
    addFailure('archive-entry-compression', location, `unsupported ZIP compression method ${entry.method}`)
    return null
  }
  if (entry.uncompressedSize > MAX_ARCHIVE_EXPANDED_BYTES) {
    addFailure('archive-entry-size-limit', location, `entry expands to ${entry.uncompressedSize} bytes; limit is ${MAX_ARCHIVE_EXPANDED_BYTES}`)
    return null
  }
  const localOffset = entry.localHeaderOffset
  ensureReadable(buffer, localOffset, 30, `${location} local header`)
  if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
    addFailure('archive-inspection', location, 'invalid ZIP local header')
    return null
  }
  const nameLength = buffer.readUInt16LE(localOffset + 26)
  const extraLength = buffer.readUInt16LE(localOffset + 28)
  const dataStart = localOffset + 30 + nameLength + extraLength
  const dataEnd = dataStart + entry.compressedSize
  ensureReadable(buffer, localOffset + 30, nameLength + extraLength, `${location} local name/extra`)
  if (dataEnd > buffer.length) {
    addFailure('archive-inspection', location, 'ZIP entry data exceeds archive bounds')
    return null
  }
  const data = buffer.subarray(dataStart, dataEnd)
  try {
    return entry.method === 0
      ? Buffer.from(data)
      : inflateRawSync(data, {
        maxOutputLength: Math.min(entry.uncompressedSize, MAX_ARCHIVE_EXPANDED_BYTES),
      })
  } catch (error) {
    addFailure('archive-entry-decode', location, `failed to decode ZIP entry: ${errorMessage(error)}`)
    return null
  }
}

function findEndOfCentralDirectory(buffer) {
  const minOffset = Math.max(0, buffer.length - 65_557)
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset
  }
  return -1
}

function normalizePath(value) {
  return value.replaceAll('\\', '/')
}

function validateArchiveEntryPath(value, location) {
  if (
    value.includes('\0')
    || value.startsWith('/')
    || /^[A-Za-z]:\//.test(value)
    || value.split('/').includes('..')
  ) {
    addFailure('archive-entry-path', location, 'archive entry path is absolute, parent-relative, or contains NUL')
  }
}

function ensureReadable(buffer, offset, length, label) {
  if (
    !Number.isSafeInteger(offset)
    || !Number.isSafeInteger(length)
    || offset < 0
    || length < 0
    || offset + length > buffer.length
  ) {
    throw new Error(`${label} exceeds archive bounds`)
  }
}

function installerExtension(path) {
  if (/\.AppImage$/i.test(path)) return '.AppImage'
  if (/(\bsetup\b|\binstall(er)?\b|nsis).*\.exe$/i.test(path)) return '.exe'
  const extension = extname(path).toLowerCase()
  if (recognizedInstallerExtensions.has(extension)) return extension
  return extension
}

function redacted(path) {
  return sanitizeMessage(path)
}

function errorMessage(error) {
  return sanitizeMessage(String(error?.message ?? error))
}

function sanitizeMessage(value) {
  let sanitized = String(value)
    .replaceAll(repoRoot, '<repo-root>')
    .replaceAll(tmpdir(), '<tmp>')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g, '<redacted-token>')
    .replace(/\b(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|GOOGLE_APPLICATION_CREDENTIALS|OPENAI_API_KEY|ANTHROPIC_API_KEY|STRIPE_SECRET_KEY)\s*[:=]\s*['"]?[^'"\s]+/gi, '$1=<redacted>')
  if (process.env.HOME) sanitized = sanitized.replaceAll(process.env.HOME, '<home>')
  return sanitized
}
