import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const packageRoot = resolve(dirname(new URL(import.meta.url).pathname), '..')
const repoRoot = resolve(packageRoot, '..', '..')
const srcTauriRoot = join(packageRoot, 'src-tauri')
const thinConfigPath = resolve(process.env.AURORA_TAURI_THIN_CONFIG_PATH ?? join(srcTauriRoot, 'tauri.thin.conf.json'))
const packageJsonPath = join(packageRoot, 'package.json')
const reportPath = resolve(process.env.AURORA_TAURI_THIN_PROOF_REPORT_PATH ?? join(packageRoot, 'reports', 'desktop-thin-bundle-proof.json'))
const reportDir = dirname(reportPath)

const args = new Set(process.argv.slice(2))
const allowMissingBundle = args.has('--allow-missing-bundle')
const bundleDir = resolve(process.env.AURORA_TAURI_THIN_BUNDLE_DIR ?? join(srcTauriRoot, 'target', 'release', 'bundle'))

const forbiddenPathPatterns = [
  /aurora-sidecar/i,
  /prepare-sidecar/i,
  /config_defaults\.json/i,
  /(^|[/\\])app[/\\]services[/\\]config/i,
  /(^|[/\\])python(\d+(\.\d+)?)?(\.exe)?$/i,
  /libpython[^/\\]*\.(so|dylib|dll)/i,
  /pyvenv\.cfg/i,
  /site-packages/i,
  /__pycache__/i,
  /(^|[/\\])main\.py$/i
]

const forbiddenTextPatterns = [
  /aurora-sidecar/i,
  /prepare-sidecar/i,
  /app\/services\/config\/config_defaults\.json/i,
  /libpython/i,
  /site-packages/i
]

const failures = []
const proof = {
  generatedAt: new Date().toISOString(),
  bundleMode: 'desktop-thin',
  thinConfigPath: redacted(thinConfigPath),
  bundleDir: redacted(bundleDir),
  allowMissingBundle,
  checkedFiles: 0,
  checkedArchives: 0,
  archivesFound: 0,
  forbiddenMatches: [],
  secretsRedacted: true
}

checkPackageScripts()
checkThinConfig()
checkBundleDir()

mkdirSync(reportDir, { recursive: true })
writeFileSync(reportPath, `${JSON.stringify(proof, null, 2)}\n`)

