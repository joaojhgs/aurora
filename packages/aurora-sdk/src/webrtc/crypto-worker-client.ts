import { zeroBytes } from './encoding.js'

export interface AuroraScryptParams {
  N: 65_536
  r: 8
  p: 1
  dkLen: 32
}

export const AURORA_SCRYPT_PARAMS: AuroraScryptParams = Object.freeze({ N: 65_536, r: 8, p: 1, dkLen: 32 })

export type AuroraScryptDeriver = (
  password: Uint8Array,
  salt: Uint8Array,
  params: AuroraScryptParams,
  signal?: AbortSignal
) => Promise<Uint8Array>

interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void
  terminate(): void
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  addEventListener(type: 'error', listener: (event: Event) => void): void
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  removeEventListener(type: 'error', listener: (event: Event) => void): void
}

export type ScryptWorkerFactory = () => WorkerLike

let nextRequestId = 1

export function createDefaultScryptWorker(): WorkerLike {
  if (typeof Worker === 'undefined') {
    throw new Error('Aurora WebRTC scrypt requires a browser/WebView Worker or an injected deriver')
  }
  return new Worker(new URL('./crypto-worker.js', import.meta.url), { type: 'module' })
}

export function deriveScryptInWorker(
  password: Uint8Array,
  salt: Uint8Array,
  options: { signal?: AbortSignal; workerFactory?: ScryptWorkerFactory } = {}
): Promise<Uint8Array> {
  const worker = (options.workerFactory ?? createDefaultScryptWorker)()
  const requestId = nextRequestId
  nextRequestId += 1
  const passwordCopy = new Uint8Array(password)
  const saltCopy = new Uint8Array(salt)

  return new Promise<Uint8Array>((resolve, reject) => {
    let settled = false

    const cleanup = (): void => {
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onError)
      options.signal?.removeEventListener('abort', onAbort)
      worker.terminate()
      zeroBytes(passwordCopy)
      zeroBytes(saltCopy)
    }

    const finish = (callback: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      callback()
    }

    const onMessage = (event: MessageEvent): void => {
      const data = event.data as { id?: number; type?: string; key?: Uint8Array; error?: string }
      if (data.id !== requestId) {
        return
      }
      if (data.type === 'scrypt:result' && data.key instanceof Uint8Array) {
        const key = new Uint8Array(data.key)
        finish(() => resolve(key))
        return
      }
      finish(() => reject(new Error(data.error ?? 'scrypt worker failed')))
    }

    const onError = (): void => {
      finish(() => reject(new Error('scrypt worker error')))
    }

    const onAbort = (): void => {
      finish(() => reject(new DOMException('Scrypt derivation aborted', 'AbortError')))
    }

    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onError)
    options.signal?.addEventListener('abort', onAbort, { once: true })

    if (options.signal?.aborted === true) {
      onAbort()
      return
    }

    worker.postMessage(
      { id: requestId, type: 'scrypt', password: passwordCopy, salt: saltCopy, params: AURORA_SCRYPT_PARAMS },
      [passwordCopy.buffer, saltCopy.buffer]
    )
  })
}
