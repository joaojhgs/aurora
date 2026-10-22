# V852 K2 controller integration correction

V852 is a private copy of the reviewed K2 bundle V847. It makes the three
connected source-integration corrections from the immutable V850 review:

1. The controller binds the actual staged `stage_adapter.py` file, not the
   nonexistent `tts_http_adapter.py` name.
2. The controller validates the same exact `remoteReceivers` object used by
   the K2 runner: exactly `assistant` and `tts`. It no longer requires the
   obsolete single `remoteTtsReceiver` field.
3. Both controller and runner independently verify the sibling
   `k2_composition.py` against the frozen `implementation.k2CompositionSha256`
   value. The controller passes the verified hash to the runner; README
   documents the frozen field.

V847's accepted LocalBus STT route-label check, Assistant V430 span-ID
semantics, TTS native operation/attempt requirements, and partial-quality
accounting are preserved. V847 and its review remain unchanged. This is
source-only and not a launch or acceptance result.

Python AST parsing passed for all ten Python files in this private bundle. No
imports, tests, services, models, endpoints, network, build, device, or
campaign work was run.

Key SHA-256 values:

| File | SHA-256 |
|---|---|
| `controller.py` | `809bec19682eb717f016d2b9f62453b38945201c561f7d4f4ac72e242024050e` |
| `runner.py` | `1f869903b4a2c5167707891bd1d32294329c5673b7386c60b4f13400c4efba06` |
| `k2_composition.py` | `08be1fa730d6e49ccf4bd491539b4b8edb5b3476eb7f8f7db9656db5e7b3a053` |
| `stage_adapter.py` | `204ea4d6b48571ab7ba0add0310a3dadd87b5e1e2afdc172634185755c9bb02c` |
| `bootstrap.py` | `6a8d7827bc9f0939e63e4f911868a178f5ba4c73bcf3aa878d50cd74895ed531` |
| `receiver_proof.py` | `06c1bb4aeae3ba8f2de7441bd09ccfc39d426615defd5b8a38b807117df4d791` |
| `README.md` | `b54e4885f8a9200fb118716f62ff65fa08f1be074848941f81768b9ce6f554e1` |

The bundle is not launch-ready. Root still needs a current source-closed
cohort manifest, independently admitted endpoints/auth binding, actual remote
receiver identities and retained warmup evidence, plus fresh resource and
lock admission.
