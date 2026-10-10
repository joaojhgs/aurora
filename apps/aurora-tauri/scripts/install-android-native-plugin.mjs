import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const genAndroidDir = process.env.AURORA_ANDROID_GENERATED_PROJECT_DIR
  ? resolve(process.env.AURORA_ANDROID_GENERATED_PROJECT_DIR)
  : resolve('src-tauri/gen/android')
const appManifestPath = resolve(genAndroidDir, 'app/src/main/AndroidManifest.xml')
const mainActivityPath = resolve(
  genAndroidDir,
  'app/src/main/java/dev/aurora/desktop/MainActivity.kt',
)
const cargoTomlPath = resolve('src-tauri/Cargo.toml')
const vendorBarcodeScannerAndroidDir = resolve(
  'src-tauri/vendor/tauri-plugin-barcode-scanner/android',
)
const vendorBarcodeScannerDir = resolve('src-tauri/vendor/tauri-plugin-barcode-scanner')
const vendorBarcodeScannerBuildScriptPath = resolve(vendorBarcodeScannerDir, 'build.rs')
const vendorBarcodeScannerSourcePath = resolve(
  vendorBarcodeScannerAndroidDir,
  'src/main/java/BarcodeScannerPlugin.kt',
)
const pluginSourceDir = resolve('src-tauri/android/aurora-native-plugin/src/main/java/dev/aurora/tauri/nativeplugin')
const generatedPluginSourceDir = resolve(genAndroidDir, 'app/src/main/java/dev/aurora/tauri/nativeplugin')
const canonicalPluginBuildGradlePath = resolve(
  'src-tauri/android/aurora-native-plugin/build.gradle.kts',
)
const generatedAppBuildGradlePath = resolve(genAndroidDir, 'app/build.gradle.kts')
const generatedRootBuildGradlePath = resolve(genAndroidDir, 'build.gradle.kts')
const generatedTauriSettingsGradlePath = resolve(genAndroidDir, 'tauri.settings.gradle')
const generatedAndroidKotlinCompatDir = resolve(genAndroidDir, 'aurora-kotlin-compat')
const generatedAndroidKotlinCompatManifestPath = resolve(
  genAndroidDir,
  '.aurora-kotlin-compat-sources.json',
)
const includedAndroidKotlinProjects = [
  'tauri-android',
  'tauri-plugin-barcode-scanner',
  'tauri-plugin-deep-link',
]
const canonicalPluginResourceDir = resolve('src-tauri/android/aurora-native-plugin/src/main/res')
const canonicalAndroidIconDir = resolve('src-tauri/icons/android')
const generatedAndroidResourceDir = resolve(genAndroidDir, 'app/src/main/res')
const generatedBaseStringsPath = join(generatedAndroidResourceDir, 'values', 'strings.xml')
const generatedAndroidJniLibsDir = resolve(genAndroidDir, 'app/src/main/jniLibs')
const androidNativeSpeechTargets = {
  aarch64: {
    abi: 'arm64-v8a',
    libDirEnv: 'AURORA_SHERPA_ONNX_ANDROID_ARM64_V8A_LIB_DIR',
  },
  x86_64: {
    abi: 'x86_64',
    libDirEnv: 'AURORA_SHERPA_ONNX_ANDROID_X86_64_LIB_DIR',
  },
}
const requiredNativeSpeechLibraries = [
  'libonnxruntime.so',
  'libsherpa-onnx-c-api.so',
]
const generatedRustLibrary = 'libaurora_tauri_lib.so'
const sherpaTtsDisabledMarker = Buffer.from(
  'TTS is not enabled. Please rebuild sherpa-onnx',
)
const modes = process.argv.slice(2)
if (modes.length > 1 || (modes.length === 1 && !['--prepare', '--sync-generated-projects'].includes(modes[0]))) {
  throw new Error('Usage: install-android-native-plugin.mjs [--prepare|--sync-generated-projects]')
}
const mode = modes[0] ?? 'full'

if (!existsSync(appManifestPath)) {
  throw new Error('Tauri Android project is missing. Run android:init before installing the Aurora native plugin.')
}

