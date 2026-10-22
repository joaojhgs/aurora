# Aurora TCC evidence update and bilingual correction review
**Status: owner-review analysis and reversible drafts; experiment incomplete.**
Snapshot: 2026-10-15, approximately03:00 UTC. Objective: tcc:20261013:submission-20261030; target30October2026 America/Sao_Paulo, exact cutoff unknown. This standalone uncompressed Markdown addendum updates the evidence boundary of the existing full review; it does not edit or submit the canonical thesis.

The study now has successful typed-request controls and one genuine but task-incorrect audio→STT→LLM→TTS→audio pilot. Those are different outcomes. They support narrower conclusions than a successful voice baseline, real-device stage offload, or a general privacy/performance benefit. The next scientific action is to resolve the declared audio condition without hiding the negative result, then complete the individual and cross-device study under the accepted protocol.

## 1. Provenance and ownership

The existing full review is /home/developer/projects/aurora/docs/experiments/tcc-20261013-submission-20261030/monitor/TCC-WHITE-PAPER-RE-REVIEW.md,41960bytes,SHA2568b4b2b09a69edb85814ed8ff11942f1c6078f408324da16d3df5968314651fbd. Its00:11UTC14October snapshot and conclusions remain historical. Its single Telegram API document delivery was confirmed as message79 on existing Personal topic2; that is a delivery receipt, not owner acceptance. This NEW addendum has not been delivered through Telegram and does not reuse that receipt as proof of its delivery.

Accessible Personal source root: /home/developer/Documents/Obsidian Vault Origin/5-full-notes/faculdade/tcc/. The full36-source comparison is source-check.json beside this file.35sources are byte-identical to the original review manifest; the only changed source is the intentionally expanded owner-authoritative test plan. Thus the white paper, both thesis versions, bibliography bytes and historical evidence files remain the same accessible versions. This establishes Personal synced-byte identity, not current remote canonical identity.

Canonical TCC identity remains project repo:846e3e40-f48b-4e20-8aa7-88ef55b67da3; workspace846e3e40-f48b-4e20-8aa7-88ef55b67da3::/home/developer/projects/tcc on ssh:ssh-1786238480967-semdev. No project was adopted, duplicated or edited. Aurora branch codex/aurora-native-speech-routing-20261007, HEADcbac78fe3fb2b73100bfaa9dc198fb6bff689840;60dirtypaths observed when draft manifest was recorded, including Root's five-file configuration repair. No source/index/commit/push/test/model/build/device changes by this document writer.

Exact existing white-paper source: sistemas-distribuidos.md,SHA25649aa38f0556e1dba549b44c58aaea4e409b5b1874fd9cd9680349d8f94b6c77f. English thesis: report-en/relatorio.tex,chapters/cap01.tex–cap06.tex,abstract.tex,resumo.tex and lib/refs.bib. Portuguese thesis: template latex/relatorio.tex with the same chapter/abstract/bibliography structure. The full paths and per-file hashes are recorded in source-check.json; all these manuscript bytes match the original reviewed sources. Both bibliography files remain SHAb6e698b5be053c67e43148ea002383152d20363efe3eaa47c492f084b04dc79b.

Current full plan: /home/developer/Documents/Obsidian Vault Origin/5-full-notes/faculdade/tcc/future-work-test-requirements.md,1643lines,section30.14,SHA47272b6b3acd9da36bbbbe2665d2e47d09224a7d280f7d357d3a737bc6789019. Root actually read all23addedlines/receipt/diff and acknowledged the exact hash/preserved1620prefix in msg_420ff8b5ded5. Backup/fullafter/diff/receipt: monitor/plan-real-audio-failure-20261015T0248/. Subsequent status updates retain their own receipts rather than changing prior evidence.

### Exact live paper-session lineage remains unverified

