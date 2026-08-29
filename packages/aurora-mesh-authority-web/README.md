# `@aurora/mesh-authority-web`

The WebAssembly host boundary for the Aurora mesh peer authority — the web half
of workstream **R2**.

The authority itself is Rust (`rust/crates/aurora-mesh-authority`). This package
loads its `wasm-bindgen` bindings and presents them as the
`PeerHostAuthorizationStore` seam the peer host already asks through, so calling
code changes its construction and nothing else. The same Rust core answers every
permission question on native through Tauri IPC. There is no third
implementation — two authorities is drift in the one layer where drift is a
vulnerability.

## Build

```bash
pnpm --filter @aurora/mesh-authority-web run build
```

`build:wasm` follows the `@aurora/voice-web` precedent exactly: a pinned
`cargo +1.88.0 build --locked --target wasm32-unknown-unknown --release`, an
assertion that `wasm-bindgen` is exactly `0.2.126`, then
`wasm-bindgen --target web`, then artifact validation. The `.wasm` ceiling is
1 MiB rather than voice-web's 320 KiB because the authority links
`aurora-contracts`, which embeds every generated JSON Schema and its validator so
execution policy can be answered without a round trip.

## Test

```bash
pnpm --filter @aurora/mesh-authority-web run build:wasm
pnpm --filter @aurora/mesh-authority-web test
```

`tests/wasm-authority-parity.test.ts` drives the **compiled** bindings from
`tests/fixtures/mesh_authority_parity_vectors.json` — the same corpus the Rust
tests and the TypeScript SDK tests run from. Compiling for
`wasm32-unknown-unknown` proves nothing on its own; answering the corpus through
real bindings does.

## Loading

`src/` uses no Node built-ins. The browser default lets the generated loader
fetch its own `.wasm` beside the JS:

```ts
const authority = await WasmPeerHostAuthorizationStore.create()
```

A Node harness cannot `fetch` a `file:` URL, so it injects a source:

```ts
const authority = await WasmPeerHostAuthorizationStore.create({
  importBindings: async () => await import('.../dist/wasm/aurora_mesh_authority.js'),
  wasmBytes: async () => readFileSync('.../dist/wasm/aurora_mesh_authority_bg.wasm')
})
```

## What crosses this boundary

Decisions, never storage. TypeScript hydrates the authority at session start
from the durable adapters it already owns
(`peer-host/local-data-authority-adapters.ts`), and the authority answers
permission questions. Encryption at rest and IndexedDB stay where they are.

Per the R0 boundary note (`docs/mesh/NATIVE-TYPESCRIPT-BOUNDARY.md` §1) this is
the *authority store* and not a session registry: keyed by peer identity, no
transport state, and it never learns which connection a peer arrived on.