if (failures.length) {
  console.error(`Desktop-thin bundle proof failed. Wrote ${reportPath}`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log(`Desktop-thin bundle proof passed. Wrote ${reportPath}`)

function checkPackageScripts() {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  const scripts = packageJson.scripts ?? {}
  const script = scripts['build:bundle:desktop-thin'] ?? ''
  if (!script) failures.push('package.json is missing build:bundle:desktop-thin')
  if (/prepare-sidecar/.test(script)) failures.push('build:bundle:desktop-thin must not call prepare-sidecar')
  if (!/tauri\.thin\.conf\.json/.test(script)) failures.push('build:bundle:desktop-thin must use src-tauri/tauri.thin.conf.json')
  for (const [name, value] of Object.entries(scripts)) {
    if (name.endsWith(':thin') && /prepare-sidecar|python/i.test(value)) {
      failures.push(`${name} must remain Python-free and must not call prepare-sidecar`)
    }
  }
  proof.desktopThinScript = script
}

function checkThinConfig() {
  if (!existsSync(thinConfigPath)) {
    failures.push('src-tauri/tauri.thin.conf.json is missing; run prepare:bundle:desktop-thin')
    return
  }
  const raw = readFileSync(thinConfigPath, 'utf8')
  const config = JSON.parse(raw)
  const externalBin = config.bundle?.externalBin ?? []
  const resources = config.bundle?.resources ?? {}
  if (!Array.isArray(externalBin) || externalBin.length !== 0) failures.push('desktop-thin config must have bundle.externalBin: []')
  if (Array.isArray(resources) ? resources.length !== 0 : Object.keys(resources).length !== 0) {
    failures.push('desktop-thin config must have empty bundle.resources')
  }
  if (/binaries\/aurora-sidecar|config_defaults\.json|app\/services\/config/.test(raw)) {
    failures.push('desktop-thin config contains sidecar/config resource references')
  }
  const csp = config.app?.security?.csp ?? ''
  checkRuntimeConfigurableConnectSrc(csp)
  const capabilities = config.app?.security?.capabilities ?? []
  if (!Array.isArray(capabilities) || capabilities.length !== 1 || capabilities[0] !== 'aurora-thin') {
    failures.push('desktop-thin config must replace base capabilities with aurora-thin only')
  }
  checkThinCapabilityFile()
  proof.csp = csp
  proof.capabilities = capabilities
  proof.configExternalBin = externalBin
  proof.configResources = resources
}

function checkThinCapabilityFile() {
  const capabilityPath = join(srcTauriRoot, 'capabilities', 'aurora-thin.json')
  if (!existsSync(capabilityPath)) {
    failures.push('desktop-thin capability file is missing: capabilities/aurora-thin.json')
    return
  }
  const capability = JSON.parse(readFileSync(capabilityPath, 'utf8'))
  const permissions = capability.permissions ?? []
  const forbidden = permissions.filter((permission) => /sidecar|aurora-request|aurora-subscribe|local-file|audio-bridge/i.test(permission))
  if (forbidden.length) failures.push(`desktop-thin capability includes forbidden local/sidecar permissions: ${forbidden.join(', ')}`)
  proof.thinCapabilityPermissions = permissions
}

function checkBundleDir() {
  if (!existsSync(bundleDir)) {
    if (allowMissingBundle) {
      proof.bundleDirMissing = true
      return
    }
    failures.push(`bundle directory is missing: ${bundleDir}`)
    return
  }

  for (const file of walk(bundleDir)) {
    proof.checkedFiles += 1
    const rel = relative(bundleDir, file)
    checkName(rel, `bundle:${rel}`)
    if (extname(file) === '.deb') {
      proof.archivesFound += 1
      inspectDeb(file)
    }
    if (extname(file) === '.AppImage') {
      proof.archivesFound += 1
      inspectAppImage(file)
    }
    if (shouldScanText(file)) checkText(file, `bundle:${rel}`)
  }
  if (proof.archivesFound > 0 && proof.checkedArchives === 0) {
    failures.push('desktop-thin bundle archives exist, but none were successfully inspected')
  }
}

function inspectDeb(path) {
  try {
    const output = execFileSync('dpkg-deb', ['--contents', path], { encoding: 'utf8' })
    proof.checkedArchives += 1
    for (const line of output.split(/\r?\n/)) checkName(line, `deb:${relative(bundleDir, path)}`)
  } catch (error) {
    const message = String(error?.message ?? error)
    proof.debInspectionFailure = message
    failures.push(`failed to inspect deb archive ${relative(bundleDir, path)}: ${message}`)
  }
}

function inspectAppImage(path) {
  const extractDir = mkdtempSync(join(tmpdir(), 'aurora-thin-appimage-'))
  try {
    execFileSync(path, ['--appimage-extract'], { cwd: extractDir, encoding: 'utf8', timeout: 120_000 })
    proof.checkedArchives += 1
    const root = join(extractDir, 'squashfs-root')
    if (!existsSync(root)) {
      throw new Error('AppImage extraction did not create squashfs-root')
    }
    for (const file of walk(root)) {
      const rel = relative(root, file)
      checkName(rel, `appimage:${relative(bundleDir, path)}`)
      if (shouldScanText(file)) checkText(file, `appimage:${relative(bundleDir, path)}:${rel}`)
    }
  } catch (error) {
    const message = String(error?.message ?? error)
    proof.appImageInspectionFailure = message
    failures.push(`failed to inspect AppImage archive ${relative(bundleDir, path)}: ${message}`)
  } finally {
    rmSync(extractDir, { recursive: true, force: true })
  }
}

function checkRuntimeConfigurableConnectSrc(csp) {
  const directive = csp
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith('connect-src '))
  if (!directive) {
    failures.push('desktop-thin CSP must define connect-src')
    return
  }
  const sources = directive.split(/\s+/).slice(1)
  const expected = new Set(["'self'", 'http:', 'https:', 'ws:', 'wss:'])
  for (const source of expected) {
    if (!sources.includes(source)) {
      failures.push(`desktop-thin CSP connect-src must include runtime-configurable source ${source}`)
    }
  }
  for (const source of sources) {
    if (expected.has(source)) continue
    failures.push(`desktop-thin CSP connect-src must not compile endpoint-specific source ${source}`)
  }
}

function checkName(value, label) {
  for (const pattern of forbiddenPathPatterns) {
    if (pattern.test(value)) addForbidden(`${label} matched forbidden path pattern ${pattern}`)
  }
}

function checkText(path, label) {
  const stat = statSync(path)
  if (stat.size > 2_000_000) return
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return
  }
  for (const pattern of forbiddenTextPatterns) {
    if (pattern.test(text)) addForbidden(`${label} matched forbidden text pattern ${pattern}`)
  }
}

function shouldScanText(path) {
  return ['.json', '.toml', '.desktop', '.service', '.sh', '.txt', '.plist', '.xml', '.yml', '.yaml'].includes(extname(path))
}

function addForbidden(message) {
  proof.forbiddenMatches.push(message)
  failures.push(message)
}

function* walk(root) {
  const stack = [root]
  while (stack.length) {
    const current = stack.pop()
    const stat = lstatSync(current)
    if (stat.isSymbolicLink()) continue
    if (stat.isDirectory()) {
      for (const child of readdirSync(current)) stack.push(join(current, child))
    } else if (stat.isFile()) {
      yield current
    }
  }
}

function redacted(path) {
  return path.replace(repoRoot, '<repo-root>')
}
