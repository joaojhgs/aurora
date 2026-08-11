# Phase 5 native voice foundation re-verification

Recorded: 2026-08-11T23:27:50Z

Verdict: **pass for the bounded Phase 5 shared-foundation exit gate**.

This receipt closes the Rust workspace, generated-contract, ownership/state,
model-store, WASM-core, and fake UI-detached turn foundation. It does not claim
live desktop audio, physical-device behavior, Apple compilation or signing,
release packaging, a production speech pack, or PocketTTS/Piper activation.

## Fresh results

- Rust `1.88.0` formatting and clippy with warnings denied passed. The locked
  all-target workspace suite passed 313 tests; the opt-in live Linux CPAL test
  remained intentionally ignored.
- The `aurora-voice-wasm` suite executed on `wasm32-unknown-unknown` and passed
  31 tests.
- `make check-sdk-backend-contracts` passed. A second explicit generator run
  left all 73 scoped generated files byte-identical; the before/after hash
  manifest digest was
  `1459c5680734ad50ed4011b3c7876df84d95073a9c96773b82f6def29e6d03e0`.
- Focused ownership, interrupted-install, corruption, revocation, PTT, wake,
  and background-lease tests passed 8 of 8.
- The production Worker/WASM build passed 35 Playwright cases across Chromium,
  Firefox, WebKit, Android Chrome emulation, and Mobile Safari emulation. Two
  foreground real-browser-API cases and 83 focused runtime/model-store/worker
  tests also passed.
- One broader browser model-store run hit a WebKit setup timeout. The exact
  failed case passed on its isolated rerun, so it is recorded as a harness
  flake rather than hidden or promoted as additional coverage.
- Independent verification returned PASS for every Phase 5 exit clause.

## Canonical commands

```bash
cargo +1.88.0 fmt --manifest-path rust/Cargo.toml --all -- --check
cargo +1.88.0 clippy --manifest-path rust/Cargo.toml \
  --locked --workspace --all-targets -- -D warnings
cargo +1.88.0 test --manifest-path rust/Cargo.toml \
  --locked --workspace --all-targets

cd rust
cargo +1.88.0 test --locked -p aurora-voice-wasm \
  --target wasm32-unknown-unknown

cd ..
make check-sdk-backend-contracts
pnpm --filter @aurora/voice-web test:browser:voice
```

The machine-readable adjudication is in `summary.json`. `checksums.sha256`
binds the receipt to the tested Rust sources, generated Rust contracts, and
ignored production Worker/WASM outputs present at verification time.