Fresh default registered terminal census receipt8be95085-2996-4609-bc67-2da5c835a1b1 exposed14rows, untruncated, across its declared hosts. It did not establish a PERSONAL/UNIVERSITY Claude paper terminal or a terminal registered to the canonical TCC workspace. University host ssh:ssh-sem-notebook-university was explicitly omitted. The advertised --host selector was tried once in read-only inventory and rejected as invalid_argument before selecting that host; exact receipts are paper-lineage-default-inventory.json and paper-lineage-university-selector.json. Missing inventory is not evidence of session exit, absence or authorship.

The existing Personal coordinator is verified: terminalterm_8109a3ac-570e-4c3f-a7ac-e68e36764b2b/incarnation468a0928-9867-4612-b5f2-e7631784582d,connected,existing Personal-vault workspace on ssh:ssh-oci-coding-worker. It is the coordinator/delivery route, not a verified Claude paper-writing session. Company Work Claude is not a TCC source or executor; no company terminal was read, contacted or used for this review. Default registry previews are excluded from the durable lineage report.

## 2. Updated evidence, with denominators

| Evidence group | Actual result and sample allocation | Scientific boundary |
| --- | --- | --- |
| Historical16June targeted unit subset |151passed/8skipped at archived environment/source | Historical functional evidence, not current suite or experiment acceptance |
| Extra coding-worker CPU typed cohort6ce98ae97d594d9fafcd1ff9ad4b9b1c |900measuredTOTAL,300per local/API/same-host mesh route;45extra warmups | Original frozen CPU-loaded typed control; not900percondition, voice or staged feature outsourcing |
| Desktop GPU typed local control |900correct/900measured,15excludedwarmups,3processes | Typed reply plus separate history correctness; no STT/TTS/playback |
| Desktop GPU typed same-desktop HTTP |900correct/900measured,15excludedwarmups,3processes | Loopback/same-host gateway control, not deployedAPI or cross-device |
| V476 setup failure |SamplerEBUSY before backend/observer/pilot; zero audio attempts | Retained setup failure, not inference failure/GPU-unavailable proof |
| V477 complete prerecorded-audio pilot |1attempt/0correct/1failed/0timeouts/0admitted benchmark samples | Real causal chain with valid output audio, failed original task; GPUoffload unproved |
| Real cross-device cumulative stage sweep |No admitted measurements under current barrier | No inter-device speedup, weak-device benefit or complete distribution claim |

Typed control descriptive quantiles, milliseconds:

| Cohort/route | n | p90 | p95 |
| --- | ---: | ---: | ---: |
| CPUextra/local |300 |35437.982592 |37635.40468775 |
| CPUextra/API |300 |35711.055822300004 |37399.58333755 |
| CPUextra/same-hostmesh |300 |40876.1 |42178.65000000001 |
| DesktopGPUtyped/local |900 |5457.406 |5497.371 |
| DesktopGPUtyped/HTTP |900 |5582.345 |5849.052 |

Sources are Root's archived analyses, not a new calculation: root/matched-main-analysis-6ce98ae97d594d9fafcd1ff9ad4b9b1c/analysis.md and root/desktop-gpu-typed-primary-v426/README.md, under /home/developer/projects/aurora/docs/experiments/tcc-20261013-submission-20261030/. Type7 linear interpolation is over successful measured caller durations; warmups excluded and outcome denominators retained. Three process/session clusters per condition do not establish confidence intervals, stable tails or independence of every request. CPU and GPU populations are not pooled. Their differences include hardware/background-load/settings/source effects, not pure protocol overhead or an isolated causal GPU speedup.

The typed GPU epochs record RX7600/Vulkan25/25layers at their own model/source snapshot. This does not prove acceleration in a later runtime. The later discovery of filtered configuration settings requires actual-settings mapping; a source fix cannot retroactively seed older data or establish unrecorded equivalence. Retain the data with its manifests and limitations.

### Real full-audio pilot

