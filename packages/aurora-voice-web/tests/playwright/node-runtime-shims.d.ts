declare const process: {
  readonly cwd: () => string
  readonly env: Record<string, string | undefined>
}

declare const Buffer: {
  readonly isBuffer: (value: unknown) => boolean
  readonly from: (value: string) => Uint8Array
}

interface ImportMeta {
  readonly dirname: string
}

declare module 'node:fs/promises' {
  export function readFile(path: string): Promise<Uint8Array>
}

declare module 'node:crypto' {
  export interface Hash {
    update(value: string | Uint8Array): this
    digest(encoding: 'hex'): string
  }

  export function createHash(algorithm: 'sha256'): Hash
}

declare module 'node:fs' {
  export function existsSync(path: string): boolean
  export function readFileSync(path: string, encoding: 'utf8'): string
}

declare module 'node:http' {
  export interface IncomingMessage {
    readonly url?: string
  }

  export interface ServerResponse {
    writeHead(statusCode: number, headers?: Record<string, string>): this
    end(chunk?: string | Uint8Array): this
  }

  export interface AddressInfo {
    readonly port: number
  }

  export interface Server {
    once(event: 'error', listener: (error: Error) => void): this
    listen(port: number, hostname: string, listener: () => void): this
    address(): AddressInfo | string | null
    close(callback: (error?: Error) => void): this
  }

  export function createServer(
    listener: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  ): Server
}

declare module 'node:os' {
  export function tmpdir(): string
}

declare module 'node:path' {
  export const sep: string
  export function extname(path: string): string
  export function join(...paths: readonly string[]): string
  export function normalize(path: string): string
  export function relative(from: string, to: string): string
  export function resolve(...paths: readonly string[]): string
}

interface FileSystemDirectoryHandle {
  keys?: () => AsyncIterable<string>
}
