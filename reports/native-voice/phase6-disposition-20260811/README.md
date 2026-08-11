# Phase 6 candidate disposition and resource verification

Recorded: 2026-08-11T23:48:49Z

Verdict: **disposition-verified and partial-withheld**.

This receipt reconciles the Phase 6 candidate packs without promoting a
production speech capability. VAD, KWS, and STT remain Linux x86_64 validation
candidates under non-production trust. TTS has no selectable pack. No release
index or production pack is approved, every candidate remains
`interoperable: false`, and production VAD/KWS/STT/TTS stay false.

The dependency may advance to Phase 7 only with those restrictions intact.
Phase 6 itself is not implementation-complete and no release, mobile, physical
device, or production-quality claim is made.

## Fresh results

- Candidate signatures, immutable file/operator/tokenizer inventories, language
  scope, platform scope, and fail-closed release disposition passed their
  focused Python and Rust tests.
- Native and browser VAD parity, browser Worker execution, model-pack
  selection, cancellation, and stale-generation protection passed the bounded
  current-source test matrix.
- PocketTTS, Piper/espeak, and Supertonic 3 remain blocked for production TTS;
  no fallback pack is silently substituted.
- The first resource run exposed a measurement defect: `/usr/bin/time` wrapped
  a cold `cargo test`, so compiler/linker RSS was attributed to VAD. Commit
  `7372d0fe` now builds each exact test executable outside the timed interval
  and measures the executable directly. The manifest budgets were not raised.
- The corrected three-repetition Linux run passed every declared memory and
  RTF ceiling:

  | Task | Maximum RSS | Memory ceiling | Maximum RTF ms/s | RTF ceiling |
  | --- | ---: | ---: | ---: | ---: |
  | VAD | 40,902,656 | 67,108,864 | 12.056 | 1,000 |
  | KWS | 57,057,280 | 201,326,592 | 200.702 | 1,000 |
  | STT | 149,811,200 | 402,653,184 | 114.432 | 1,000 |

The raw redacted report remains under the ignored Phase 4 artifact root at
`.artifacts/pockettts/p4-native-voice/reports/phase6-native-resources-20260811.json`.
Its SHA-256 is
`f9a8222e898a40e930107656d858392a10baf16952f2d3de02beef2214e4d3f2`.

## Canonical commands

```bash
uv run pytest \
  tests/unit/tools/test_phase6_capability_disposition.py \
  tests/unit/tools/test_phase6_native_resources.py -q

uv run python tools/voice-runtime/resource-metrics/run_phase6_native_resources.py \
  --artifact-root .artifacts/pockettts/p4-native-voice \
  --task vad --task kws --task stt \
  --repetitions 3 --timeout-seconds 300 \
  --output .artifacts/pockettts/p4-native-voice/reports/phase6-native-resources-20260811.json

cargo +1.88.0 test --locked --manifest-path rust/Cargo.toml \
  -p aurora-voice-native --test candidate_model_packs
cargo +1.88.0 test --locked --manifest-path rust/Cargo.toml \
  -p aurora-voice-engine model_pack --lib
cargo +1.88.0 test --locked --manifest-path rust/Cargo.toml \
  -p aurora-voice-wasm cancel --lib
pnpm --filter @aurora/voice-web test
```

`summary.json` contains the machine-readable adjudication. `checksums.sha256`
binds it to the canonical disposition, trust, candidate inventories, resource
harness, and raw resource report used for this decision.
