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
- Sibling prototype, read-only: `~/projects/sperandiodev`
  at `7342bb0fbe2af04b66b6e54c17b4ac8f765eb989`.
- Plan hash verified before work: `75eb81a4c0aaf5fb42a27f9c7862ca8b615b556cd324ebcc702b506c514b6f56`.

## Reproduced matrix

| Item | Status | Evidence/disposition |
| --- | --- | --- |
| P0.10 Raven runtime benchmark gate | Fail-closed | `raven_gate.py manifest` now separates hash-pinned candidate inputs from release readiness; the manifest stays `hash-pinned-candidate-blocked` until official provenance, license review, equivalence, browser, mobile, thermal, and cancellation gates pass. `raven_gate.py benchmark` validates first-audio, RTF, memory, download, cancellation, evidence kind, source commit, artifact hash, runtime, device, and thermal provenance. Fixture/synthetic reports return schema-only/non-release status. Candidate Node/WASM smokes produced first-audio and memory numbers for Portuguese/French, but remain non-release evidence because they are not browser/mobile measurements, thermal state was not measured, and cancellation did not prove stale-audio suppression. |
| P0.17 upstream and sibling provenance | Pinned | `pinned_raven_manifest.json` records exact upstream, Kyutai, ONNX mirror, sibling revisions, and license/source roles. |
| P0.18 English compact conversion | Reproduced in ignored artifacts | The pinned Raven `tools/prepare_models.sh --web` path completed from immutable hash-checked English inputs. The manifest now uses the exact Hugging Face revision `58a6d00cf13d239b6748cb0769f35c580a8f606c`; mutable `/resolve/main/` or non-commit source URLs are rejected by gate tests. It verified AR delta-KV exact equivalence, decoder delta-KV exact equivalence, produced optimized native/web graphs, and precompressed the web model/runtime set. |
| P0.19 Portuguese compact conversion | Candidate reproduced in ignored artifacts | The pinned community mirror exposes a `portuguese` candidate with 18 AR state inputs / 6 graph layers. A temporary ignored Raven patch parameterized `BUNDLE_FILES` from a local JSON hash manifest (`prepare_models.sh` diff SHA-256 `3bb09aea97bd61ed936c1e14406fe3e0bcc7cc08ca3409db6a9cd642e3670636`). `./tools/prepare_models.sh --web` then verified AR delta-KV exact equivalence, replaced 6 AttentionTail nodes, verified decoder delta-KV exact equivalence, and wrote native plus web graphs. Optional Brotli precompression was interrupted after graph generation. `spm_vocab.json` was derived reproducibly from the pinned `tokenizer.model` (`3aa51309c55f114771c156aaeb86f6fc325991364aa3c38af74aecf1cbd0fade`) via SentencePiece ModelProto and matched native tokenizer ids/text on 6/6 multilingual Unicode fixtures. Candidate input manifest SHA-256: `24ba974c07baf2e83be2c335848ef8b0382809cec8846a72af041f752081356a`; observed output-hash report SHA-256: `37b0feb8fae5061ce4d302439964520249a2ad6cba40de408cf0bc5ffc455315`. This is candidate evidence, not official release proof. |
| P0.20 `french_24l` conversion | Candidate web reproduced in ignored artifacts | The pinned community mirror exposes a `french_24l` candidate with 72 AR state inputs / 24 graph layers and it remains explicitly not compact. The original Raven script reported only 6 AttentionTail replacements because `make_attention_tail_custom_onnx.py` hard-coded `--layers` default `6` and `prepare_models.sh` did not pass a layer count; this was a tool bug, not shared-tail topology. The tracked patch `tools/pockettts-raven/patches/0001-raven-infer-attention-tail-layers.patch` (`7660b938ea2e44149c774a432bb780aeee79a89694359ebf2a41407bb3088406`) infers contiguous layer ids from graph node names and applies with `git apply --unidiff-zero --whitespace=error-all`. With that patch applied in ignored upstream, `./tools/prepare_models.sh --web` verified AR delta-KV exact equivalence with 24 cache states, replaced 24 AttentionTail nodes, verified decoder delta-KV exact equivalence, and wrote native plus web graphs. Optional Brotli precompression was interrupted after graph generation. `spm_vocab.json` was derived reproducibly from the pinned `tokenizer.model` (`521c85bdb2da10618f4be52021ed1cb2a7a6299b040708487f133193f7b305e2`) via SentencePiece ModelProto and matched native tokenizer ids/text on 7/7 committed Unicode/byte-fallback fixtures. Candidate input manifest SHA-256: `0989ad6b47bccbc20a6a861e7078122772edf2d2038aaaf1c76582b0f5ae1fdd`; 24-tail output-hash report SHA-256: `c84b1a21f640c4c04435d0634131b8f99e5ea37d6cd1a1999cd80ccd6d8da16c`. |
| P0.23 sibling clone boundary | Recorded | Sibling lacks checked-in `public/assistant/pocket-tts/src/encode-worker.js`; reusable runtime patches are separated from rejected clone/model/cache shortcuts. |
| P0.24 decisions/revisions/hashes | Recorded | Source revisions live in the manifest; generated reports are produced under ignored artifacts. |

## Static assumptions requiring production fixes

- Single English bundle URL and static model paths must become
  manifest-selected per language pack. Portuguese/French `spm_vocab.json`
  entries are derived from each pinned tokenizer, not copied from English and
  not claimed as official upstream artifacts.
- `prepare_models.sh` pins English hashes in `BUNDLE_FILES`; a temporary
  ignored patch parameterized those hashes for conversion evidence only.
- `modelSet(lsdSteps)` and fixed graph filenames must become
  `(languageBundleId, qualityTier, memoryClass)` pack selection.
- Six-layer state shape assumptions must be derived from ONNX graph/config;
  24-layer packs require 72 AR state entries rather than 18.
- French conversion requires graph-derived layer counts. The upstream hard-coded
  6-layer AttentionTail default is captured as a tracked patch for reproducible
  candidate conversion; production integration must carry an owned fix.
- Candidate Node/WASM first-audio reports are useful smoke data only. They do
  not satisfy release gates because browser/mobile behavior, thermal state, and
  cancellation stale-audio suppression remain unproven.
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
Expected manifest status before release gates pass:
`hash-pinned-candidate-blocked` with exit code `2`.