if (mode === '--sync-generated-projects') {
  verifyVendorBarcodeScannerSource()
  syncIncludedAndroidKotlinProjects()
  console.log('Synchronized the three generated Tauri Android Kotlin dependency projects.')
} else {
  syncCanonicalLiteRtDependency()
  syncCanonicalKotlinCompilerPlugin()
  syncCanonicalKotlinCompilerOptions()

  // The Tauri scaffold persists generated sources between runs. Reconcile the
  // whole plugin directory before copying so removed canonical sources cannot
  // remain as stale generated classes and fail the parity preflight.
  rmSync(generatedPluginSourceDir, { recursive: true, force: true })
  mkdirSync(generatedPluginSourceDir, { recursive: true })
  cpSync(pluginSourceDir, generatedPluginSourceDir, { recursive: true })
  syncAuroraAndroidNativeResources()
  syncCanonicalAndroidLauncherIcons()
  verifyVendorBarcodeScannerSource()
  syncNativeSpeechLibraries()

  if (mode !== '--prepare') syncIncludedAndroidKotlinProjects()

  patchFile(appManifestPath, (content) => mergePluginManifest(content))
  if (existsSync(mainActivityPath)) {
    patchFile(mainActivityPath, (content) => addMainActivityImeInsets(content))
  }

  console.log(
    mode === '--prepare'
      ? 'Prepared Aurora Android native plugin scaffold; generated dependency-project synchronization runs after the Tauri Rust build.'
      : 'Installed Aurora Android native plugin source into src-tauri/gen/android.',
  )
}

function syncCanonicalLiteRtDependency() {
  const canonicalBuild = readFileSync(canonicalPluginBuildGradlePath, 'utf8')
  const liteRtCoordinates = [...canonicalBuild.matchAll(
    /^\s*implementation\(\s*["'](com\.google\.ai\.edge\.litertlm:litertlm-android:[^"']+)["']\s*\)\s*$/gm,
  )].map((match) => match[1])
  if (liteRtCoordinates.length !== 1) {
    throw new Error('Canonical Android plugin must declare exactly one pinned LiteRT-LM dependency.')
  }

  const coordinate = liteRtCoordinates[0]
  patchFile(generatedAppBuildGradlePath, (content) => {
    const dependencyLine = /^([ \t]*)(implementation|api|compileOnly|runtimeOnly)\(\s*["'](com\.google\.ai\.edge\.litertlm:litertlm-android:[^"']+)["']\s*\)\s*$/gm
    const existing = [...content.matchAll(dependencyLine)]
    if (existing.length === 1 && existing[0][2] === 'implementation' && existing[0][3] === coordinate) return content

    if (existing.length > 0) {
      let replaced = false
      return content.replace(dependencyLine, (_line, indent) => {
        if (replaced) return ''
        replaced = true
        return `${indent}implementation("${coordinate}")`
      })
    }

    const block = /^([ \t]*dependencies\s*\{\s*\r?\n)([\s\S]*?)(^[ \t]*\})/m
    const match = content.match(block)
    if (!match) {
      throw new Error(`Generated Android app Gradle dependencies are missing: ${generatedAppBuildGradlePath}`)
    }
    const indent = `${match[1].match(/^[ \t]*/)?.[0] ?? ''}    `
    const body = match[2].endsWith('\n') ? match[2] : `${match[2]}\n`
    return content.replace(block, `${match[1]}${body}${indent}implementation("${coordinate}")\n${match[3]}`)
  })
}

function syncCanonicalKotlinCompilerPlugin() {
  const canonicalBuild = readFileSync(canonicalPluginBuildGradlePath, 'utf8')
  const versionPins = [...canonicalBuild.matchAll(
    /^val\s+auroraKotlinGradlePluginVersion\s*=\s*["']([^"']+)["']\s*$/gm,
  )].map((match) => match[1])
  if (versionPins.length !== 1) {
    throw new Error('Canonical Android plugin must declare exactly one Kotlin Gradle plugin version.')
  }

  const version = versionPins[0]
  patchFile(generatedRootBuildGradlePath, (content) => {
    const classpathLine =
      /^([ \t]*)classpath\(["']org\.jetbrains\.kotlin:kotlin-gradle-plugin:([^"']+)["']\)([ \t]*)$/gm
    const existing = [...content.matchAll(classpathLine)]
    if (existing.length !== 1) {
      throw new Error(
        `Generated Android root must declare exactly one Kotlin Gradle plugin classpath: ${generatedRootBuildGradlePath}`,
      )
    }
    if (existing[0][2] === version) return content
    return content.replace(classpathLine, (_line, indent, _previousVersion, trailing) =>
      `${indent}classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:${version}")${trailing}`,
    )
  })
}

function syncCanonicalKotlinCompilerOptions() {
  const canonicalBuild = readFileSync(canonicalPluginBuildGradlePath, 'utf8')
  const jvmTargets = [...canonicalBuild.matchAll(
    /^\s*jvmTarget\.set\(org\.jetbrains\.kotlin\.gradle\.dsl\.JvmTarget\.(JVM_[0-9_]+)\)\s*$/gm,
  )].map((match) => match[1])
  if (jvmTargets.length !== 1 || jvmTargets[0] !== 'JVM_1_8') {
    throw new Error('Canonical Android plugin must declare exactly one Kotlin JVM 1.8 compiler target.')
  }

  const target = jvmTargets[0]
  patchFile(generatedAppBuildGradlePath, (content) => {
    return migrateKotlinCompilerOptions(content, target, generatedAppBuildGradlePath)
  })
}

