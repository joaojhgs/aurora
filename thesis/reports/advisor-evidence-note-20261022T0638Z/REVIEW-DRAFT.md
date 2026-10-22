# Advisor review draft — sealed two-node audio results and remaining evidence

**For owner/advisor review.** Evidence cutoff: 22 October 2026, 06:30 UTC. This is a reversible results supplement, not a submitted manuscript or a completed full-matrix claim. The canonical TCC repository/manuscript was not edited. Small source hashes and machine-readable values accompany this standalone, uncompressed Markdown file.

## Research question and claim boundary

The completed subset contains six cumulative remote-stage/transport conditions on the coding-worker requester W and Personal desktop provider D, each with 900 measured attempts. The performance boundary is fixed prerecorded audio through actual STT, LLM and TTS to a valid output-audio artifact; physical microphone capture, audible playback and all-client acceptance remain separate claims. [claim:C001] [evidence:E001,E002,E003,E005,E007,E008,E014]

A useful thesis question is: **Under which recorded device, stage-placement, transport and load conditions can distributed execution provide a useful complete audio result, and at what latency, resource cost and failure rate?** This is proposed framing for the author to reconcile with the actual research objective, not a replacement objective or a claim that the canonical manuscript already uses these words.

The hosted-HTTP measurements use an Orca intermediary. The actual P2P conditions use the product pairing/mesh path; selected ICE snapshots are evidence at their recorded boundaries, rather than proof that every request followed a continuously stable direct or TURN path. [claim:C002] [evidence:E001,E006,E009,E014]

## Observed outcomes

Non-correct is a reporting category here. The original transport, answer-predicate, interruption and timeout classifications remain in the evidence. Timeouts are included in the non-correct counts, not added again.

| Condition | Remote stages | Measured attempts | Correct full audio | Non-correct | Timeout flags within non-correct | Evidence |
| --- | --- | ---: | ---: | ---: | ---: | --- |

| K1 Orca-relayed HTTP | TTS | 900 | 899 | 1 | 0 | [claim:C003] [evidence:E001] |
| K1 actual P2P | TTS | 900 | 885 | 15 | 1 | [claim:C004] [evidence:E002] |
| K2 Orca-relayed HTTP | LLM + TTS | 900 | 797 | 103 | 0 | [claim:C005] [evidence:E003] |
| K2 actual P2P | LLM + TTS | 900 | 774 | 126 | 0 | [claim:C006] [evidence:E005] |
| K3 Orca-relayed HTTP | STT + LLM + TTS | 900 | 885 | 15 | 0 | [claim:C007] [evidence:E007] |
| K3 actual P2P | STT + LLM + TTS | 900 | 773 | 127 | 1 | [claim:C008] [evidence:E008] |

The K1 HTTP failure at global index 180 is preserved as a remote TTS transport error with timeout=false. Its index was consumed rather than retried. K2 HTTP retains 103 strict answer-check failures with TTS uninvoked on those requests. K2 P2P retains 115 answer-predicate failures and 11 pre-acceptance capability-change failures. K3 P2P retains 71 pre-acceptance capability-change failures, 55 answer-predicate failures and one ambiguous mesh timeout. [claim:C009] [evidence:E001,E003,E005,E008]

These counts close the attempt targets, not an assertion of 900 successful outputs. A strict answer-predicate failure is not by itself a diagnosis of transcription/model quality or a statement that the response was semantically wrong; the K3 saved analysis explicitly leaves the quality-failure cause unknown. [claim:C010] [evidence:E003,E009,E014]

## Latency with the correct analysis populations

All values below are seconds, converted from retained milliseconds. Each n is the number of correct full-audio requests used for that row's quantiles, not the attempt denominator. Warmups are additional and excluded. The table extracts saved values; it does not rerun inference, decode audio again, recompute historical quantiles or average percentiles.

| Condition / retained epoch | Correct-only n | p90 s | p95 s | Evidence |
| --- | ---: | ---: | ---: | --- |

