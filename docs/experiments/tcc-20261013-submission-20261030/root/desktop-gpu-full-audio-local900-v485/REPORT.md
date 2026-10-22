# Desktop individual full-audio baseline V485

**Status: Current bounded check.** This is one headless production Python local-bus condition on the personal desktop. It is not UI, microphone, physical playback, Android, HTTP, or cross-device acceptance. The original full13 objective remains active.

All 900 measured requests completed actual STT, Assistant and Piper TTS stages using the frozen real audio, with 15 additional excluded warmups. Of the measured requests, **878 satisfied the unchanged strict criterion and 22 completed incorrectly; there were zero execution failures, timeouts or unattempted requests**. The incorrect cases (ordinals 894–915) all returned “The capital of France is Paris.” instead of only “Paris.” Their transcript and session/request/correlation checks passed. These remain strict failures; no predicate, audio, model, or setting was changed, and the run was not repeated.

| Caller-measured boundary | Measured denominator | p90 (ms) | p95 (ms) |
| --- | ---: | ---: | ---: |
| Complete flow, including incorrect completions | 900 | 11970.216910 | 12421.601557 |
| Complete flow, correct requests only | 878 | 11970.336658 | 12422.218394 |
| STT request | 900 | 3584.317801 | 3818.807992 |
| Assistant request | 900 | 6675.662769 | 7359.605243 |
| TTS request | 900 | 1802.272315 | 2098.069377 |

Quantiles use Hyndman–Fan Type 7: sort the sample, use position `(n - 1) * p`, and interpolate adjacent values. Stage quantiles are independent and must not be added. Queue time, first token, first streamed audio and playback timing are unknown at this caller boundary.

The run naturally ended at 2026-10-15 06:30:46 UTC. Both original processes were absent and both reservation locks were available at 06:31:57 UTC. The frozen cohort manifest SHA256 is `d34d21d1a9b1a2db03be2ad64c096e77082168b3bcc09c28d442b4a61eaff3d7`; original WAV SHA256 is `139fa0c34b6d18600ad9608fd2d11c9389cae2f5f548ce0f4f23b735b176f0b3`.

The 32,688,561-byte archive contains 1,870 members, including its manifest, all 915 attempt records, audio references, stage/resource records and frozen inputs. Its SHA256 is `93c3afe2161b031d00b0be53ee9a76c8267369e9fa89d9cbe98cad67eee7d6dc`. It remains in the **personal desktop** project docs directory at the path recorded in [EVIDENCE-LOCATION.json](EVIDENCE-LOCATION.json); the archive has not been copied to coding-worker.

Root ran one offline archive/member-hash, outcome, audio-reference and percentile reconciliation on the completed desktop data. The exact [verification report](verification-v522.json) is copied here with SHA256 `8b649a34aee6d347c16ea6e6a6a4310babb2d91b0cbf868dc46cddc47c13ae6c`. Independent Sol review approved the bounded report/receipt claims; it did not independently audit the remote ZIP. Seven pre-existing frozen source aliases are recorded in the archive; their original-target validation was performed by the collector. The initial collector failure is preserved separately, and the collection-only correction did not alter the measured cohort.

This evidence supports a completed, qualified local full-audio measurement. The observed remaining issue is answer-format compliance; the saved data provide no reason to change STT or a demonstrated runtime/source repair. Keep this cohort and its failures while advancing the same-setup individual HTTP condition. The separate worker CPU campaign continues unchanged. Real product UI voice and remaining individual surfaces remain open; measured cross-device traffic still waits for the required individual AUDIO and SURFACE seals.