function migrateKotlinCompilerOptions(content, target, gradlePath) {
  const legacyBlock =
    /^([ \t]*)kotlinOptions\s*\{\s*\r?\n\1[ \t]+jvmTarget\s*=\s*["']1\.8["']\s*\r?\n\1\}[ \t]*$/gm
  const legacyBlocks = [...content.matchAll(legacyBlock)]
  const anyLegacyBlock = [...content.matchAll(/^[ \t]*kotlinOptions\s*\{/gm)]
  if (anyLegacyBlock.length !== legacyBlocks.length || legacyBlocks.length > 1) {
    throw new Error(`Unsupported Kotlin options block in Android project: ${gradlePath}`)
  }

  const typedBlocks = [...content.matchAll(
    /^[ \t]*kotlin\s*\{[ \t]*\r?\n[ \t]+compilerOptions\s*\{[ \t]*\r?\n[ \t]+jvmTarget\.set\(org\.jetbrains\.kotlin\.gradle\.dsl\.JvmTarget\.(JVM_[0-9_]+)\)[ \t]*\r?\n[ \t]+\}[ \t]*\r?\n[ \t]*\}[ \t]*$/gm,
  )]
  const anyKotlinBlocks = [...content.matchAll(/^[ \t]*kotlin\s*\{/gm)]
  if (typedBlocks.length > 1 || anyKotlinBlocks.length !== typedBlocks.length) {
    throw new Error(`Unsupported Kotlin DSL block in Android project: ${gradlePath}`)
  }

  let next = content
  if (legacyBlocks.length === 1) next = next.replace(legacyBlock, '')

  if (typedBlocks.length === 1) {
    if (legacyBlocks.length === 0 && typedBlocks[0][1] === target) return content
    return next.replace(
      typedBlocks[0][0],
      `kotlin {\n    compilerOptions {\n        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.${target})\n    }\n}`,
    )
  }

  if (legacyBlocks.length !== 1) {
    throw new Error(`Android project must contain one legacy or typed Kotlin JVM target: ${gradlePath}`)
  }

  const dependenciesBlock = /^([ \t]*dependencies\s*\{)/m
  if (!dependenciesBlock.test(next)) {
    throw new Error(`Android project dependencies are missing: ${gradlePath}`)
  }
  const compilerBlock =
    `kotlin {\n    compilerOptions {\n        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.${target})\n    }\n}`
  return next.replace(dependenciesBlock, `${compilerBlock}\n\n$1`)
}

function syncIncludedAndroidKotlinProjects() {
  if (!existsSync(generatedTauriSettingsGradlePath)) {
    throw new Error(`Generated Tauri Android settings are missing: ${generatedTauriSettingsGradlePath}`)
  }

  const settings = readFileSync(generatedTauriSettingsGradlePath, 'utf8')
  const projectDirLine =
    /^([ \t]*project\(["']:)([^"']+)(["']\)\.projectDir\s*=\s*new File\(["'])([^"']+)(["']\)[ \t]*)$/gm
  const projectLines = [...settings.matchAll(projectDirLine)]
  const byName = new Map(projectLines.map((match) => [match[2], match]))
  if (projectLines.length !== includedAndroidKotlinProjects.length ||
      byName.size !== includedAndroidKotlinProjects.length ||
      includedAndroidKotlinProjects.some((name) => !byName.has(name))) {
    throw new Error(`Generated Tauri Android settings must contain exactly the three known dependency project paths: ${generatedTauriSettingsGradlePath}`)
  }

  let priorSources = null
  if (existsSync(generatedAndroidKotlinCompatManifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(generatedAndroidKotlinCompatManifestPath, 'utf8'))
      if (manifest.version !== 1 || !manifest.sources || typeof manifest.sources !== 'object') {
        throw new Error('unexpected manifest shape')
      }
      priorSources = manifest.sources
    } catch {
      throw new Error(`Generated Android Kotlin compatibility source map is invalid: ${generatedAndroidKotlinCompatManifestPath}`)
    }
  }

  const plannedProjects = includedAndroidKotlinProjects.map((name) => {
    const settingsMatch = byName.get(name)
    const settingsPath = resolve(settingsMatch[4])
    const stageDir = resolve(generatedAndroidKotlinCompatDir, name)
    const isStaged = settingsPath === stageDir
    const generatedRelativePath = relative(genAndroidDir, settingsPath)
    const isInsideGeneratedProject = generatedRelativePath === '' ||
      (!generatedRelativePath.startsWith(`..${sep}`) && generatedRelativePath !== '..')
    let sourceDir = settingsPath
    if (isStaged) {
      if (!priorSources || typeof priorSources[name] !== 'string') {
        throw new Error(`Missing original source path for staged Android project ${name}.`)
      }
      sourceDir = resolve(priorSources[name])
    } else if (isInsideGeneratedProject) {
      throw new Error(`Unexpected nested Android compatibility source path for ${name}: ${settingsPath}`)
    }

    const compatRelativePath = relative(generatedAndroidKotlinCompatDir, sourceDir)
    if (compatRelativePath === '' ||
        (!compatRelativePath.startsWith(`..${sep}`) && compatRelativePath !== '..')) {
      throw new Error(`Android compatibility source cannot be inside its generated staging directory: ${sourceDir}`)
    }
    const sourceGeneratedRelativePath = relative(genAndroidDir, sourceDir)
    if (sourceGeneratedRelativePath === '' ||
        (!sourceGeneratedRelativePath.startsWith(`..${sep}`) && sourceGeneratedRelativePath !== '..')) {
      throw new Error(`Android compatibility source cannot be inside the generated Android project: ${sourceDir}`)
    }

    const sourceGradlePath = resolve(sourceDir, 'build.gradle.kts')
    if (!existsSync(sourceGradlePath)) {
      throw new Error(`Included Android project Gradle file is missing: ${sourceGradlePath}`)
    }
    const canonicalBuild = readFileSync(sourceGradlePath, 'utf8')
    const migratedBuild = migrateKotlinCompilerOptions(canonicalBuild, 'JVM_1_8', sourceGradlePath)
    return { name, sourceDir, stageDir, migratedBuild }
  })

  const barcodeScannerProject = plannedProjects.find(({ name }) => name === 'tauri-plugin-barcode-scanner')
  if (!barcodeScannerProject || resolve(barcodeScannerProject.sourceDir) !== resolve(vendorBarcodeScannerAndroidDir)) {
    throw new Error(`Generated barcode scanner project must resolve to the vendored Android source: ${vendorBarcodeScannerAndroidDir}`)
  }

  // Validate every source/build script before replacing any generated copy.
  for (const project of plannedProjects) {
    rmSync(project.stageDir, { recursive: true, force: true })
    mkdirSync(resolve(project.stageDir, '..'), { recursive: true })
    cpSync(project.sourceDir, project.stageDir, {
      recursive: true,
      force: true,
      filter: (sourcePath) => {
        const relativePath = relative(project.sourceDir, sourcePath)
        return !relativePath.split(sep).some((part) => ['build', '.gradle', '.git'].includes(part))
      },
    })
    writeFileSync(resolve(project.stageDir, 'build.gradle.kts'), project.migratedBuild)
  }

  const canonicalMain = resolve(vendorBarcodeScannerAndroidDir, 'src/main')
  const stagedMain = resolve(generatedAndroidKotlinCompatDir, 'tauri-plugin-barcode-scanner/src/main')
  const canonicalFiles = sourceFiles(canonicalMain).map((file) => relative(canonicalMain, file))
  const stagedFiles = sourceFiles(stagedMain).map((file) => relative(stagedMain, file))
  if (!canonicalFiles.length || canonicalFiles.length !== stagedFiles.length ||
      !canonicalFiles.every((file, index) => file === stagedFiles[index] &&
        readFileSync(resolve(canonicalMain, file)).equals(readFileSync(resolve(stagedMain, file))))) {
    throw new Error('Generated barcode scanner source differs from the canonical vendored source.')
  }

  const sources = Object.fromEntries(plannedProjects.map(({ name, sourceDir }) => [name, sourceDir]))
  writeFileSync(generatedAndroidKotlinCompatManifestPath, `${JSON.stringify({ version: 1, sources }, null, 2)}\n`)
  patchFile(generatedTauriSettingsGradlePath, (content) => content.replace(
    projectDirLine,
    (_line, prefix, name, projectSuffix, _previousPath, pathSuffix) => `${prefix}${name}${projectSuffix}${resolve(generatedAndroidKotlinCompatDir, name)}${pathSuffix}`,
  ))
}

function sourceFiles(root) {
  if (!existsSync(root)) return []
  const files = []
  const stack = [root]
  while (stack.length) {
    const current = stack.pop()
    const stat = statSync(current)
    if (stat.isDirectory()) {
      for (const child of readdirSync(current)) stack.push(join(current, child))
    } else if (stat.isFile()) {
      files.push(current)
    }
  }
  return files.sort()
}

function syncAuroraAndroidNativeResources() {
  if (!existsSync(canonicalPluginResourceDir)) {
    throw new Error(`Canonical Android native resources are missing: ${canonicalPluginResourceDir}`)
  }

  mkdirSync(generatedAndroidResourceDir, { recursive: true })
  copyNativeResourceTree(canonicalPluginResourceDir, generatedAndroidResourceDir)
  repairGeneratedBaseStrings()
  console.log('Synced Aurora Android native resources into the generated Android project.')
}

function copyNativeResourceTree(sourceDir, destinationDir, relativeDir = '') {
  for (const entry of readdirSync(join(sourceDir, relativeDir), {
    withFileTypes: true,
  })) {
    const relativePath = join(relativeDir, entry.name)
    if (entry.isDirectory()) {
      mkdirSync(join(destinationDir, relativePath), { recursive: true })
      copyNativeResourceTree(sourceDir, destinationDir, relativePath)
      continue
    }
    const destinationRelativePath =
      relativePath === join('values', 'strings.xml')
        ? join('values', 'aurora_native_strings.xml')
        : relativePath
    cpSync(
      join(sourceDir, relativePath),
      join(destinationDir, destinationRelativePath),
      { force: true },
    )
  }
}

function repairGeneratedBaseStrings() {
  if (!existsSync(generatedBaseStringsPath)) {
    mkdirSync(join(generatedAndroidResourceDir, 'values'), { recursive: true })
    writeFileSync(generatedBaseStringsPath, '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n</resources>\n')
  }
  patchFile(generatedBaseStringsPath, (content) => {
    let repaired = content.replace(
      /\s*<string\s+name="aurora_[^"]+"[^>]*>[\s\S]*?<\/string>/g,
      '',
    )
    const appName = 'Aurora'
    const missing = [
      ['app_name', appName],
      ['main_activity_title', appName],
    ]
      .filter(([name]) => !repaired.includes(`name="${name}"`))
      .map(([name, value]) => `    <string name="${name}">${value}</string>`)
      .join('\n')
    if (missing) {
      repaired = repaired.replace(/\s*<\/resources>/, `\n${missing}\n</resources>`)
    }
    return `${repaired.trim()}\n`
  })
}

function syncCanonicalAndroidLauncherIcons() {
  if (!existsSync(canonicalAndroidIconDir)) {
    throw new Error(`Canonical Android launcher icons are missing: ${canonicalAndroidIconDir}`)
  }

  mkdirSync(generatedAndroidResourceDir, { recursive: true })
  for (const entry of readdirSync(canonicalAndroidIconDir, {
    withFileTypes: true,
  })) {
    cpSync(
      join(canonicalAndroidIconDir, entry.name),
      join(generatedAndroidResourceDir, entry.name),
      { recursive: entry.isDirectory(), force: true },
    )
  }

  // The Tauri Android scaffold ships sample vector artwork under these names.
  // Aurora's adaptive icon references the canonical mipmap foreground and color
  // background instead, so remove the sample vectors to prevent stale packaging.
  rmSync(
    join(generatedAndroidResourceDir, 'drawable-v24', 'ic_launcher_foreground.xml'),
    { force: true },
  )
  rmSync(
    join(generatedAndroidResourceDir, 'drawable', 'ic_launcher_background.xml'),
    { force: true },
  )
  console.log('Synced canonical Aurora launcher icons into the generated Android project.')
}

function verifyVendorBarcodeScannerSource() {
  if (!existsSync(vendorBarcodeScannerAndroidDir)) {
    throw new Error(
      `Vendored Tauri barcode scanner Android project is missing: ${vendorBarcodeScannerAndroidDir}`,
    )
  }

  const cargoToml = readFileSync(cargoTomlPath, 'utf8')
  if (!cargoToml.includes('tauri-plugin-barcode-scanner = { path = "vendor/tauri-plugin-barcode-scanner" }')) {
    throw new Error('Cargo.toml must depend on the vendored Android barcode scanner source.')
  }

  const buildScript = readFileSync(vendorBarcodeScannerBuildScriptPath, 'utf8')
  if (!buildScript.includes('.android_path("android")')) {
    throw new Error('Vendored barcode scanner build script must expose its Android project to Tauri.')
  }

  const source = readFileSync(vendorBarcodeScannerSourcePath, 'utf8')
  for (const required of [
    'val pendingScan = savedInvoke',
    'destroy()',
    'pendingScan?.reject("cancelled")',
    'invoke.resolve()',
  ]) {
    if (!source.includes(required)) {
      throw new Error(
        `Vendored barcode scanner source is missing cancellation-safe marker: ${required}`,
      )
    }
  }

  console.log(
    'Verified Android barcode scanner uses Aurora’s cancellation-safe vendored source through the Tauri mobile build output.',
  )
}

function syncNativeSpeechLibraries() {
  const targets = (process.env.AURORA_ANDROID_NATIVE_TARGETS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  if (targets.length === 0) return

  const selectedAbis = new Set(targets.map((target) => androidNativeSpeechTargets[target]?.abi).filter(Boolean))
  for (const spec of Object.values(androidNativeSpeechTargets)) {
    for (const library of requiredNativeSpeechLibraries) {
      rmSync(join(generatedAndroidJniLibsDir, spec.abi, library), { force: true })
    }
    if (!selectedAbis.has(spec.abi)) {
      rmSync(join(generatedAndroidJniLibsDir, spec.abi, generatedRustLibrary), { force: true })
    }
  }

  const staged = []
  for (const target of targets) {
    const spec = androidNativeSpeechTargets[target]
    if (!spec) {
      throw new Error(
        `Unsupported Android native speech target ${target}; expected ${Object.keys(androidNativeSpeechTargets).join(' or ')}`,
      )
    }
    const configured = process.env[spec.libDirEnv]
      ?? process.env[`CARGO_${spec.libDirEnv}`]
    if (!configured) {
      throw new Error(
        `${spec.libDirEnv} is required to stage Android native speech libraries for ${spec.abi}`,
      )
    }
    const sourceDir = resolve(configured)
    const destinationDir = join(generatedAndroidJniLibsDir, spec.abi)
    mkdirSync(destinationDir, { recursive: true })
    for (const library of requiredNativeSpeechLibraries) {
      const source = join(sourceDir, library)
      if (!existsSync(source)) {
        throw new Error(`${spec.libDirEnv} is missing ${library}: ${sourceDir}`)
      }
      assertNativeSpeechLibraryCapabilities(source, library, spec.abi)
      cpSync(source, join(destinationDir, library), { force: true })
    }
    staged.push(spec.abi)
  }

  console.log(
    `Staged Android native speech runtime libraries for ${staged.join(', ')}.`,
  )
}

function assertNativeSpeechLibraryCapabilities(path, library, abi) {
  if (library !== 'libsherpa-onnx-c-api.so') return

  // sherpa-onnx keeps its disabled TTS constructor as an exported stub. Symbol
  // checks therefore pass even when the native runtime cannot create Piper TTS.
  if (readFileSync(path).includes(sherpaTtsDisabledMarker)) {
    throw new Error(
      `Android native speech runtime for ${abi} was built without TTS; rebuild sherpa-onnx with SHERPA_ONNX_ENABLE_TTS=ON`,
    )
  }
}

function patchFile(path, patch) {
  const before = readFileSync(path, 'utf8')
  const after = patch(before)
  if (after !== before) {
    writeFileSync(path, after)
  }
}

function mergePluginManifest(content) {
  const permissionBlock = [
    '    <uses-permission android:name="android.permission.RECORD_AUDIO" />',
    '    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />',
    '    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />',
    '    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />',
    '    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MICROPHONE" />',
    '    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE" />',
    '    <uses-permission android:name="android.permission.WAKE_LOCK" />',
    '    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />',
    '    <uses-permission android:name="android.permission.CHANGE_NETWORK_STATE" />',
    '    <uses-permission android:name="android.permission.USE_BIOMETRIC" />',
  ]
    .filter((line) => !content.includes(line.trim()))
    .join('\n')

  let patched = content
  if (permissionBlock) {
    patched = patched.replace(/(\s*<application\b)/, `\n${permissionBlock}\n$1`)
  }
  if (!patched.includes('android.software.webview')) {
    patched = patched.replace(
      /(\s*<application\b)/,
      '\n    <uses-feature android:name="android.software.webview" android:required="true" />\n$1',
    )
  }
  // The generated Tauri manifest includes an optional Leanback launcher by
  // default, but Aurora does not ship an Android TV surface or TV banner.
  // Remove that template-only declaration so the packaged client does not
  // advertise an unsupported TV target and Android lint stays meaningful.
  patched = patched
    .replace(/\s*<!-- AndroidTV support -->\s*/g, '\n')
    .replace(/\s*<uses-feature android:name="android\.software\.leanback" android:required="false" \/>\s*/g, '\n')
    .replace(/\s*<category android:name="android\.intent\.category\.LEANBACK_LAUNCHER" \/>\s*/g, '\n')
  patched = patched.replace(
    /<application\b([^>]*)>/,
    (application, attributes) => {
      let patchedApplication = application
      if (attributes.includes('android:usesCleartextTraffic=')) {
        patchedApplication = patchedApplication.replace(
          /android:usesCleartextTraffic="[^"]*"/,
          'android:usesCleartextTraffic="false"',
        )
      } else {
        patchedApplication = patchedApplication.replace(
          /<application\b/,
          '<application android:usesCleartextTraffic="false"',
        )
      }
      if (attributes.includes('android:networkSecurityConfig=')) {
        return patchedApplication.replace(
          /android:networkSecurityConfig="[^"]*"/,
          'android:networkSecurityConfig="@xml/aurora_network_security_config"',
        )
      }
      return patchedApplication.replace(
        /<application\b/,
        '<application android:networkSecurityConfig="@xml/aurora_network_security_config"',
      )
    },
  )
  patched = patched.replace(
    /<activity\b(?=[^>]*android:name="[^"]*\.MainActivity")[^>]*>/,
    (activity) => {
      if (activity.includes('android:windowSoftInputMode=')) {
        return activity.replace(
          /android:windowSoftInputMode="[^"]*"/,
          'android:windowSoftInputMode="adjustResize"',
        )
      }
      return activity.replace(/>$/, ' android:windowSoftInputMode="adjustResize">')
    },
  )

  // Keep the generated app manifest aligned with the canonical native-plugin
  // manifest. Remove stale Aurora-owned component declarations first so this
  // remains idempotent as component metadata evolves.
  for (const [tag, className] of [
    ['service', 'dev.aurora.tauri.nativeplugin.AuroraRuntimeForegroundService'],
    ['service', 'dev.aurora.tauri.nativeplugin.AuroraVoiceInteractionService'],
    ['service', 'dev.aurora.tauri.nativeplugin.AuroraVoiceInteractionSessionService'],
    ['activity', 'dev.aurora.tauri.nativeplugin.AuroraAssistActivity'],
    ['activity', 'dev.aurora.tauri.nativeplugin.AuroraEntrypointActivity'],
    ['receiver', 'dev.aurora.tauri.nativeplugin.AuroraWidgetProvider'],
    ['service', 'dev.aurora.tauri.nativeplugin.AuroraQuickSettingsTileService'],
  ]) {
    patched = removeManifestComponent(patched, tag, className)
  }

  const nativeComponents = `
        <service
            android:name="dev.aurora.tauri.nativeplugin.AuroraRuntimeForegroundService"
            android:enabled="true"
            android:exported="false"
            android:foregroundServiceType="microphone|connectedDevice" />

        <service
            android:name="dev.aurora.tauri.nativeplugin.AuroraVoiceInteractionService"
            android:enabled="true"
            android:exported="true"
            android:label="Aurora"
            android:permission="android.permission.BIND_VOICE_INTERACTION">
            <meta-data
                android:name="android.voice_interaction"
                android:resource="@xml/aurora_voice_interaction_service" />
            <intent-filter>
                <action android:name="android.service.voice.VoiceInteractionService" />
            </intent-filter>
        </service>

        <service
            android:name="dev.aurora.tauri.nativeplugin.AuroraVoiceInteractionSessionService"
            android:enabled="true"
            android:exported="true"
            android:label="Aurora"
            android:permission="android.permission.BIND_VOICE_INTERACTION" />

        <activity
            android:name="dev.aurora.tauri.nativeplugin.AuroraAssistActivity"
            android:enabled="true"
            android:exported="true"
            android:label="Aurora">
            <intent-filter>
                <action android:name="android.intent.action.ASSIST" />
                <category android:name="android.intent.category.DEFAULT" />
            </intent-filter>
        </activity>

        <activity
            android:name="dev.aurora.tauri.nativeplugin.AuroraEntrypointActivity"
            android:enabled="true"
            android:exported="true"
            android:label="Aurora">
            <intent-filter>
                <action android:name="android.intent.action.SEND" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="text/*" />
                <data android:mimeType="image/*" />
                <data android:mimeType="application/pdf" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.SEND_MULTIPLE" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="image/*" />
                <data android:mimeType="application/pdf" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.PROCESS_TEXT" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="text/plain" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="aurora" android:host="assistant" />
                <data android:scheme="https" android:host="aurora.local" android:pathPrefix="/assistant" />
            </intent-filter>
            <meta-data android:name="android.app.shortcuts" android:resource="@xml/aurora_shortcuts" />
        </activity>

        <receiver
            android:name="dev.aurora.tauri.nativeplugin.AuroraWidgetProvider"
            android:enabled="true"
            android:exported="false"
            android:label="Aurora">
            <intent-filter>
                <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />
            </intent-filter>
            <meta-data android:name="android.appwidget.provider" android:resource="@xml/aurora_widget_info" />
        </receiver>

        <service
            android:name="dev.aurora.tauri.nativeplugin.AuroraQuickSettingsTileService"
            android:enabled="true"
            android:exported="true"
            android:icon="@drawable/ic_aurora_entrypoint"
            android:label="Aurora"
            android:permission="android.permission.BIND_QUICK_SETTINGS_TILE">
            <intent-filter>
                <action android:name="android.service.quicksettings.action.QS_TILE" />
            </intent-filter>
        </service>
`

  // aurora:// deep links (mesh invites). The Tauri deep-link plugin only generates intent
  // filters for https app links, so the custom scheme is injected into MainActivity here.
  patched = patched.replace(
    '<data android:scheme="aurora" />',
    '<data android:scheme="aurora" android:host="mesh" />',
  )
  if (!patched.includes('android:scheme="aurora" android:host="mesh"')) {
    const deepLinkFilter = `
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="aurora" android:host="mesh" />
            </intent-filter>`
    patched = patched.replace(/(<activity[^>]*MainActivity[^>]*>)/, `$1${deepLinkFilter}`)
  }

  patched = patched.replace(/\s*<\/application>/, `${nativeComponents}\n    </application>`)
  return patched
}

function addMainActivityImeInsets(content) {
  let patched = content
  patched = patched.replace(
    /\n\s*WebView\.setWebContentsDebuggingEnabled\(BuildConfig\.DEBUG\)/g,
    '',
  )
  const missingImports = [
    'import android.content.pm.ApplicationInfo',
    'import android.view.View',
    'import android.webkit.WebView',
    'import androidx.core.view.ViewCompat',
    'import androidx.core.view.WindowInsetsCompat',
  ].filter((line) => !patched.includes(line))
  if (missingImports.length > 0) {
    patched = patched.replace(
      /^(package[^\n]*\n)/,
      `$1\n${missingImports.join('\n')}\n`,
    )
  }

  if (!/super\.onCreate\(savedInstanceState\)\s*\n\s*enableAuroraDebugWebView\(\)\s*\n\s*applyAuroraImeInsets\(\)/.test(patched)) {
    patched = patched.replace(
      /super\.onCreate\(savedInstanceState\)/,
      'super.onCreate(savedInstanceState)\n    enableAuroraDebugWebView()\n    applyAuroraImeInsets()',
    )
  }
  if (!/enableAuroraDebugWebView\(\)\s*\n\s*super\.onCreate/.test(patched)) {
    patched = patched.replace(
      /enableEdgeToEdge\(\)/,
      'enableEdgeToEdge()\n    enableAuroraDebugWebView()',
    )
  }

  if (!patched.includes('private fun enableAuroraDebugWebView')) {
    patched = patched.replace(
      /\n}\s*$/,
      `

  private fun enableAuroraDebugWebView() {
    if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
      WebView.setWebContentsDebuggingEnabled(true)
    }
  }
}
`,
    )
  }

  if (!patched.includes('private fun applyAuroraImeInsets')) {
    patched = patched.replace(
      /\n}\s*$/,
      `

  private fun applyAuroraImeInsets() {
    val content = findViewById<View>(android.R.id.content)
    val initialPaddingLeft = content.paddingLeft
    val initialPaddingTop = content.paddingTop
    val initialPaddingRight = content.paddingRight
    val initialPaddingBottom = content.paddingBottom

    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val imeBottom = if (insets.isVisible(WindowInsetsCompat.Type.ime())) {
        insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      } else {
        0
      }
      view.setPadding(
        initialPaddingLeft,
        initialPaddingTop,
        initialPaddingRight,
        initialPaddingBottom + imeBottom,
      )
      insets
    }
    ViewCompat.requestApplyInsets(content)
  }
}
`,
    )
  }

  patched = patched.replace(
    /(\n\s*applyAuroraImeInsets\(\)){2,}/g,
    '\n    applyAuroraImeInsets()',
  )
  return patched
}

function removeManifestComponent(content, tag, className) {
  const escapedClassName = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const selfClosing = new RegExp(
    `\\s*<${tag}\\b(?=[^>]*android:name="${escapedClassName}")[^>]*/>`,
    'g',
  )
  const block = new RegExp(
    `\\s*<${tag}\\b(?=[^>]*android:name="${escapedClassName}")[^>]*>[\\s\\S]*?</${tag}>`,
    'g',
  )
  return content.replace(selfClosing, '').replace(block, '')
}