| K1 HTTP V1197, indices 1–180 | 179 | 57.463 | 60.305 | [claim:C011] [evidence:E001] |
| K1 HTTP V2234, indices 181–450 | 270 | 58.608 | 60.103 | [claim:C012] [evidence:E001] |
| K1 HTTP V2296, indices 451–900 | 450 | 63.355 | 64.784 | [claim:C013] [evidence:E001] |
| K1 P2P first 20 attempts | 19 | 48.617 | 49.321 | [claim:C014] [evidence:E002] |
| K1 P2P next 689 attempts | 678 | 51.271 | 53.838 | [claim:C015] [evidence:E002] |
| K1 P2P final 191 attempts | 188 | 49.885 | 51.352 | [claim:C016] [evidence:E002] |
| K2 HTTP | 797 | 31.730 | 33.246 | [claim:C017] [evidence:E004] |
| K2 P2P | 774 | 19.429 | 20.761 | [claim:C018] [evidence:E006] |
| K3 HTTP, explicitly matched four-epoch aggregate | 885 | 31.243 | 31.788 | [claim:C019] [evidence:E007] |
| K3 P2P, saved compatible-epoch aggregate | 773 | 13.919 | 14.666 | [claim:C020] [evidence:E009] |

The retained estimator is Hyndman–Fan Type 7, h=(n−1)p with linear interpolation. K1 HTTP and K1 P2P keep their unlike epochs separate. K3 HTTP's saved aggregate combines raw observations only after its explicit same-effective-setup comparison; it records four interrupted/continued epochs and keeps those strata. K3 P2P retains its compatible parent/continuation histories. None of this permits pooling different models, hardware, surfaces, modes or unrelated source epochs. [claim:C021] [evidence:E001,E002,E004,E007,E009]

K1 HTTP excludes 45 warmups across its three epochs; K1 P2P excludes 45 in the measured epochs and separately preserves additional startup history. K2 HTTP and K2 P2P each exclude 15. K3 P2P records 35 excluded warmups, comprising 30 correct and five failed. Warmup/startup outcomes remain available and do not become measured successes. [claim:C022] [evidence:E001,E002,E003,E005,E008]

K3 P2P also records all-attempt time-to-outcome p90=13.778 s and p95=14.559 s for n=900, and failed time-to-outcome p90=11.008 s and p95=11.754 s for n=127. These quantities include early failures and describe a different population from successful full audio. Reporting a faster failed outcome as a faster complete pipeline would be misleading. [claim:C023] [evidence:E009]

## What the comparisons support

The retained K2/K3 P2P tables have lower correct-only end-to-end tails than their recorded Orca-relayed HTTP counterparts, alongside more non-correct outcomes. These are descriptive results for the tested deployment paths. They do not isolate a protocol's intrinsic overhead: the HTTP intermediary, model residency, source/runtime epochs, setup, queuing and background load can contribute. Native compute spans and the actual transport topology must accompany any attribution. [claim:C024] [evidence:E002,E003,E004,E005,E006,E007,E008,E009,E014]

For the thesis, distinguish three questions:

1. **Feasibility:** can the exact effective model/task complete locally on the requester, or does offload enable a task that is unsupported/infeasible there?
2. **Observed complete-pipeline benefit:** what changes in end-to-end outcomes, latency and resources under the explicitly recorded placement and load?
3. **Transport contribution:** what stage/serialization/queue/transport observations support attributing part of that change to the actual route?

Only answer each question at the scope supported by its evidence. Reuse valid local reference cohorts with explicit setup mappings. Existing CPU and desktop local controls are retained; this note does not manufacture a newly matched local baseline, prescribe a replay, or calculate a universal speedup from the transport table.

A concrete frozen input/model identity is present in the K2 P2P saved record: input WAV 219,794 bytes, mono 22,050Hz 16-bit, SHA256 da0ecc4ad0885746ab6e716585473917ab2b543a505bf0db09ebacfaa7943cbb; LLM weight hash 57d1997790d1744fba5b40a7317df71ea5e2acee28c47e78f0cce39c0703f8cf; STT d01c3014881c9c6f3133c182f3d2887eb6ca1c789a7538c5c007196857a0a6a9; TTS 6f52a751e2349abe7a76735eb09dc1875298c77ea2342ffd2fef79ff81b87f22 and TTS config 141d612cc0a95ed7efc1ca936b845c2364967f2e9217c5dbfcf69fc4d6c65860. These identify that source's setup; another cohort still needs its own exact mapping. [claim:C025] [evidence:E006]

## Measurement and validity limitations to keep in the thesis

