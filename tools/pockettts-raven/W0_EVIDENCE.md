# W0 Raven conversion evidence ledger

Scope: P0.10, P0.17, P0.18, P0.19, P0.20, P0.23, and P0.24 for the
PocketTTS-Raven spike. Generated JSON reports belong under ignored
`.artifacts/pockettts/w0-raven/**` and are not canonical docs.

## Pinned sources

- PocketTTS-Raven upstream: `https://github.com/pkalogiros/pocket-tts-raven`
  at `abd26158ab50f954616eaf42296b09c4856489d7`, MIT runtime license.
- Kyutai PocketTTS official source: `https://github.com/kyutai-labs/pocket-tts`
  tag `v2.1.0` at `058886528d0b6f2f2d4022de2e244a5260729e6e`.
- Community ONNX mirror, candidate only: `https://huggingface.co/KevinAHM/pocket-tts-onnx`
  at `58a6d00cf13d239b6748cb0769f35c580a8f606c`.
- Sibling prototype, read-only: `/home/developer/projects/sperandiodev`
  at `7342bb0fbe2af04b66b6e54c17b4ac8f765eb989`.
- Plan hash verified before work: `75eb81a4c0aaf5fb42a27f9c7862ca8b615b556cd324ebcc702b506c514b6f56`.

## Reproduced matrix

| Item | Status | Evidence/disposition |
| --- | --- | --- |
| P0.10 Raven runtime benchmark gate | Prepared only | `raven_gate.py benchmark` validates first-audio, RTF, memory, download, and cancellation report shape. No real browser/mobile/thermal claim was made because no live model runtime/device evidence was available in this lane. |
| P0.17 upstream and sibling provenance | Pinned | `pinned_raven_manifest.json` records exact upstream, Kyutai, ONNX mirror, sibling revisions, and license/source roles. |
| P0.18 English compact conversion | Blocked before conversion | English source asset hashes are pinned, but source assets were not present under `.artifacts/pockettts/w0-raven/source-assets/english_2026-04`. The verifier reports first missing asset instead of claiming reproduction. |
| P0.19 Portuguese compact conversion | Blocked before conversion | Immutable Portuguese asset hashes are intentionally `TBD:*`; release requires official Kyutai export or reviewed hash-pinned ONNX input before conversion/equivalence. |
| P0.20 `french_24l` conversion | Blocked before conversion | Manifest records 24 layers and 72 state slots, explicitly `claims_compact: false`. Runtime/exporter work remains required for layer-count independence before French local support claims. |
| P0.23 sibling clone boundary | Recorded | Sibling lacks checked-in `public/assistant/pocket-tts/src/encode-worker.js`; reusable runtime patches are separated from rejected clone/model/cache shortcuts. |
| P0.24 decisions/revisions/hashes | Recorded | Source revisions live in the manifest; generated reports are produced under ignored artifacts. |

## Static assumptions requiring production fixes

- Single English bundle URL and static `spm_vocab.json` must become
  manifest-selected per language pack.
- `modelSet(lsdSteps)` and fixed graph filenames must become
  `(languageBundleId, qualityTier, memoryClass)` pack selection.
- Six-layer state shape assumptions must be derived from ONNX graph/config;
  24-layer packs require 72 AR state entries rather than 18.
- The fused ConvTranspose decoder remains rejected until independently
  verified; use the plain int8 decoder path for this plan.
- Voice presets such as `joao.emb` are prototype-only and not Aurora standard
  voices.
- Clone creation cannot rely on the sibling prototype because its disposable
  encoder worker is absent from the checked-in runtime.

## First-failure commands

```bash
python tools/pockettts-raven/raven_gate.py conversion \
  --manifest tests/fixtures/local_speech/raven/pinned_raven_manifest.json \
  --pack english_2026-04 --dry-run
```

Expected status without source assets: `blocked`, first failure
`.artifacts/pockettts/w0-raven/source-assets/english_2026-04/tokenizer.model`
missing.