Root/headless-full-audio-v477 contains the primary records. The complete fixed synthetic WAV was193068bytes/96512frames/mono22050HzPCM16/4.376961451s,SHA2f6361506708d0a3065a339d168c9db5412e343683dd9b4080471d8948bf82ae. Reference task: reply exactly ORBIT.

Actual STT returned “apply with exactly this single word and no punctuation or bit.”. That text was passed unchanged to real Assistant inference, whose actual reply was “I am ready to apply the requested tool. Please specify the tool name or action you wish to perform.”. That reply went unchanged into actual Piper synthesis. The valid non-silent output was246316bytes/123136frames/mono22050HzPCM16/5.584399093s,SHA7557b916c4bd4087f10f06cb41a156cada24f43c9e80deb71624cc4088cff63e. No injected reference transcript, saved-answer substitution or cache claimed success.

The caller interval was16854.171509ms from available-file submission through output validation, excluding input recording duration, setup10432.664834ms, shutdown and playback. It is not a sensor end-of-speech boundary. Caller STT/Assistant/TTS intervals3385.510006/11164.148923/2222.815357ms differ from model spans3374.399990/1425.107026/2216.709570ms; do not label their differences as queue/protocol overhead. Correlationwav-flow-564fc2196d6e4d91a3c77ef08c7dcc16 joins the same-process sequential chain. Seven paired spans and20events are retained; parent links remainNULL. Queue,TTFT,first-audio,playback and independent network boundaries are unknown, not zero.

Bindings identify FasterWhisper/CTranslate2CPU int8_float32 and actual PiperCLI/model/config/output. Qwen constructorGPU100 and observed VRAM allocation do not prove actualoffload; no layer/kernel/offload log was captured in this pilot. Declaredseed42/threads2 were absent at the effective constructor. A separately reviewed five-file configuration repair now preserves those fields and verbosity, with one focused controlled-backend regression. It loaded no real model and does not fix this ASR result or prove GPU use. Docs check remainsEXIT2 because of owner-required experiment-report placement findings and an older broken campaign link; no evidence was deleted or checker weakened.

Root's source-only decode audit found the request/header rate consistent and one expected22050→16000conversion, with no deterministic source miswire. It did not establish why recognition failed. One failed fixed phrase is not a general model-quality estimate or proof the model can never work. It is a real failed task condition that must remain visible. Nine prior logical voice-readiness outcomes are retained; they are not nine complete STT→LLM→TTS chains. Setup/microphone-startup failures did not inflate those full-chain counts.

Manifestbcca2e64746b8b9f3f251abf9c4ee3d9714a6e4cb3b1d56f81f2c4ea288d7b21 lists31members includingREADME;33files total include outer and nested raw manifests. Monitor verified listed bytes/hashes once and read README/sourceaudit/spananalysis/retirement. Receiptmonitor/headless-full-audio-v477-verified-20261015T0248.json SHA1dc95716250931ecc4e0fb207ddf5d43f773d6b35a5890506bf6eaf4528e743d. Both ownPIDs were absent and both locks free02:38:55.532689UTC. These are bounded raw-evidence checks, not a new test or benchmark.

## 3. Objective → hypotheses → methods → evidence → conclusion

The objective should be to determine conditions under which authorized stage sharing helps a constrained assistant complete a defined task, and measure correctness, feasibility, latency and locality trade-offs against matched local and actual HTTP alternatives. Successful connection or valid speech output alone is insufficient.

