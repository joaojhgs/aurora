# V881 private source preparation

This candidate is source-only and not launchable. It combines the approved V869 exact-peer MeshBus TTS requester with the V868 read-only nominated-pair snapshot observer, and statically pins the V737 Python `.pth` resolution and the actual `aiortc`/`aioice` source selected through that path. Root must still independently freeze the current source, models, config, authorized peer/session, receiver identity/provider, resources, and actual runtime evidence before any launch.

The observer callback now validates and copies a bounded allowlisted row and calls `put_nowait`; JSON serialization and file writes occur on the private bounded writer thread. The 15-warmup proof requires complete observer rows joined by exact request correlation and peer/session/PC hashes to the receiver's actual native TTS proof. It records only before/after nominated-pair snapshots; no pair identity or continuous route stability is established. Any missing or lossy observation prevents measured request 1.

Validation was static only: Python AST parsing passed for all 11 requester `.py` files, and JSON parsing passed for the candidate, runtime pins, and freeze template. No Aurora/RTC imports, tests, services, models, network, device, or runtime were run.

## Final source pins

| File | SHA-256 |
|---|---|
| `requester/runner.py` | `7cae2d9aa8b2bb36775ed6f6ec2131a8caa819dd2c0fd1531972308a0c629125` |
| `requester/controller.py` | `54c79dff9eabedb28370c9801dd7150d209d130886338e9bf578ac2628d51044` |
| `requester/bootstrap.py` | `cb40f036566274ae4eff290a78a6124e4d9270189a0d31d3cce06fe9092e2537` |
| `requester/receiver_proof.py` | `7fa0d9c99273ee53c253e464a86b786d476ecfd302a36e8b07b80a891c505683` |
| `requester/route_observation_sink.py` | `2b235781c15410e6dbfc8829971a34e8334714cdf015053edfd127756325cfb8` |
| `requester/mesh_route_observer.py` | `2c23fd2bc69b00b746c2c5dc28c1d2b77428016314045363dceea5fe9ee5cdbb` |
| `requester/route_runtime_pins.json` | `529eb82badbb088b8e34e5a11c9a1c9fa7189134a20106d6fdadf5d99e1aabed` |
| `requester/freeze-template.json` | `c14974d959d7c8b8d10ca2667046c75d9b3ba3075d8d5ab0e93a679cf9dad432` |

The freeze template deliberately remains `template_only_not_launchable` with source equivalence and runtime/peer/receiver admissions unset. V880 establishes static package-path provenance only; the ordinary warmups must verify loaded runtime modules and actual selected-route/receiver joins.


## V890 narrow V887 closure

Original Root copied V881 without modifying it. After the existing static .pth/source checks, bootstrap explicitly imports the three pinned aiortc/aioice modules before checking their actual resolved source paths and installing the observer. The receiver proof now requires both actual PeerBridge call-row PIDs to equal the observation requester PID before comparing same-clock intervals. Only these two source fixes and dependent freeze pins changed. AST-only source parsing passed; no candidate/dependency import, runtime, model, test or network operation. Existing V881 and V887 findings remain retained; live route/peer/resource/native-warmup admission is still future.
