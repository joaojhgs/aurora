# Sherpa PocketTTS language packs

This directory converts official Kyutai PocketTTS language families into
Sherpa-compatible packs. It does not change the Python PocketTTS provider.

Weights, ONNX graphs, WAVs, and archives stay under `.artifacts/` and must not
be committed. Conversion clones
`csukuangfj/pocket-tts-onnx-export` @
`f075c00bf4bbfbb081a11fd99abbf39df3849e0c` and stages a clean helper copy
under `.artifacts/` before patching. Archives use sorted members and
normalized tar metadata so the SHA is independent of local mtimes.

## Packs

| Pack | Language | Kyutai config | Source | Mode |
| --- | --- | --- | --- | --- |
| `aurora-pockettts-en-2026-04` | English | `english_2026-04` | `kyutai/pocket-tts-without-voice-cloning` @ `e041936c` (CC-BY-4.0) | `internal` |
| `aurora-pockettts-fr-24l` | French | `french_24l` | `kyutai/pocket-tts-without-voice-cloning` @ `e041936c` (CC-BY-4.0) | `internal` |

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