| Question | Current supported answer | Required remaining evidence |
| --- | --- | --- |
| Does real audio input produce the correct full task and audio output? | One real chain executed but failed task correctness | Supported correction/admitted condition, actual engines/settings/locality, valid output and playback where claimed |
| How do local/API/mesh affect full audio p90/p95? | Unanswered; typed controls andn1failedpilot do not answer it |900measured per applicable NEW audio condition, extra warmups, outcome denominators and explicit boundaries/quantiles |
| Does cumulative remoteTTS→TTS+LLM→TTS+LLM+STT help a weaker device? | Unanswered |Same full pipeline/model/input/settings, actual per-stage provider map, honest local feasibility and real requester/provider pairs |
| Does a GPU improve the matched complete audio task? | Unanswered |New runtime acceleration proof and matched admitted CPU/GPU conditions; no pooling or borrowed old offload logs |
| What do locality/privacy/cost properties establish? | Source and particular mechanisms are inspectable; deployment-wide conclusions remain unsupported |Actual routes, payload/retention boundaries, permission outcomes, resource/network/cost records and explicit threat/limit model |

Both the abstract and conclusion must answer only these evidence-supported questions. Avoid converting a technology inventory—bus, gateway, WebRTC, JWT, RBAC—into an empirical conclusion. Successful typed latency is useful control evidence, not the central audio acceptance result.

## 4. Reversible bilingual drafts and chapter integration

Eight COMPLETE source-based draft files are under drafts/: four abstract/resumo files and cap05/cap06 in both existing language trees. The unified thesis-bilingual-evidence-corrections.diff is reversible against the exact checked Personal source bytes; draft-manifest.json records every source/draft hash. Canonical sources remain unchanged. No LaTeX compilation or thesis submission occurred.

The English tree currently has byte-identical English abstract.tex and resumo.tex. The new resumo draft provides actual Portuguese, while both language versions share the same evidence boundary. Existing sources in template latex already have English/Portuguese language counterparts; their updated drafts retain those roles.

| Thesis section, both languages | Concrete application |
| --- | --- |
| cap01: problem/objectives/contributions |Frame a comparative audio-capability question, bounded user-controlled resource sharing and negative outcomes. Keep architecture implementation separate from experimental confirmation. |
| cap02: background/related work |Use literature to motivate hypotheses and threats; it cannot prove Aurora latency, universal privacy, affordability or hardware feasibility. Keep the original review's source-specific citation corrections. |
| cap03: approach/modeling |Specify full audio stages, local/API/cumulative remote sets, requester/provider identities, same models/settings, clock domains and locality; separate deterministic audio from physical capture. |
| cap04: implementation |Describe actual production bus/gateway/stage bindings and telemetry boundaries; explain declared-versus-effective configuration propagation without treating a constructor option as acceleration proof. |
| cap05: evaluation/discussion |Replace undated “fresh151passed” with June historical attribution. Add separate CPU/GPU typed controls, the failed real-audio pilot, raw denominators and missing boundaries. All new primary claims map to experiment manifests. |
| cap06: conclusion/limitations |Replace “no metrics measured” with “bounded typed metrics exist; full audio/cross-device comparison unresolved.” State the task failure, missing acceleration/timing evidence and remaining acceptance scope. |
| Appendices/data availability |Index full raw manifests/source/model/input/settings and case history; document exact latency endpoints, failures/timeouts, session clustering, excluded warmups and inaccessible physical capabilities. |

Integrate these current-evidence corrections with the earlier23drafts during owner review; both packages reference the checked canonical snapshot. Do not apply competing historical/current prose without reviewing the combined result.

### White-paper corrections still required

The unchanged sistemas-distribuidos.md makes broad assertions about100%privacy, hardware coverage, necessary servers and negligible costs. The present evidence cannot establish them. Recast them as design goals or conditions, then link any empirical claim to actual boundaries and measured cost/resource/route evidence. The existing full review's architecture/citation corrections remain applicable; this addendum adds no new protocol-reference verification or invented bibliography entries.

Suggested Portuguese replacement for the current outcome paragraph:

> A arquitetura proposta permite configurar quais etapas do assistente são executadas localmente ou oferecidas por dispositivos autorizados. A avaliação deve determinar em que condições essa distribuição mantém a tarefa correta, permite executar uma carga inviável localmente e altera latência, consumo de recursos e exposição de dados. Os controlos digitados já executados e o piloto de áudio falho são evidências distintas; ainda não comprovam benefício geral de voz, privacidade global ou custo desprezível de operação.

