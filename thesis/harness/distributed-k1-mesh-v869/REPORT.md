# Distributed K1 mesh source correction V869

This is a fresh private copy of V861; V861 remains unchanged. Only the two findings in the bounded V866 review were corrected.

The mesh adapter now checks a failed returned `QueryResult` for the exact finite `PeerBridge.call` timeout string constructed from the already selected peer ID and the timeout passed to the call. It performs this check before validating the generic route-outcome row, whose expected outcome is `failed` for that same timeout. A match becomes the finite category `remote_peer_timeout`; the existing runner converts that into a fatal TTS failure, counts it in the timeout denominator, and stops without retry. The raw result error is compared in memory only and is never copied to an attempt or diagnostic record. Other failed or ambiguous results retain the existing fail-closed behavior.

The proof command now points `--requester-mesh-calls` at `<private-requester-output-parent>/requester-mesh-calls.jsonl`, matching the existing writer. `bindings.py` writes beside the configured `voice-stages.jsonl`; the controller configures that stage file as `<private-requester-output-parent>/voice-stages.jsonl`. The attempts directory remains `<private-requester-output>/attempts`.

## Changed-file hashes

| File | SHA-256 |
|---|---|
| `requester/tts_mesh_adapter.py` | `1db8cb386a37c680bec6e03135ee007f6b76a850a85c4e1eedda6562c0895ceb` |
| `requester/freeze-template.json` | `2c5d5c35d034de813890d2637b067adff17ae541b072c3ee07c680407b4be1ee` |
| `README.md` | `8e50aae1678a12bf5d7df74433981b5de89a9f946055ecee5a5f67e179b85e97` |

The runner, bindings, controller, proof helper, provider observer, models, workload, limits and existing authority guards are byte-identical to V861. The adapter hash in the freeze template is updated to match this candidate.

## Validation and boundary

`tts_mesh_adapter.py` passed a standard-library AST parse. Root should verify the JSON and all copied frozen-source pins when integrating. No test, Aurora import, runtime, service, model, network, device, build or RTC call was performed. This remains unlaunched source preparation; actual peer/session/grant, receiver identity, selected route and the 15-record receiver warmup proof remain Root admission requirements. The change corrects timeout accounting and the documented artifact path; it does not establish route readiness or runtime success.
