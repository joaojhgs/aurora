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
| P0.10 Raven runtime benchmark gate | Prepared only | `raven_gate.py benchmark` validates first-audio, RTF, memory, download, cancellation, evidence kind, source commit, artifact hash, runtime, device, and thermal provenance. Fixture/synthetic reports return schema-only/non-release status. No real browser/mobile/thermal claim was made because no live model runtime/device evidence was available in this lane. |
| P0.17 upstream and sibling provenance | Pinned | `pinned_raven_manifest.json` records exact upstream, Kyutai, ONNX mirror, sibling revisions, and license/source roles. |
| P0.18 English compact conversion | Reproduced in ignored artifacts | The pinned Raven `tools/prepare_models.sh --web` path completed from immutable hash-checked English inputs. It verified AR delta-KV exact equivalence, decoder delta-KV exact equivalence, produced optimized native/web graphs, and precompressed the web model/runtime set. |
| P0.19 Portuguese compact conversion | Blocked in converter | The pinned community mirror exposes a `portuguese` candidate with 18 flow state entries / 6 layers. Running Raven's documented script with `BUNDLE_URL=.../onnx/portuguese` fails at `tokenizer.model` because `prepare_models.sh` hard-codes the English tokenizer SHA. Candidate tokenizer SHA-256: `3aa51309c55f114771c156aaeb86f6fc325991364aa3c38af74aecf1cbd0fade`; candidate bundle metadata SHA-256: `389ab9d942f044a6a71d04e86ba89b100dee21ed91ca9d099b19ac45b122d242`. |
| P0.20 `french_24l` conversion | Blocked in converter | The pinned community mirror exposes a `french_24l` candidate with 72 flow state entries / 24 layers, explicitly not compact. Running Raven's documented script with `BUNDLE_URL=.../onnx/french_24l` fails at `tokenizer.model` because `prepare_models.sh` hard-codes the English tokenizer SHA. Candidate tokenizer SHA-256: `521c85bdb2da10618f4be52021ed1cb2a7a6299b040708487f133193f7b305e2`; candidate bundle metadata SHA-256: `8a5fe6c59985e3ccb5a6ccb1ffb2e84ac08488c5bfa704053618851436741427`. Runtime/exporter work remains required for layer-count independence before French local support claims. |
| P0.23 sibling clone boundary | Recorded | Sibling lacks checked-in `public/assistant/pocket-tts/src/encode-worker.js`; reusable runtime patches are separated from rejected clone/model/cache shortcuts. |
| P0.24 decisions/revisions/hashes | Recorded | Source revisions live in the manifest; generated reports are produced under ignored artifacts. |

## Static assumptions requiring production fixes

- Single English bundle URL and static `spm_vocab.json` must become
  manifest-selected per language pack.
- `prepare_models.sh` pins English hashes in `BUNDLE_FILES`; non-English
  candidate conversion fails immediately at tokenizer hash verification.
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

Expected status for the prepared ignored upstream checkout: `ready-for-real-conversion`.
