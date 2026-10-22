# V481 bounded source review

Verdict: **APPROVE the four reviewed runtime harness sources, source only.** The retained source-isolation/restoration receipt has now been read; Root retains the final pre-Popen input/confinement assertions. No runtime success is claimed.

| Reviewed file | SHA256 |
| --- | --- |
| pilot.py | `7079b8fb2f3e74815fb0d7e1a26823270b05b0dbb8ea418437b979e4149e676d` |
| controller.py | `975c64f83237ff2639a5d943f8af61b863533161b394ab5065dfb5aa66ef2bb0` |
| bootstrap.py | `31dc5ca950bf07ff21a066dd0dc522dc5c35608ad6cedc9edfd845b62f2ddc94` |
| bindings.py | `52182f956b34788ecbfbbb241c8243ff88baebe2874e3605791793777ed0dc91` |

The required pilot input has exactly wavSHA256, referenceTranscript, expectedReplyWords; the latter must be the list ["paris"]. The full candidate manifest is a separate schema. The pilot checks the supplied WAV hash, exact normalized reference words and exact normalized reply words. It forwards the actual STT text to the production typed Assistant request and the actual returned answer to Piper; expected content is used for grading rather than substituted into those calls. Failed correctness remains a failed, retained non-measured attempt. WAV/PCM validation, IDs/history predicates and finite request/parent caps remain present.

The reviewed controller retains exclusive global/GPU ownership, private output, resource guards and owned process-group cleanup. Bindings transparently record actual constructor arguments/returned classes and effective settings, including seed/threads/verbose. Offload lines are separated from backend initialization; aggregate network counters are labelled as such. Unknown queue/TTFT and unavailable counters do not become zero or inferred spans. This is one prerecorded audio pilot, with no microphone/acoustic, benchmark, whole-GPU or phase-2 acceptance.

**Preparation incident closure:** Read the actual retained ORCA-V481-ISOLATE-SOURCE-ACTUAL-READ-1.json (SHA256 e6e000aae3ef5bfa190301132fd810089eb16084f62d03310eac5ff816513ef2), reporting 2026-10-15T03:12:55.308276+00:00, noAudioRequests=true and isolated_and_originals_restored. All four candidate config destinations resolve under the candidate/source tree with shared=false. The restored schema/models/keys/defaults hashes respectively begin 5b2465b2/a089ea63/00be4bf6/313a4749 and the candidate hashes match the reviewed V478 558cf964/00fb3ef2/c14fb625/1ddb3232. This closes the demonstrated ancestor-symlink incident for those four writes; it does not endorse replaying the old preparation script. The reviewed repair script writes the required separate exact-three-key input with ["paris"], and Root reports that write completed. Root will assert actual manifest content/hash and confinement immediately before Popen. Expected WAV: 153644 bytes, SHA256 139fa0c34b6d18600ad9608fd2d11c9389cae2f5f548ce0f4f23b735b176f0b3. No source blocker remains in this bounded review; runtime remains unproved.

Validation: source comparison and stdlib AST parsing of the four files only. No imports, tests, model calls, application/runtime, device, network or remote commands were run. No canonical source/index/goals/ledger/vault changed. This review does not validate a future model response or reclassify prior failed attempts.