K2 HTTP records unknown first-token, first-audio, playback, queue and relay-only latency fields. Its resource samples are observations within native/case intervals, not exclusive per-request resource attribution; parent receiver CPU excludes separate Piper processes, namespace network interfaces must not be summed, and short model intervals may have no samples. Missing or unsupported counters remain unknown, not zero. [claim:C026] [evidence:E003,E004]

Native durations use their recorder's host/process monotonic clock. The saved analyses prohibit subtracting monotonic timestamps across hosts or adding independent percentile summaries. K2 P2P's before/after selected ICE snapshots do not establish continuous path stability. K1's final block preserves original raw/audio, provider prefix and verified EOF delta, with actual SUT/collector retirement and allocation release. [claim:C027] [evidence:E001,E004,E006,E009,E015]

These repeated requests characterize the frozen workload and recorded operating conditions. They do not establish variation over a representative task corpus, independent experimental replications, population-level generalization, statistical significance or causal equivalence. Report the fixture/task, decoding/seed controls, process/session changes and actual load alongside the result. Upstream fixture/model licensing, literature references and institutional formatting are not newly verified by this note.

Keep a visible unresolved-evidence list for C06 final raw and the full Browser V799 archive. This note does not establish recovery or complete custody for either. Preserve existing summaries and failures; do not rerun a closed 900-request condition to conceal missing history. Existing unknown countries, hardware capabilities, runtime support or stage fields remain unknown.


## Current coverage and finite remaining work

The accepted plan retains applicable non-iOS Android local/cumulative HTTP/P2P conditions, real multi-provider composition, approved directed physical/regional pairs and declared load/recovery/privacy cases. Six completed W–D cells are a subset. The 19 Android applicability rows are not 19 already admitted campaigns. Waydroid shares its physical host; an Orca relay is not a compute provider. [claim:C028] [evidence:E014]

The exact PHONE local LLM is now qualified on the POCO with CPU llama.cpp 0.4.1: model hash 57d199…; integrity/load 55.245 s and one correct fixed response in 3.267 s, plus a separately correlated cancellation and session destruction. The receipt records two bounded native completions and zero measured cases; PHONE STT/TTS, complete native file-audio and HTTP/P2P are still unqualified in that snapshot. This is readiness evidence, not a phone percentile or proof of notebook/GPU execution. [claim:C029] [evidence:E010,E011]

PHONE local/K1 require local LLM, K2 requires only PHONE STT, and K3 requires no PHONE model stage. Existing owner-authorized automatic execution ends at 11:57:25.269652 UTC on 22 October including setup/pilots, without automatic extension. The existing phone worker owns necessary isolated product fixes; Root owns main execution and later integration. [claim:C030] [evidence:E014]

The bounded Waydroid check reached an existing ADB server with zero listed devices and did not resolve the approved device binding. It does not prove emulator absence. Root's separate C12 operation is an excluded paired-readiness pilot for a local desktop request and worker HTTP request sharing desktop services. Its launch receipt is not a 900-request result; no C12 measured acceptance is asserted here. [claim:C031] [evidence:E012,E013]

The remaining matrix should name each eligible requester/provider/surface/mode/stage/load condition, its exact frozen source/model/input settings, n_planned=900, n_measured, n_success, failure/timeout denominator and evidence. Multi-provider MP1/MP2/MP3 need actual supported stage maps and third-provider admission; they remain required where applicable, with unsupported capability made explicit. Preserve resource isolation for reference cells and label mixed local+mesh/API contention separately. No additional closed CPU/control run follows from this note.


## Applying the evidence across the thesis

