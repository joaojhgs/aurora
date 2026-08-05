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
| P0.10 Raven runtime benchmark gate | Prepared only | `raven_gate.py benchmark` validates first-audio, RTF, memory, download, cancellation, evidence kind, source commit, artifact hash, runtime, device, and thermal provenance. Fixture/synthetic reports return schema-only/non-release status. No real browser/mobile/thermal claim was made because no live model runtime/device evidence was available in this lane. |
| P0.17 upstream and sibling provenance | Pinned | `pinned_raven_manifest.json` records exact upstream, Kyutai, ONNX mirror, sibling revisions, and license/source roles. |
| P0.18 English compact conversion | Reproduced in ignored artifacts | The pinned Raven `tools/prepare_models.sh --web` path completed from immutable hash-checked English inputs. It verified AR delta-KV exact equivalence, decoder delta-KV exact equivalence, produced optimized native/web graphs, and precompressed the web model/runtime set. |
| P0.19 Portuguese compact conversion | Candidate reproduced in ignored artifacts | The pinned community mirror exposes a `portuguese` candidate with 18 AR state inputs / 6 graph layers. A temporary ignored Raven patch parameterized `BUNDLE_FILES` from a local JSON hash manifest (`prepare_models.sh` diff SHA-256 `3bb09aea97bd61ed936c1e14406fe3e0bcc7cc08ca3409db6a9cd642e3670636`). `./tools/prepare_models.sh --web` then verified AR delta-KV exact equivalence, replaced 6 AttentionTail nodes, verified decoder delta-KV exact equivalence, and wrote native plus web graphs. Optional Brotli precompression was interrupted after graph generation. Candidate input manifest SHA-256: `24ba974c07baf2e83be2c335848ef8b0382809cec8846a72af041f752081356a`; observed output-hash report SHA-256: `37b0feb8fae5061ce4d302439964520249a2ad6cba40de408cf0bc5ffc455315`. This is candidate evidence, not official release proof. |
| P0.20 `french_24l` conversion | Candidate native reproduced in ignored artifacts | The pinned community mirror exposes a `french_24l` candidate with 72 AR state inputs / 24 graph layers and it remains explicitly not compact. The same temporary ignored Raven patch (`3bb09aea97bd61ed936c1e14406fe3e0bcc7cc08ca3409db6a9cd642e3670636`) let `./tools/prepare_models.sh` verify AR delta-KV exact equivalence with 24 cache states, verify decoder delta-KV exact equivalence, and write native graphs. The AR AttentionTail step still reported only 6 replaced tails despite the 24-layer graph, so web/runtime support and custom-op coverage remain unresolved. Candidate input manifest SHA-256: `0989ad6b47bccbc20a6a861e7078122772edf2d2038aaaf1c76582b0f5ae1fdd`; observed output-hash report SHA-256: `ff0c187e65e1ad923b963071b0c01d31a557d76ffee3af2bae8e27d45d3deb40`. |
| P0.23 sibling clone boundary | Recorded | Sibling lacks checked-in `public/assistant/pocket-tts/src/encode-worker.js`; reusable runtime patches are separated from rejected clone/model/cache shortcuts. |
| P0.24 decisions/revisions/hashes | Recorded | Source revisions live in the manifest; generated reports are produced under ignored artifacts. |

## Static assumptions requiring production fixes

- Single English bundle URL and static `spm_vocab.json` must become
  manifest-selected per language pack; no candidate Portuguese/French
  `spm_vocab.json` was observed, so both vocab entries remain TBD.
- `prepare_models.sh` pins English hashes in `BUNDLE_FILES`; a temporary
  ignored patch parameterized those hashes for conversion evidence only.
- `modelSet(lsdSteps)` and fixed graph filenames must become
  `(languageBundleId, qualityTier, memoryClass)` pack selection.
- Six-layer state shape assumptions must be derived from ONNX graph/config;
  24-layer packs require 72 AR state entries rather than 18.
- French native conversion discovered 24 graph layers / 72 AR states, but the
  current `make_attention_tail_custom_onnx.py` pass still replaced only 6
  AttentionTail nodes. Custom-op coverage must be graph-derived before any
  24-layer runtime claim.
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
