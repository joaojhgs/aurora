declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string
  export function readFileSync(path: string): Uint8Array
}

declare module 'node:path' {
  export function resolve(...paths: string[]): string
}

declare const process: { cwd(): string }
declare const Buffer: {
  from(input: string, encoding: 'utf8'): { toString(encoding: 'base64'): string }
}
