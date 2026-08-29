// Minimal ambient declarations for the Node built-ins this package's *tests*
// use. `src/` deliberately uses none: this is a web package, and the loader
// takes its bindings as an injected source precisely so the browser path stays
// free of Node. Mirrors `packages/aurora-sdk/tests/node-lite.d.ts`.

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string
  export function readFileSync(path: string): Uint8Array
}

declare module 'node:path' {
  export function resolve(...paths: string[]): string
}

declare const process: { cwd(): string }
