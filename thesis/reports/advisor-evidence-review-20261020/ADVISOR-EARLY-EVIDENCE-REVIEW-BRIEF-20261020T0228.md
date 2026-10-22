# Aurora: early advisor evidence review brief

Prepared20October2026UTC from retained repository artifacts. This is a reversible evidence-review draft for owner/Personal routing, not a canonical thesis edit, delivered Telegram message or completed full-matrix report. It provides review material before the30October deadline while missing experiments continue under the existing Root. No new experiment was run to produce it.

Research question: under the same full audio task and effective models, how do local execution, hosted HTTP and actual P2P cumulative offload trade correctness, elapsed time, feasibility and resource cost? Compare K1 remote TTS, K2 remote LLM+TTS and K3 remote STT+LLM+TTS between the same physical requester/provider. Each applicable condition targets900 measured attempts, with excluded warmups. The remaining applicable Android and multi-provider conditions remain required; their readiness is not established by a two-host HTTP result.

## Current evidence and denominators

| Retained condition | Attempts | Correct / failed | Successful-correct p90 / p95 seconds | Scope |
|---|---:|---:|---:|---|
| K1 HTTP V1197 |180 of900 |179 /1 |57.463302 /60.305351, n179 |Partial;720remaining; stop was TTS transport failure |
| K2 HTTP V1264 |900 of900 |797 /103 |31.730103 /33.246103, n797 |Terminal native analysis complete;103strict-answer failures before TTS |
| K3 HTTP V1682 FINAL EPOCH ONLY |160 of160 new requests |160 /0 |30.922525 /31.162455, n160 |Requester sealed; provider final correlation/custody pending |
| K3 HTTP preserved condition COUNTS |900 of900 across epochs |885 /15 |No pooled900 quantile claimed |Earlier740requests/failures preserved; final provider seal pending |
| K1/K2/K3 actual P2P |0 measured per condition |Not measured |Unknown |Normal pairing/control proof is not model-route admission |

Quantiles use Hyndman–Fan Type7 linear interpolation, h=(n−1)p, on measured successful-correct elapsed times; warmups excluded. These conditional distributions cannot erase failed attempts or become all-request success latencies. Report failures/timeouts/unattempted explicitly. K2's103failures did not invoke TTS, so they are not900successful complete audio pipelines. Do not sum stage percentiles, average epoch percentiles, or pool changed hardware/settings. A compatible raw-row union needs exact eligible-row mapping and visible epoch/load/clock stratification.

## What the experiment actually measures

The controlled performance boundary is fixed prerecorded file audio → actual STT → actual LLM → actual TTS → received, decoded and validated non-silent PCM16 WAV. Physical microphone capture, audible playback and rendered UI are not established by these data and do not gate independent supported file-audio cells. Frozen input SHA256da0ecc4ad0885746ab6e716585473917ab2b543a505bf0db09ebacfaa7943cbb,219794bytes,22050Hz mono. Refer to frozen cohort manifests for source/model/weights/decoding correctness criteria; no new model/fixture is inferred or substituted by this review.

Current provider is accurately labelled hybrid: WhisperCPU/int8_float32, LLMVulkan25/25layers, PiperCPU. It is not an all-GPU voice pipeline. Local CPU and desktop cohorts remain separate. Current HTTP traverses worker loopback18000 → Orca controller → Personal desktop8000. That authenticated additional-hop topology is not actual P2P, direct LAN/WAN or a third compute provider. The saved historical one-endpoint nominated directUDP ICE observation supports that control-session snapshot only; no live900P2P result exists yet.

K2 terminal validation joins all actually invoked native stages:900STT andLLM/history,797TTS. It retains1763provider raw files/214494313bytes. Its resource samples are interval-scoped observations, not exclusive per-request attribution: parentCPU omits childPiper processes, network counters are namespace-wide, short windows can lack samples, and GPU observations are recorded-device specific. Unknown first-token/first-audio/playback/queue/relay-only latency remain null. Instrumentation limitations must be shown in methods/results rather than changed to zero or used to demand another closed900.

## Claims supported now, and claims still unavailable

| Proposed thesis claim | Present evidence / required correction |
|---|---|
| Actual two-physical-host audio processing over authenticated HTTP |Supported for retained successfully completed requests under exact frozen stage maps; report failure denominators and relay topology |
| Greater remote-stage placement is descriptively associated with different elapsed distributions in these cohorts |Descriptive only; hardware, locality, epochs/load/path and differing failure populations prevent a pure causal protocol claim |
| P2P is faster/slower than HTTP, or mesh overhead is X |Not supported until paired same-stage actualP2P cells and matched compute/path spans exist |
| GPU acceleration alone causes the measured difference |Not supported by unlike CPU/GPU hardware/load/stage maps; label effective hybrid setup and separate controls |
| Android/weak-phone speedup or independent mobile physical device |Not supported; Waydroid shares desktop physical resources, actual Android runtime/model feasibility still needs admission |
| More-than-two-node stage composition or provider scheduling benefit |Not supported until actual stage_provider_map/native joins on eligible W/D/N composition |
| Physical capture/playback, phone battery/thermal/radio, or universal natural-language quality |Not established; separate surface/hardware claims and narrow fixed-workload generalization |

