import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const appId = process.env.AURORA_ANDROID_APP_ID ?? 'dev.aurora.desktop'
const apk = process.env.AURORA_ANDROID_APK ?? findApk()

if (!apk) {
  throw new Error('No Android APK found. Run pnpm --filter @aurora/tauri-ui android:build:apk first.')
}

run('adb', ['wait-for-device'])
run('adb', ['install', '-r', apk])
run('adb', ['logcat', '-c'])
run('adb', ['shell', 'monkey', '-p', appId, '-c', 'android.intent.category.LAUNCHER', '1'])

const payloadLine = waitForPayloadLine()
if (!payloadLine) {
  throw new Error('Android baseline payload log was not observed after app launch.')
}

console.log(`Installed APK: ${apk}`)
console.log(`Launched package: ${appId}`)
console.log(payloadLine)

function findApk() {
  const roots = [
    'src-tauri/gen/android/app/build/outputs/apk/universal/debug',
    'src-tauri/gen/android/app/build/outputs/apk/universal/release',
    'src-tauri/gen/android/app/build/outputs/apk'
  ]
  for (const root of roots) {
    if (!existsSync(root)) continue
    const found = walk(root).find((path) => path.endsWith('.apk') && !path.endsWith('-unsigned.apk'))
    if (found) return found
  }
  return null
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? walk(path) : [path]
  })
}

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit' })
}

function waitForPayloadLine() {
  const deadline = Date.now() + Number(process.env.AURORA_ANDROID_SMOKE_TIMEOUT_MS ?? 60_000)
  while (Date.now() < deadline) {
    const logcat = spawnSync('adb', ['logcat', '-d', '-t', '800'], { encoding: 'utf8' })
    if (logcat.error) {
      throw logcat.error
    }
    const output = `${logcat.stdout}\n${logcat.stderr}`
    const line = output.split(/\r?\n/).find((entry) => entry.includes('aurora_android_baseline_status='))
    if (line) return line
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)
  }
  return null
}
