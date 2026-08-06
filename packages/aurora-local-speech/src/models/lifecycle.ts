export type LocalSpeechInstallState =
  | 'not-installed'
  | 'queued'
  | 'downloading'
  | 'verifying'
  | 'ready'
  | 'active'
  | 'paused'
  | 'failed'
  | 'revoked'
  | 'removing'

export type LocalSpeechInstallEvent =
  | 'enqueue'
  | 'start-download'
  | 'pause'
  | 'resume'
  | 'download-complete'
  | 'verify-ok'
  | 'activate'
  | 'deactivate'
  | 'fail'
  | 'revoke'
  | 'remove'
  | 'removed'

export interface LocalSpeechLifecycleSnapshot {
  readonly packId: string
  readonly packVersion: string
  readonly state: LocalSpeechInstallState
  readonly revision: number
  readonly updatedAt: number
  readonly errorCode?: string
}

export interface LocalSpeechPackIdentity {
  readonly packId: string
  readonly packVersion: string
}

export function localSpeechPackLifecycleKey(packId: string, packVersion: string): string {
  return `${encodeURIComponent(packId)}@${encodeURIComponent(packVersion)}`
}

const transitions: Readonly<
  Record<LocalSpeechInstallState, Readonly<Partial<Record<LocalSpeechInstallEvent, LocalSpeechInstallState>>>>
> = {
  'not-installed': { enqueue: 'queued' },
  queued: { 'start-download': 'downloading', pause: 'paused', remove: 'removing', revoke: 'revoked' },
  downloading: { pause: 'paused', 'download-complete': 'verifying', fail: 'failed', remove: 'removing', revoke: 'revoked' },
  verifying: { 'verify-ok': 'ready', fail: 'failed', remove: 'removing', revoke: 'revoked' },
  ready: { activate: 'active', remove: 'removing', revoke: 'revoked' },
  active: { deactivate: 'ready', remove: 'removing', revoke: 'revoked' },
  paused: { resume: 'downloading', remove: 'removing', revoke: 'revoked', fail: 'failed' },
  failed: { enqueue: 'queued', remove: 'removing', revoke: 'revoked' },
  revoked: { remove: 'removing' },
  removing: { removed: 'not-installed' }
}

export function createLifecycleSnapshot(
  packId: string,
  packVersion: string,
  now = 0,
  state: LocalSpeechInstallState = 'not-installed'
): LocalSpeechLifecycleSnapshot {
  return { packId, packVersion, state, revision: 0, updatedAt: now }
}

export function applyLifecycleEvent(
  snapshot: LocalSpeechLifecycleSnapshot,
  event: LocalSpeechInstallEvent,
  options: { readonly now?: number; readonly errorCode?: string } = {}
): LocalSpeechLifecycleSnapshot {
  const nextState = transitions[snapshot.state][event]
  if (!nextState) throw new Error(`cannot apply ${event} while local speech pack is ${snapshot.state}`)
  const errorCode = nextState === 'failed' ? options.errorCode ?? 'unknown' : undefined
  return {
    packId: snapshot.packId,
    packVersion: snapshot.packVersion,
    state: nextState,
    revision: snapshot.revision + 1,
    updatedAt: options.now ?? snapshot.updatedAt,
    ...(errorCode ? { errorCode } : {})
  }
}

export function canActivate(snapshot: LocalSpeechLifecycleSnapshot): boolean {
  return snapshot.state === 'ready' || snapshot.state === 'active'
}
