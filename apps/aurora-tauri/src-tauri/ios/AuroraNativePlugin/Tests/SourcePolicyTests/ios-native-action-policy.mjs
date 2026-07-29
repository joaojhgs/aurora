import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(testDir, '..', '..')
const source = readFileSync(
  resolve(packageRoot, 'Sources', 'AuroraNativePlugin', 'AuroraNativePlugin.swift'),
  'utf8',
)

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

for (const command of ['shareText', 'openDeepLink', 'showNotification']) {
  assert(
    source.includes(`@objc public func ${command}(_ invoke: Invoke)`),
    `missing concrete iOS action command ${command}`,
  )
}

for (const permission of [
  '"aurora.ios.shareText": true',
  '"aurora.ios.openDeepLink": true',
  '"aurora.nativeCapabilityManifest": true',
  '"native.permissionsManifest": true',
  '"native.deviceStatus": true',
]) {
  assert(source.includes(permission), `missing iOS manifest permission ${permission}`)
}

for (const capability of [
  '"ios.shareText": true',
  '"ios.openDeepLink": true',
  '"native.permissionsManifest": true',
  '"native.deviceStatus": true',
]) {
  assert(source.includes(capability), `missing iOS manifest capability ${capability}`)
}

for (const state of [
  '"aurora.ios.shareText": "available"',
  '"aurora.ios.openDeepLink": "available"',
  '"native.deviceStatus": "available"',
]) {
  assert(source.includes(state), `missing iOS manifest state ${state}`)
}

for (const dynamicNotificationEntry of [
  '"aurora.ios.showNotification": notificationReady',
  '"ios.showNotification": notificationReady',
  '"ios.notifications": notificationReady',
  '"aurora.ios.showNotification": notificationState',
  '"ios.showNotification": notificationState',
  '"ios.notifications": notificationState',
]) {
  assert(
    source.includes(dynamicNotificationEntry),
    `iOS notification manifest entry must use current authorization: ${dynamicNotificationEntry}`,
  )
}

for (const scheme of ['"https"', '"mailto"', '"tel"', '"aurora"', '"aurora-local"']) {
  assert(source.includes(scheme), `missing allowlisted outgoing scheme ${scheme}`)
}

assert(source.includes('UIActivityViewController'), 'shareText must use the system share sheet')
assert(source.includes('UIApplication.shared.open'), 'openDeepLink must use UIApplication.open')
assert(
  source.includes('UNUserNotificationCenter.current().getNotificationSettings'),
  'manifest discovery and showNotification must inspect existing notification settings',
)
assert(
  source.includes(
    'let notificationReady = AuroraNativePlugin.notificationsAlreadyAuthorized(',
  ),
  'native manifest must derive notification availability from current authorization',
)
assert(
  source.includes(
    'let notificationState = notificationReady ? "available" : "needs_native_permission"',
  ),
  'native manifest must expose the current notification permission state',
)
assert(
  source.includes('UNUserNotificationCenter.current().add(request)'),
  'showNotification must post through UserNotifications',
)
assert(
  !source.includes('requestAuthorization('),
  'remote notification action must not prompt for authorization',
)
const outgoingActionSlice = source.slice(
  source.indexOf('@objc public func shareText(_ invoke: Invoke)'),
  source.indexOf('@objc public func backgroundStatus(_ invoke: Invoke)'),
)
assert(outgoingActionSlice.length > 0, 'missing outgoing action source slice')
assert(
  !/shell|process|rawGetter|unrestricted/i.test(outgoingActionSlice),
  'iOS outgoing action source must not expose raw execution surfaces',
)
assert(!source.includes('func invoke('), 'iOS plugin source must not expose a generic invoke command')

console.log('iOS native action source policy passed')
