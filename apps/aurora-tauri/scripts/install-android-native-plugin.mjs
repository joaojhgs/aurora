import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const genAndroidDir = resolve('src-tauri/gen/android')
const appManifestPath = resolve(genAndroidDir, 'app/src/main/AndroidManifest.xml')
const pluginSourceDir = resolve('src-tauri/android/aurora-native-plugin/src/main/java/dev/aurora/tauri/nativeplugin')
const generatedPluginSourceDir = resolve(genAndroidDir, 'app/src/main/java/dev/aurora/tauri/nativeplugin')

if (!existsSync(appManifestPath)) {
  throw new Error('Tauri Android project is missing. Run android:init before installing the Aurora native plugin.')
}

mkdirSync(generatedPluginSourceDir, { recursive: true })
cpSync(pluginSourceDir, generatedPluginSourceDir, { recursive: true })

patchFile(appManifestPath, (content) => mergePluginManifest(content))

console.log('Installed Aurora Android native plugin source into src-tauri/gen/android.')

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
    '    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />',
    '    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MICROPHONE" />'
  ]
    .filter((line) => !content.includes(line.trim()))
    .join('\n')

  let patched = content
  if (permissionBlock) {
    patched = patched.replace(/(\s*<application\b)/, `\n${permissionBlock}\n$1`)
  }

  if (!patched.includes('dev.aurora.tauri.nativeplugin.AuroraVoiceInteractionService')) {
    const components = `
        <!-- Disabled until AND-004 implements the complete VoiceInteractionService qualification flow. -->
        <service
            android:name="dev.aurora.tauri.nativeplugin.AuroraVoiceInteractionService"
            android:enabled="false"
            android:exported="true"
            android:label="Aurora"
            android:permission="android.permission.BIND_VOICE_INTERACTION">
            <intent-filter>
                <action android:name="android.service.voice.VoiceInteractionService" />
            </intent-filter>
        </service>

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
`
    patched = patched.replace(/\s*<\/application>/, `${components}\n    </application>`)
  }

  return patched
}
