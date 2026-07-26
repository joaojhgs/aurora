import { scryptAsync } from '@noble/hashes/scrypt.js'

interface ScryptRequest {
  id: number
  type: 'scrypt'
  password: Uint8Array
  salt: Uint8Array
  params: { N: number; r: number; p: number; dkLen: number }
}

interface ScryptSuccess {
  id: number
  type: 'scrypt:result'
  key: Uint8Array
}

interface ScryptFailure {
  id: number
  type: 'scrypt:error'
  error: string
}

interface WorkerScopeLike {
  addEventListener(type: 'message', listener: (event: MessageEvent<ScryptRequest>) => void): void
  postMessage(message: unknown, transfer?: Transferable[]): void
}

function assertExactParams(params: ScryptRequest['params']): void {
  if (params.N !== 65_536 || params.r !== 8 || params.p !== 1 || params.dkLen !== 32) {
    throw new Error('Unsupported Aurora WebRTC scrypt parameters')
  }
}

const workerScope = self as unknown as WorkerScopeLike

workerScope.addEventListener('message', (event: MessageEvent<ScryptRequest>) => {
  const request = event.data
  if (request?.type !== 'scrypt') {
    return
  }
  void (async () => {
    try {
      assertExactParams(request.params)
      const key = await scryptAsync(request.password, request.salt, {
        N: request.params.N,
        r: request.params.r,
        p: request.params.p,
        dkLen: request.params.dkLen
      })
      const response: ScryptSuccess = { id: request.id, type: 'scrypt:result', key }
      workerScope.postMessage(response, [key.buffer])
    } catch (error) {
      const response: ScryptFailure = {
        id: request.id,
        type: 'scrypt:error',
        error: error instanceof Error ? error.message : 'scrypt failed'
      }
      workerScope.postMessage(response)
    } finally {
      request.password.fill(0)
    }
  })()
})