Suggested English equivalent:

> The proposed architecture configures which assistant stages execute locally or on authorized devices. The evaluation must determine when this distribution preserves task correctness, enables a workload that is infeasible locally, and changes latency, resource use and data exposure. Completed typed controls and the failed audio pilot are separate observations; they do not yet establish a general voice benefit, deployment-wide privacy or negligible operating cost.

These are owner-review drafts, not a statement that the original white paper has been edited.

## 5. Figures, claims and citation discipline

Figure1 should show individual full audio stages and the cumulative remote placement conditions, with actual stage-provider mappings. Figure2 should show distributions per admitted condition, not a pooledCPU/GPU/device/stage curve. Table1 should list coverage/readiness andn_planned/n_attempted/n_measured/n_correct/n_failed/n_timeout. Table2 should distinguish caller, model and unexposed intervals. A failed pilot gets an outcome/case-history row; it does not become a successful p95 point.

The current bibliography bytes match the original reviewed files. The prior metadata/proposition audit remains a dated audit; it is not renewed verification of every reference. No new reference or numerical result has been invented here. Experimental claims cite the exact local data/source manifests; replacing missing experiments with a general systems citation is unacceptable. If final tables use later data, record their new versions and update both abstracts/conclusions together.

## 6. Execution gate, priority and owner decision

No iOS in active scope or acceptance denominator; retain its history. Required non-iOS surfaces, real approved requester/provider identities and applicableBR/PT/US/Android roles remain in the full plan. Same-hostHTTP/browser peers are not deployedAPI/cross-device acceptance. Waydroid is Android surface evidence, not physical-phone battery/thermal/radio or physical microphone proof.

Full audio is the next execution priority.900measured PER applicable new condition; warmups extra/excluded, failures/timeouts retained. Finish/seal required individual AUDIO AND SURFACE evidence before any measured cross-device traffic. Later real-device staged offload includes cumulativeTTS-only→TTS+LLM→TTS+LLM+STT with the rest local, full-pipeline correctness, declared mixed-load conditions, resource/network/ICE evidence and no hidden contention.

Original Root raised exactly one owner question: authorize one separately manifested stronger-STT condition with the same audio/task/model across CPU/GPU and originalfailure preserved, or retain the fixed-model failed condition. Submission is accepted; no answer is recorded. Root actual update_goal(blocked) followed by fresh get_goal(blocked) is reported in msg_f400db3ab069 at02:56:40, after the same unresolved boundary acrossV478/V479/V480. This is BLOCKED, not complete/cancelled, and does not shrink its full13-goal objective. No tests, models or new pilots are running. Do not duplicate owner questions, invent approval or create a replacement Root.

The original monitor remains the designated plan writer with native monitoring goal active. Runrun_e6054e76e9fc/Tasktask_d7ea336050cf/Dispatchctx_37b4d0a3c14f; Rootterm_6a00d9ee-792a-4daf-8578-236290e33108/incarnationfe7e63c7-d260-465f-b37e-f6fc78f8a1af; monitorterm_2eab47ed-ab9b-4e35-bd9b-fc068c60e3fc/incarnation37e50d9c-6cf5-4e28-a63b-f2bc3eed5661. Guidehermes:42a80e3a07e6d612ba5a491a74f42ff98a0098e316694808df506ddf430cb7d4. Continuous monitoring uses the existing native goal and bounded same-run FIFO checks/ACKs/heartbeats, not a new worker or daemon.

Next document acceptance is owner review of this addendum/diff and the combined thesis corrections. Next experimental acceptance requires an actual supported calibration decision/correctness fix, new effective settings/GPU proof/telemetry admission, then the declared conditions. No canonical thesis edit, commit/push, external publication, submission or new Telegram delivery is claimed.
