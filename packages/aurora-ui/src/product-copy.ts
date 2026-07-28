import { findForbiddenProductionCopyTerms } from './product-copy-forbidden-terms'

export type ProductCopyStatusCode =
  | 'connected'
  | 'peer-offline'
  | 'approval-pending'
  | 'local-permission-missing'
  | 'local-feature-disabled'
  | 'local-data-saved'
  | 'temporary-session'
  | 'local-features-owned-elsewhere'
  | 'local-data-update-failed'
  | 'unsupported-feature'
  | 'connection-lost'
  | 'connection-failed'
  | 'connected-with-address'
  | 'item-read-failed'

export interface ProductCopyResult {
  readonly title: string
  readonly description?: string
  readonly action?: string
  readonly supportId?: string
}

export const PRODUCT_COPY = {
  onboarding: {
    title: 'Set up Aurora on this device',
    choices: {
      connect: {
        label: 'Connect to Aurora',
        description: 'Use Aurora running on another device or server.',
      },
      makeAvailable: {
        label: 'Make this device available',
        description: 'Let approved Aurora devices use features you choose from this device.',
      },
      runHere: {
        label: 'Run Aurora on this computer',
        description: 'Start Aurora here and connect this computer to your other devices.',
      },
    },
    invite: {
      title: 'Add your invite',
      deviceName: 'Device name',
      scan: 'Scan invite',
      openFile: 'Open invite file',
      paste: 'Paste invite',
      continue: 'Save invite and continue',
      saving: 'Saving...',
      advanced: 'Connect with an address',
    },
    done: {
      title: "You're all set",
      action: 'Open Mesh',
    },
  },
  connection: {
    panelTitle: 'Connected Aurora device',
    addressLabel: 'Aurora address',
    methodLabel: 'Connection method',
    useInvite: 'Use invite',
    reconnect: 'Reconnect',
    disconnect: 'Disconnect',
    connected: 'Connected',
    lost: 'Connection lost. Reconnecting...',
  },
  mesh: {
    title: 'Mesh',
    localDevice: 'This device',
    connectedDevice: 'Connected Aurora device',
    localFeatures: 'Features on this device',
    approvals: 'Waiting for approval on both devices',
    approve: 'Approve device',
    deny: 'Deny device',
    remove: 'Forget this device',
  },
  localData: {
    saved: 'Saved on this device',
    temporary: 'Temporary session - changes may be lost when you close Aurora',
    ownedElsewhere: 'Local features are already active in another Aurora window',
    move: 'Move local data',
    unchanged: 'Your existing local data was not changed. Try again.',
  },
  permissions: {
    needed: 'Permission is needed to use this feature',
    limited: 'Limited access',
    administrator: 'Administrator',
  },
} as const

export function productStatusCopy(
  code: ProductCopyStatusCode,
  input: { deviceName?: string | null | undefined; supportId?: string | null | undefined } = {},
): ProductCopyResult {
  const device = safeDeviceName(input.deviceName)
  const supportId = safeSupportId(input.supportId)
  const withSupportId = (copy: ProductCopyResult): ProductCopyResult =>
    supportId ? { ...copy, supportId } : copy

  switch (code) {
    case 'connected':
      return { title: `Connected to ${device}` }
    case 'peer-offline':
      return { title: `${device} is offline`, action: 'Try again' }
    case 'approval-pending':
      return { title: PRODUCT_COPY.mesh.approvals }
    case 'local-permission-missing':
      return { title: PRODUCT_COPY.permissions.needed, action: 'Review access' }
    case 'local-feature-disabled':
      return { title: 'This feature is off on this device', action: 'Turn on feature' }
    case 'local-data-saved':
      return { title: PRODUCT_COPY.localData.saved }
    case 'temporary-session':
      return { title: PRODUCT_COPY.localData.temporary }
    case 'local-features-owned-elsewhere':
      return { title: PRODUCT_COPY.localData.ownedElsewhere, action: 'Close another window' }
    case 'local-data-update-failed':
      return withSupportId({ title: PRODUCT_COPY.localData.unchanged, action: 'Try again' })
    case 'unsupported-feature':
      return withSupportId({ title: 'This Aurora version cannot use that feature yet' })
    case 'connection-lost':
      return { title: PRODUCT_COPY.connection.lost }
    case 'connection-failed':
      return withSupportId({ title: `Could not connect to ${device}. Try again.`, action: 'Try again' })
    case 'connected-with-address':
      return { title: PRODUCT_COPY.connection.connected }
    case 'item-read-failed':
      return withSupportId({ title: 'Aurora could not read this item' })
  }
}

export function safeErrorCopy(error: unknown, supportId?: string | null): ProductCopyResult {
  if (isAbortError(error)) return { title: 'Action cancelled' }
  const code = errorCode(error)
  if (code === 'permission_denied') return productStatusCopy('local-permission-missing', { supportId })
  if (code === 'unsupported') return productStatusCopy('unsupported-feature', { supportId })
  if (code === 'connection_lost' || code === 'transport_loss') return productStatusCopy('connection-lost', { supportId })
  return productStatusCopy('connection-failed', { supportId })
}

export function assertProductCopySafe(value: string): void {
  const matches = findForbiddenProductionCopyTerms(value)
  if (matches.length > 0) {
    throw new Error(`Production copy contains blocked wording: ${matches.map((term) => term.id).join(', ')}`)
  }
}

function safeDeviceName(value: string | null | undefined): string {
  const trimmed = value?.trim()
  return trimmed ? trimmed.replace(/\s+/gu, ' ') : 'this Aurora device'
}

function safeSupportId(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  return /^[A-Z0-9][A-Z0-9._-]{2,31}$/u.test(trimmed) ? trimmed : undefined
}

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const code = 'code' in error ? (error as { code?: unknown }).code : null
  return typeof code === 'string' ? code : null
}

function isAbortError(error: unknown): boolean {
  return typeof DOMException !== 'undefined'
    && error instanceof DOMException
    && error.name === 'AbortError'
}
