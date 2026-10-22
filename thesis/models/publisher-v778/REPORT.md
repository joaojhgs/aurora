# Model/license provenance lookup V778

**Bounded result.** The exact GGUF artifact maps to the pinned `ggml-org/Qwen3.5-0.8B-GGUF` revision `9447f74101aeb4e93621884dfa36ee8effb8831b`. The Hugging Face revision page declares `apache-2.0`, and its pinned file page lists the retained weight SHA-256 `57d1997790d1744fba5b40a7317df71ea5e2acee28c47e78f0cce39c0703f8cf`. The local receipt pins 563,036,064 bytes and that same digest. This resolves the README's earlier statement that the revision's README lookup returned 404: the README is still unavailable, but the rendered repository metadata at that exact revision independently displays the license tag. The separate exact Qwen base-weight revision used by conversion is not identified in the retained receipt or the page inspected.

The Piper asset maps to the exact retrieval URL at `rhasspy/piper-voices` revision `c10ece1aade47bb51c153c893d14e5bf8e5b7117`; the receipt records successful retrieval, 63,531,379 bytes, and the pinned ONNX digest. The repository is tagged MIT; the checked current `main` page showed commit prefix `c10ece1`, matching the pinned revision prefix, while the artifact file page reports the same SHA. The pinned 517-byte `MODEL_CARD` has SHA-256 `fbee1529c89d36b3fe76d7e9f3f832dce17f44900a52d76a9bda735654766b4d`. It says the **LJSpeech dataset** is public domain and that the voice was trained on that dataset; it does not state a separate ONNX-weight license. The upstream Piper README cautions that individual voice cards contain licensing information and that some voices may have restrictive terms. Accordingly, the repository MIT tag is recorded as publisher repository metadata, but weight-specific scope/attribution is still an explicit confirmation gap. No legal conclusion is made.

Local metadata hashes and timestamps are captured in [publisher-findings.json](publisher-findings.json). The Qwen retrieval record `desktop-model-source-actual-v409.json` is 1,560 bytes, SHA-256 `41ae5316752f04b70ea46acabe720de4fcdd8561348cd9d047556a9cab1e4282`, and timestamps exact-hash retrieval at 2026-10-14 16:34:29 UTC. The Piper `asset-stage.json` is 1,560 bytes, SHA-256 `9b65d9cff9c1567e037410862cd3907ca7a51b7dd2138bd6ba9d51f849013d85`, with staging timestamp 2026-10-15 03:34:55 UTC; the card itself is retained as 517 bytes with the hash above. The current upstream page lookup was performed 2026-10-16 around 01:03 UTC. The web tool supplied rendered page content rather than raw response bytes, so this report does not claim a byte hash for upstream page HTML.

No model weights were read, fetched, or rehashed. No test, backend import, inference, installation, or canonical thesis edit was made. The existing model inventory remains partial; the unresolved voice-weight license scope and Qwen converter's exact upstream base revision should remain open in the canonical package until separately confirmed.

## Upstream records

- [Qwen GGUF repository at pinned revision](https://huggingface.co/ggml-org/Qwen3.5-0.8B-GGUF/tree/9447f74101aeb4e93621884dfa36ee8effb8831b)
- [Qwen Q4_0 file at pinned revision](https://huggingface.co/ggml-org/Qwen3.5-0.8B-GGUF/blob/9447f74101aeb4e93621884dfa36ee8effb8831b/Qwen3.5-0.8B-Q4_0.gguf)
- [Official Qwen3.5-0.8B source model card](https://huggingface.co/Qwen/Qwen3.5-0.8B/tree/main)
- [Piper voices repository](https://huggingface.co/rhasspy/piper-voices/tree/main)
- [Piper LJSpeech medium ONNX file](https://huggingface.co/rhasspy/piper-voices/blob/main/en/en_US/ljspeech/medium/en_US-ljspeech-medium.onnx)
- [Pinned Piper LJSpeech medium voice card](https://huggingface.co/rhasspy/piper-voices/raw/c10ece1aade47bb51c153c893d14e5bf8e5b7117/en/en_US/ljspeech/medium/MODEL_CARD)
- [Piper upstream voice licensing guidance](https://github.com/rhasspy/piper#voices)
