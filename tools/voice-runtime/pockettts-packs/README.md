# Sherpa PocketTTS language packs

This directory converts official Kyutai PocketTTS language families into
Sherpa-compatible packs. It does not change the Python PocketTTS provider.

Weights, ONNX graphs, WAVs, and archives stay under `.artifacts/` and must not
be committed.

## Packs

| Pack | Language | Kyutai config | Protocol |
| --- | --- | --- | --- |
| `aurora-pockettts-en-2026-04` | English | `english_2026-04` | `bos_before_voice`, empty KV seq 0 |
| `aurora-pockettts-fr-24l` | French | `french_24l` | `bos_before_voice`, 24 layers, `frames_after_eos=8` |

## Convert

```bash
uv run python tools/voice-runtime/pockettts-packs/convert_language_pack.py \
  --pack aurora-pockettts-en-2026-04 --json
uv run python tools/voice-runtime/pockettts-packs/convert_language_pack.py \
  --pack aurora-pockettts-fr-24l --json
```

Graph rewrites are identity elimination and initializer dedup only. Raven
custom operators are not used.

## Temporary release publisher

`.github/workflows/sherpa-pockettts-language-packs.yml` is dispatch/release
only. After GitHub release URLs exist, delete the convert job and point the
on-demand catalog at those URLs.
