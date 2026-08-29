import type { LocalDataBackendStatus } from '@aurora/client/local-data'

export type BrowserStorageInternalState =
  | 'ready_persistent'
  | 'ready_memory'
  | 'owner_blocked'
  | 'needs_attention'
  | 'unsupported'

export type BrowserStorageProductOutcome =
  | 'ready'
  | 'saved_on_this_device'
  | 'temporary_session'
  | 'needs_attention'

export interface BrowserStorageHealthInput {
  readonly backend: LocalDataBackendStatus
  readonly ownerAvailable: boolean
  readonly internalState?: BrowserStorageInternalState
  readonly internalReason?: string
}

export interface BrowserStorageHealth {
  readonly outcome: BrowserStorageProductOutcome
  readonly canWrite: boolean
  readonly canRetry: boolean
  readonly internalState: BrowserStorageInternalState
  readonly internalReason?: string
  readonly product: {
    readonly title: string
    readonly detail: string
  }
}

export function describeBrowserStorageHealth(input: BrowserStorageHealthInput): BrowserStorageHealth {
  const internalState = input.internalState ?? inferInternalState(input)
  const outcome = toProductOutcome(internalState, input.backend)
  return {
    outcome,
    canWrite: outcome === 'ready' || outcome === 'saved_on_this_device',
    canRetry: outcome === 'temporary_session' || outcome === 'needs_attention',
    internalState,
    ...(input.internalReason === undefined ? {} : { internalReason: input.internalReason }),
    product: productCopy(outcome)
  }
}

function inferInternalState(input: BrowserStorageHealthInput): BrowserStorageInternalState {
  if (!input.ownerAvailable) return 'owner_blocked'
  if (input.backend.persistent && input.backend.migrationState === 'idle') return 'ready_persistent'
  if (!input.backend.persistent && input.backend.migrationState === 'idle') return 'ready_memory'
  return 'needs_attention'
}

function toProductOutcome(
  internalState: BrowserStorageInternalState,
  backend: LocalDataBackendStatus,
): BrowserStorageProductOutcome {
  if (internalState === 'ready_persistent') return 'saved_on_this_device'
  if (internalState === 'ready_memory' || internalState === 'unsupported') return 'temporary_session'
  if (internalState === 'owner_blocked') return backend.persistent ? 'ready' : 'temporary_session'
  return 'needs_attention'
}

function productCopy(outcome: BrowserStorageProductOutcome): BrowserStorageHealth['product'] {
  switch (outcome) {
    case 'ready':
      return {
        title: 'Ready',
        detail: 'Another Aurora window is finishing changes. This window will update when it is ready.'
      }
    case 'saved_on_this_device':
      return {
        title: 'Saved on this device',
        detail: 'Your recent Aurora activity is available after refresh on this device.'
      }
    case 'temporary_session':
      return {
        title: 'Temporary session',
        detail: 'Aurora can continue here, but recent activity may not be available after refresh.'
      }
    case 'needs_attention':
      return {
        title: 'Local data needs attention',
        detail: 'Aurora could not safely open recent activity. Reset local data or try again.'
      }
  }
}