## Requested advisor feedback while measurements continue

Please assess whether the research questions and hypotheses are bounded to measured compute/transport tradeoffs, whether this fixed audio/task is described with appropriate limits, and whether correctness/failure and resource attribution caveats are clear. The experiment must not imply P2P speedup before paired data. The final discussion must distinguish feasibility/weak-device benefit, compute placement and network topology rather than treating an end-to-end subtraction as protocol overhead.

Chapter application: introduction/questions and both abstracts state only completed claims; background separates signaling/ICE/TURN from application compute; architecture records actual implemented stage routing; methodology names exact frozen audio/models/hardware, per-condition900 and clock domains; results show raw-derived denominators/quantiles and missing cells; conclusions answer each hypothesis within those bounds; appendices/index retain reproducible manual commands, failed epochs, custody and limitations. Canonical TCC application remains owner-review gated and is outside this monitor's write scope.

## Resumo para revisão

Os dados preservados demonstram requisições de áudio processadas por dois computadores físicos via HTTP autenticado, com terceirização cumulativa de etapas. A condiçãoK2 concluiu900tentativas:797corretas e103falhas no critério de resposta antes da síntese. A condiçãoK1 possui180tentativas, com720restantes. K3 atingiu900tentativas em épocas preservadas, com885corretas e15falhas; a última época concluiu160corretas, mas a validação final dos registros nativos do provedor permanece pendente. Ainda não há mediçõesP2P que sustentem uma conclusão de vantagem ou sobrecarga específica do protocolo. A comparação deve separar processamento, caminho de rede, hardware, erros e limitações de observabilidade. Waydroid é uma superfícieAndroid que compartilha o computador de mesa, não um telefone físico independente.

## Next evidence and review schedule

Finish the bounded K3provider seal once, then admit actual K1P2P through15excluded correlated full-flow warmups before900measured; K2/K3P2P and only the720remainingK1HTTP follow finite reservations. Android readiness/preparation and harmless analysis proceed without competing model traffic; actual Android compute and multi-provider cells need supported route/runtime/resource admission. The authoritative full plan§30.59 records a first advisor packet target23October, updated packet26October, review-version data/figure freeze27October and advisor/owner revisions28–29October. These are targets, not evidence of completion; exact30October cutoff remains unknown. The full-matrix finish estimate remains conditional on Android/third-node/composition pilots; no essential cell is silently removed.

Historical custody gaps remain disclosed: C06final/rawUNKNOWN and BrowserV799fullraw/archiveUNLOCATED. Do not invent a recovery or replay closed900 to hide loss. All important current raw/audio/stage/resource evidence must physically remain in repositorythesis/; this brief references it rather than becoming its sole copy.

## Exact source pins

- K1: `thesis/evidence/orca-relayed-http-v1197/terminal-v1377/summary.json`; 45803bytes; SHA256`641c6fc03929cd7c455d4b9f6460dd9923925069e99da69023079ae88b37563b`.
- K2: `thesis/campaigns/worker-desktop-k2-orca-relayed-http-v1264/terminal-v1465/summary.json`; 210006bytes; SHA256`abb5424860371fc379eb492845779ca2adb52a2efa3cc7719a07b7b6bee2af5c`.
- K2validation: `thesis/campaigns/worker-desktop-k2-orca-relayed-http-v1264/terminal-v1465/FINAL-VALIDATION-v1472.json`; 4389bytes; SHA256`910992937bdd8235d01d953eb9ac771df2c5409466ad2f075230bf020f64b8d4`.
- K3epoch: `thesis/campaigns/worker-desktop-k3-orca-relayed-http-remaining-v1682/terminal-20261020T0213/summary.json`; 49993bytes; SHA256`5f6d4927ee4854c6a7d9285b492fb53d647eeb31427130c359c8b9f728cc3756`.
- K3requesterSeal: `thesis/campaigns/worker-desktop-k3-orca-relayed-http-remaining-v1682/terminal-20261020T0213/REQUESTER-SEAL-AND-RESULT.json`; 5235bytes; SHA256`6f93bddd54f096207006f9145001c619bb621a53328a94b1e22efbf8b066f900`.

Lineage: original aggregate01a112a5-d6bb-74e2-bf7c-ace73cb513b5; Runrun_e6054e76e9fc; monitortask_d7ea336050cf/dispatchctx_37b4d0a3c14f. OriginalRoot remains execution owner; monitor remains plan/review writer. No source, model, test, build, deployment, separate TCC manuscript, company session, commit, push or submission was changed.
