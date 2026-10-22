# Supplemental worker CPU full-audio result — V737

Natural completion on 2026-10-16 at09:46:30.884010UTC; one finalization/audit completed09:46:42.101792UTC. This is the retained supplemental coding-worker CPU cohort, separate from the originalCPU V491 and primary desktop GPU cohorts. It was added for matched padded audio; it creates no obligation to repeat or top up another closed condition.

| Allocation | Planned | Attempted | Correct | Incorrect | Failed/interrupted | Timeouts | Unattempted |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Measured | 900 | 900 | 900 | 0 | 0 | 0 | 0 |
| Excluded warmups | 15 | 15 | 15 | 0 | 0 | 0 | 0 |

Correct full-flow N=900: Type7 p90=51533.189856ms; p95=54152.799883ms. The population is this cohort only; correct, completed including incorrect and all observed measured populations each contain900 in this result. No CPU/GPU or incompatible-cohort pooling.

Boundary: controlled fixed WAV → actual accurate STT → actual local CPU LLM → valid nonsilent PCM16 TTS WAV through the frozen LocalBus service setup. This does not establish an installed UI surface, physical microphone, physical speaker output or audibility. Native stage and resource records use their own process clocks; queue, TTFT and streamed first-audio remain null where not exposed.

The [once-only saved-data verification](verification.json) records the full outcome and native-stage metrics. [Raw archive](aurora-worker-cpu-padded-local900-v737.zip), [archive manifest](ARCHIVE-MANIFEST.json) and [native per-case history](NATIVE-STAGE-CASE-HISTORY.json) retain the actual raw attempts, source/model/input bindings, stages, resources and retirement history. Archive bytes=32740359, SHA256=8647715e745b7a49f8fb270730312909be3918fa7e87900b3174dbf2f8dc2f99. Frozen condition SHA256=acbdc1d3827502513237220fcc3bf60cc3a007b7dc246b1a4b21b1a0ef8ce5fc.

The original controller3038114 and backend3038148, plus their owned groups, retired before finalization. Root observer68726 invoked the existing collector exactly once; it returned0 and saved ZIP integrity/hash/outcome audit passed. The archive and metadata were published after actual space admission. Private configuration, credentials and private backend logs are withheld by the existing export policy; originals remain preserved.

The selected worker reservation was released. The subsequent distributedK1HTTP attempt is separate and its outcome cannot change this closed result.

Selected exact-handler native subsets each contain900 valid spans: STT Transcription.Transcribe p90/p95=10601.935136/11490.1769728ms; LLM resolved_chat_model.astream=33208.5676245/36202.3217026ms; TTS TTS.Synthesize=3961.0224797/4607.93307905ms. Each subset has0 missing/multiple/invalid selected spans. The separate global diagnostics remain invalidBoundaries=1830 and unmatchedStarts=0, with cause unassigned. Native harness-case IDs are absent; exact correlation mapping to the saved attempts supplies the subset case association. Wrapper attempt/operation IDs remain absent where recorded; STT/TTS model-invoke IDs are retained. These limitations are preserved without extending subset validity to every global boundary or inventing missing measurements.