| Chapter / section | Proposed revision for owner/advisor review | Evidence or open issue |
| --- | --- | --- |
| Introduction and objective | State the user benefit and testable distribution question before implementation details. Bound the current completed claim to the recorded two-node fixed-audio subset. | E001–E009; full scope E014 |
| Related work | Compare the actual research question and experimental boundary. Verify every external reference directly before inserting it; no bibliography is supplied or repaired here. | Literature verification pending |
| Architecture | Show where STT/LLM/TTS ran, physical hosts and actual HTTP intermediary versus P2P route. Keep compute composition distinct from transport relay. | E006/E007/E009/E014 |
| Methodology | Specify request/task/input/model hashes, effective backends, stage maps, epochs, warmups, failure handling, finite caps, quantile populations and clock domains. State which settings are fixed and which differ. | E001–E014 |
| Results | Lead with outcomes and denominators, then correct-only p90/p95 and separate failure time-to-outcome. Preserve failed audio-stage absence rather than implying every request produced a WAV. | Tables above; E003/E009 |
| Discussion and limitations | Explain the observed deployment differences without calling aggregate e2e differences pure protocol overhead or universal GPU/offload gain. Address predicate failures, partial observability, interrupted epochs and fixed-task generalization. | E002–E009 |
| Conclusion | Answer only the evidence-supported part of the objective; identify Android, multi-provider, geography/load and missing-history limits explicitly. Retain the whole remaining objective. | E010–E014 |
| Abstract / resumo | Write after the results/conclusion agree. Use the same counts, populations and limitation scope in both languages. | Drafts below |

This is a chapter application checklist, not a claim that those exact canonical chapter names or current text have been inspected. The original live PERSONAL/UNIVERSITY white-paper session lineage remains unverified in this note; absence from an inventory is not proof it stopped. The company Work account/session is excluded. No manuscript ownership is adopted.


## English abstract candidate — limited to the completed subset


This evidence supplement reports a controlled audio-pipeline subset using one requester/provider device pair. It evaluates three cumulative remote-stage placements through Orca-relayed HTTP and actual P2P, with 900 measured attempts per condition and additional excluded warmups. Correct full-audio outcomes were 899/885 for remote TTS, 797/774 for remote LLM+TTS, and 885/773 for remote STT+LLM+TTS, respectively for HTTP/P2P. The recorded P2P conditions had lower successful-request latency tails in K2/K3 and more non-correct outcomes. Quantiles are reported with their success-conditioned denominators and compatible epoch policies. The results characterize these deployed paths and the fixed workload; Android, supported multi-provider composition and further load/device coverage remain incomplete, and the aggregate e2e differences do not isolate protocol overhead. [claim:C032] [evidence:E001,E002,E003,E004,E005,E006,E007,E008,E009,E014]

## Proposta de resumo em português — limitada ao subconjunto concluído


Este suplemento apresenta um subconjunto controlado do processamento de áudio em um par de dispositivos requisitante/provedor. Foram avaliadas três distribuições cumulativas de etapas por HTTP intermediado pelo Orca e P2P real, com 900 tentativas medidas por condição e aquecimentos adicionais excluídos. Os resultados corretos com áudio completo foram 899/885 para TTS remoto, 797/774 para LLM+TTS remotos e 885/773 para STT+LLM+TTS remotos, respectivamente em HTTP/P2P. As condições P2P registraram menores caudas de latência entre respostas bem-sucedidas em K2/K3 e mais resultados não corretos. Os percentis mantêm seus denominadores e as políticas de compatibilidade entre épocas. Os dados caracterizam esses caminhos e a tarefa fixa; faltam coberturas aplicáveis de Android, composição com múltiplos provedores e carga/dispositivos adicionais. A diferença de latência ponta a ponta não isola o overhead do protocolo. [claim:C033] [evidence:E001,E002,E003,E004,E005,E006,E007,E008,E009,E014]

## Source and review record

- `SOURCE-MANIFEST.json` records exact repository-relative source paths, sizes and SHA256s. E016 is an older discovery index: its K1 HTTP 180/900 count is superseded by E001; it is not current execution status.
- `NUMERIC-EXTRACT.json` records the source-bound outcome/latency values and unit conversion used here. `CLAIMS.csv` hashes the marked claim text and links source IDs. These are draft traceability records, not human verification or manuscript approval.
- No benchmark, model, device/network request, new validation matrix, source fix, Git write, submission or external publication was performed to produce this note. Saved metrics were read; no raw-request analysis or historical quantile rerun was launched.
- Prepared by the existing Aurora monitor, GPT-6.1-Sol/xhigh, under Run `run_e6054e76e9fc`, Task `task_d7ea336050cf`, Dispatch `ctx_37b4d0a3c14f`. Local scientific-writing skill v2.1 informed evidence binding. No external scientific reference or unverified skill-supplied article citation was added.
- Accountable owner/advisor verification of wording, claims, underlying evidence and canonical thesis placement remains pending. This draft is available ahead of the plan's Oct 23 advisor target; it creates no measurement, packaging or approval gate for the active matrix.
