import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

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
const canonicalPluginResourceDir = resolve('src-tauri/android/aurora-native-plugin/src/main/res')
const canonicalAndroidIconDir = resolve('src-tauri/icons/android')
const generatedAndroidResourceDir = resolve(genAndroidDir, 'app/src/main/res')
const generatedBaseStringsPath = join(generatedAndroidResourceDir, 'values', 'strings.xml')

if (!existsSync(appManifestPath)) {
  throw new Error('Tauri Android project is missing. Run android:init before installing the Aurora native plugin.')
}

mkdirSync(generatedPluginSourceDir, { recursive: true })
cpSync(pluginSourceDir, generatedPluginSourceDir, { recursive: true })
syncAuroraAndroidNativeResources()
syncCanonicalAndroidLauncherIcons()
verifyVendorBarcodeScannerSource()

patchFile(appManifestPath, (content) => mergePluginManifest(content))
if (existsSync(mainActivityPath)) {
  patchFile(mainActivityPath, (content) => addMainActivityImeInsets(content))
}

console.log('Installed Aurora Android native plugin source into src-tauri/gen/android.')

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
    '    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />',
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
    ['service', 'dev.aurora.tauri.nativeplugin.AuroraVoiceForegroundService'],
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
            android:name="dev.aurora.tauri.nativeplugin.AuroraVoiceForegroundService"
            android:enabled="true"
            android:exported="false"
            android:foregroundServiceType="microphone" />

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
  const missingImports = [
    'import android.view.View',
    'import androidx.core.view.ViewCompat',
    'import androidx.core.view.WindowInsetsCompat',
  ].filter((line) => !patched.includes(line))
  if (missingImports.length > 0) {
    patched = patched.replace(
      /^(package[^\n]*\n)/,
      `$1\n${missingImports.join('\n')}\n`,
    )
  }

  if (!/super\.onCreate\(savedInstanceState\)\s*\n\s*applyAuroraImeInsets\(\)/.test(patched)) {
    patched = patched.replace(
      /super\.onCreate\(savedInstanceState\)/,
      'super.onCreate(savedInstanceState)\n    applyAuroraImeInsets()',
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
