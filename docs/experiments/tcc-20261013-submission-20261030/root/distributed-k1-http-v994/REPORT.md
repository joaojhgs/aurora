# First distributed HTTP TTS condition — V994

Status: **first excluded warmup failed at remote transport; zero measured requests**. Preserve this original attempt. It does not yield measured p90/p95 and does not justify repeating closed individual baselines.

Actual provider startup:2026-10-16T09:47:18.317042Z on personal.skyron-server; controller3561795/startTicks77234677 and receiver3561815/startTicks77234688. TCP listener readiness was observed09:47:55.413027Z. Actual requester startup:09:48:52.941804Z on code-worker; controller3598345/startTicks92259353 and runner3598346/startTicks92259423. The requester ended09:50:15.846352Z, exit1, shutdown completed and both requester owners absent. Provider remained live in the09:53:10 observation; the10:03:52 receiver snapshot is custody evidence, not retirement or warmup acceptance.

Route: controlled fixed WAV → worker CPU accurate STT → worker CPU LLM → authenticated POST http://100.64.0.3:8000/api/TTS/Synthesize → expected desktop PiperCPU TTS. Endpoint and receiver binding were frozen; end-to-end reachability was not established.

| Phase | Planned | Attempted | Correct | Failed | Unattempted |
| --- | ---: | ---: | ---: | ---: | ---: |
| Excluded warmups | 15 | 1 | 0 | 1 | 14 |
| Measured | 900 | 0 | 0 | 0 | 900 |

The single warmup had the correct actual transcript and actual Assistant reply Paris. Caller-boundary STT=6714.001251ms; Assistant=38386.276124ms. Remote TTS failed after2.543579ms with transport_error and null HTTP status. These are one excluded warmup's durations, not performance quantiles. No returned server correlation, valid TTS audio or15-call receiver proof was obtained. Measured p90/p95 remain null; no CPU/GPU, host, phase or incompatible-cohort pooling.

The finite transport diagnosis records worker socket.create_connection((100.64.0.3,8000),3) → ConnectionRefusedError/errno111. Its route is via10.0.2.1 on enp0s6, source10.0.2.123. The worker has no observed Tailnet interface, no tailscale executable on PATH and no matching running daemon. The adapter explicitly disables HTTP proxies and proxy variables were absent. Desktop Orca control remained connected/writable. This is an unresolved product data-plane route, not evidence that the desktop or emulator is absent, and not a model-quality failure.

The next required capability is an existing approved worker-reachable Gateway origin or supported existing SSH/Orca TCP forwarding path to this same authorized target. The installed Orca296-command schema exposes no TCP-forward command; host-list authority is owning-host scoped. Root requested exact existing capability through the original monitor; no credentials, accounts, grants, firewall, Tailnet or access configuration were changed. Do not blindly replay this frozen attempt. Only the affected distributed cell may receive a separately versioned replacement after actual route admission, with15 excluded warmups and900 measured retained.

[Raw-file manifest](MANIFEST.json) binds18 byte-preserved records: requester control/summary/attempt/native stages/provider bindings/resources/runtime/source inventory, both frozen manifests, receiver identity/files/admission and receiver snapshot. Private configurations, credentials and backend.private.log are withheld; originals remain preserved. Provider snapshots include setup activity and are not attributed to the failed request without a real returned correlation.

Requester frozen SHA256=02fc8d165aa01e81113c0dc6f51c6ed845c1924e8fbf630ee6916d529f0b151e; provider frozen SHA256=249ac590069f37199913f609d75243e4a831edd26bdb12352b49f4d8329f5f55. Same audio/reference/model weights/settings and strict predicates as the retained matched setup; no fixture/model change occurred. Normal Auth startup redacted services.gateway.api.token_secret from the requester runtime configuration; before/after hashes and the verified changed-key path remain in the original summary. The original frozen manifest is unchanged.

[V737 supplementalCPU900 result](../worker-cpu-padded-local900-v737/REPORT.md), originalCPU, desktopLocal/HTTP and browser seals remain closed. No UI, microphone, Android, packaging or general13-story acceptance gate is added to this route fix. Original Root owns serial execution/resources; original Orca monitor alone writes methodology. Full matrix remains open.

## Controlled receiver retirement

After the requester was terminal, Root sent SIGINT only to its exact temporary receiver controller at10:47:55UTC. Receiver exit0 and absent original owners were recorded at10:47:56UTC. The controller records KeyboardInterrupt because Root requested this teardown; it is not an additional model-quality failure. A [fresh positive release receipt](provider-positive-retirement-v1017.json) at11:17:37UTC proves the original owners and process groups absent, the existing global build lock free, and former private port free. Every original file is retained. Final receiver resource samples remain on Personal with their byte count and hash in that receipt; their bulk custody transfer remains pending. No baseline was repeated. The original18-file manifest remains unchanged; [addendum custody](RETIREMENT-CUSTODY-v1019.json) binds this receipt.
