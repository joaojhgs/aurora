# Aurora TCC: source-supported white-paper and thesis re-review

Review snapshot: 2026-10-14 00:11 UTC. Status: completed analysis and reversible prose proposals for owner review; experimental evaluation remains in progress. This is a standalone, uncompressed Markdown review. It does not apply changes to the canonical thesis or declare the study complete.

The important correction is to organize the thesis around questions that its evidence can answer. The accessible material supports a proposed architecture, inspected implementation boundaries, and particular functional test results. It does not yet establish comparative p90/p95 latency, cross-region mesh benefit, physical-phone energy use, or whole-system privacy. Those conclusions must follow controlled measurements rather than a list of integrated technologies.

## 1. Ownership, source version and provenance

Owner objective: `tcc:20261013:submission-20261030`; submission target 2026-10-30 in America/Sao_Paulo, exact cutoff unknown. The owner authorized execution of full Aurora tests, benchmarks, builds and necessary test deployments, while keeping canonical thesis changes and submission gated by owner review. Android acceptance uses desktop Waydroid through the approved Orca relay. Company Work Claude is excluded.

The existing Aurora monitor remains `term_2eab47ed-ab9b-4e35-bd9b-fc068c60e3fc`, incarnation `37e50d9c-6cf5-4e28-a63b-f2bc3eed5661`, Run `run_e6054e76e9fc`, Task `task_d7ea336050cf`, Dispatch `ctx_37b4d0a3c14f`. Actual registered model/effort: `gpt-6.1-sol/xhigh`. The native monitor goal is `01a123ff-19ba-7332-a2f7-346a722af79f`, freshly confirmed ACTIVE with its full monitoring objective. Root is the original `term_6a00d9ee-792a-4daf-8578-236290e33108`, incarnation `fe7e63c7-d260-465f-b37e-f6fc78f8a1af`, native aggregate thread `01a112a5-d6bb-74e2-bf7c-ace73cb513b5`; Root supplied an actual ACTIVE goal read in `msg_51b4c54ac1ab`. Root owns serial executable validation and `/tmp/aurora-global-build.lock`.

Canonical TCC registration is preserved: project `repo:846e3e40-f48b-4e20-8aa7-88ef55b67da3`, workspace `846e3e40-f48b-4e20-8aa7-88ef55b67da3::/home/developer/projects/tcc`, host `ssh:ssh-1786238480967-semdev`. This review uses accessible personal synced artifacts; it does not prove the current remote canonical source is identical. No canonical TCC source was changed. Guide lineage remains `hermes:42a80e3a07e6d612ba5a491a74f42ff98a0098e316694808df506ddf430cb7d4`.

Aurora source snapshot: branch `codex/aurora-native-speech-routing-20261007`, HEAD `5782746afba213f6b36907db2f09f0017625e218`. At review start the tree was clean; at 00:06 UTC the observed dirty state was `?? docs/experiments/`, containing the declared documentation work. Later Root corrections must receive their own source/diff attribution. There was no monitor commit, push, new PR, build, benchmark, device control, or lifecycle adoption.

### Exact accessible artifact roots

- Personal synced TCC root: `/home/developer/Documents/Obsidian Vault Origin/5-full-notes/faculdade/tcc/`.
- Architectural white-paper source: `sistemas-distribuidos.md` under that root, SHA256 `49aa38f0556e1dba549b44c58aaea4e409b5b1874fd9cd9680349d8f94b6c77f`.
- English thesis source: `report-en/relatorio.tex`, `report-en/chapters/cap01.tex` through `cap06.tex`, both abstract files, appendices, and `report-en/lib/refs.bib`.
- Portuguese thesis source: `template latex/relatorio.tex`, `template latex/chapters/cap01.tex` through `cap06.tex`, abstract/resumo, appendices, and `template latex/lib/refs.bib`.
- Historical evidence: `.omx/artifacts/g10/evaluation-evidence.md`, `.omx/artifacts/g17/final-integrity-report.md`, `.omx/artifacts/g17/aurora-targeted-unit-final.log`, and `.omx/artifacts/g17/aurora-targeted-unit-final-junit.xml`.
- Citation audit sources: `.omx/artifacts/g13/url-doi-check.md`, `.omx/artifacts/g13/internal-evidence-audit.md`; these are historical audit records, not a fresh verification of every cited proposition.
- Original review package: `.omx/artifacts/tcc-20261013-submission-20261030-monitor-ctx_37b4d0a3c14f/`, including `REVIEW.md`, `source-manifest.json`, `claim-evidence-matrix.csv`, `thesis-and-whitepaper-drafts.diff`, and 23 complete reversible draft files in `drafts/`.

The original package records all 36 source paths and hashes. Its plan hash is a historical freeze, not the latest plan version. The original 829-line plan backup has SHA256 `323e3926af9d0e2cb23a3bf7eb3438e292fe56c55d8fd7b45d1ef18f164e6a00`; the expanded 1,095-line version has SHA256 `272c2be5123b1b6a59b18a08204a5e9a9d59f4b0c895eedd6048930dc6d95cd0`. The current owner-authoritative full plan is:

`/home/developer/Documents/Obsidian Vault Origin/5-full-notes/faculdade/tcc/future-work-test-requirements.md`

It now has 1,116 lines and SHA256 `a2615d9a744f4f5413ab9fee70b0a6928266d203682b8d7814eb2b5798d440d5`. Section 25 and the opening authorization notice record the latest execution approval, Waydroid scope and primary p90/p95 estimands. The 1,095-line backup and reversible diff are in the same project directory as this review: `test-plan.before-execution-authorization.md` and `test-plan.execution-authorization.diff`. All original T0–T13 tasks remain; this is an update of the full plan rather than a shortened replacement.

### Live paper-session lineage: explicitly unverified

The prior review honestly marked live paper lineage unverified. Fresh registered inventory inspection still does not identify an exact PERSONAL or UNIVERSITY Claude paper terminal/incarnation. The relevant project census verified the TCC and personal-vault registrations; the exact TCC workspace census returned zero registered terminals at its observed scope. Global inventory returned 12 registered rows across the hosts it exposed; that scope omitted the university host. Absence from these inventories does not prove a session stopped or never existed.

Supported inventory receipts are `d15209ac-2a58-483d-9a29-1cbb99880686` (relevant projects), `3b790d1d-884c-4e32-abcf-db8f499c1117` (TCC workspace terminals) and `a25e7551-093c-45fa-b631-c7263dcb4899` (global registered census). The current CLI rejects the attempted host-filter flag before selecting a host; it cannot establish the omitted host's state.

The existing Personal coordination session is Hermes, terminal `term_8109a3ac-570e-4c3f-a7ac-e68e36764b2b`, incarnation `468a0928-9867-4612-b5f2-e7631784582d`, on `ssh:ssh-oci-coding-worker`. It is an authorized delivery/coordinator route, not proof of a Claude paper session. The exact existing Personal session received a lineage/delivery request, request ID `67b503fc-d6b5-4bf2-8081-95832cf02313`. Input acceptance is not a Telegram delivery receipt.

The registered company Claude row is on the Work notebook. Its terminal was not read or contacted for this review. The owner-reported new Personal Run `run_8e16b490b21b` / Task `task_c2f1ff86c6f3` failed launch with `workspace_occupied`; it was not retried or adopted. Existing accessible manuscript bytes support this review despite missing live-session evidence.

The official proposal PDF `propsal-3-0.pdf` exists, SHA256 `b5f6185b6ee6dc409526d9d88cd129af0a8a092affe249603ca1d2ef4a780cd5`; its referenced cached extracted text is missing and `pdftotext` was unavailable. This review does not attribute an exact official objective to unread extracted PDF text. The research questions below are explicit review proposals derived from the accessible thesis and owner-approved evaluation scope.

## 2. Evidence ledger: what has actually happened

| Evidence | Verified finding | What it supports | What it does not establish |
|---|---|---|---|
| June 16 targeted JUnit and console | 159 cases, 8 skipped, 0 failures, 0 errors: 151 passed; JUnit timestamp `2026-06-16T14:42:47.241838-03:00`, JUnit duration 16.048 s | That historical targeted functional subset passed in its recorded environment | Current validation, full-suite acceptance, current source identity, live multi-region performance |
| Accessible source/manuscript review | Paths, source hashes, bibliography keys, prose claims and implementation descriptions were inspected | Traceable analysis and bounded architecture statements | Deployed behavior, security guarantee, benchmark measurements |
| Current Root full unit T1 | Exit 1; finished `2026-10-14T00:04:58.386632Z`; 3,987 cases, 71 skipped, 1 failed, 0 errors: 3,915 passed | Fresh broad functional evidence at source `5782746afba213f6b36907db2f09f0017625e218`, with a concrete remaining failure | A passing full gate, mobile acceptance, deployed/API/mesh benchmark results |
| Current T1 failure | `tests.unit.tools.test_pockettts_language_packs::test_runtime_staging_excludes_stale_fp32_and_builder_files`; expected staging files versus actual empty set. Root traced its archive exclusion to fixtures placed under `.git` by the harness | An attributable test-temp confound needs corrected-location verification | A proven product staging regression or that every PocketTTS path or device is broken |
| Waydroid relay inventory | Booted and available `personal-distrobox · WayDroid_x86_64_Device` | An available Android test target at observation time | Phone battery, thermal, radio, OEM kill or physical-device Doze behavior; installed app version |
| Local/API/mesh measurements | No new benchmark requests or raw comparative latency observations available in this snapshot | Nothing quantitative yet; the plan and baselines are specified | Any p90/p95 number, mesh speedup, capacity gain, or cross-region conclusion |

Current T1 raw evidence is under `/home/developer/projects/aurora/.git/aurora-handoff-import-20261006/t1-unit-v235/`: `manifest.json`, `live-handle.json`, `result.json`, `junit.xml`, `stdout.log`, `stderr.log`. The monitor read the manifest/live handle, result and JUnit metadata; it did not claim to reread every console line. Root owns full-log review and publication of appropriate execution evidence in project docs. Private configuration/environment backups remain outside published docs.

T1 started `2026-10-13T23:54:58.921893Z`, had a 900-second timeout and a 10-second TERM grace, and completed in 599.465 seconds. The result explicitly records `deadlineReached=false` and `globalLockContended=false`. Protected configuration files were unchanged. This was a functional run on a loaded two-logical-CPU host, not a clean latency experiment. Failure and elapsed-time evidence must not be repurposed as an inference benchmark.

The monitor supplied this exact result to Root in `msg_d8eed7219ef6` and requested a targeted staging verification before another full-suite repetition. The failing gate is real progress toward a finite repair, not grounds to add speculative edge-case matrices.

Root's subsequent primary-read report `msg_2debc654fcc5` attributes the empty staging archive to the harness: `_sorted_archive_paths` excludes paths whose absolute parts contain `.git`, and this run placed its test fixtures below `.git/aurora-handoff-import`. Root will change only the owned test temporary directory to `/tmp`, verify the failed case and related archive checks once, and preserve the original failed raw run. This is a reported, concrete cause; the corrected targeted outcome is still pending in this snapshot. Weakening the production exclusion or adding an unrelated source fix is not justified by this evidence.

## 3. Objective and hypotheses: make the scientific comparison explicit

Suggested objective: determine when authorized sharing of computation lets a constrained Aurora client complete a specified task, and quantify the trade-offs between local execution, a deployed API and a mesh route under matched tasks, models and settings. Preserve user control and examine data exposure as measurable properties, rather than equating encryption or local-first design with a universal privacy guarantee.

The experiment has four bounded questions. They may receive negative or inconclusive answers; architecture feasibility alone must not be counted as confirmation.

| Question / proposed hypothesis | Required comparison and control | Evidence needed | Present answer |
|---|---|---|---|
| RQ1 / H1: Does route choice change successful-request p90/p95 latency? | Local-only, deployed API and mesh; equal input, model/weights/quantization, seed, generation limits, tool work and cold/warm condition. Compare API and mesh on the same capable provider when estimating route overhead | Raw per-request timings, declared endpoint timestamps, sample/timeout/failure denominators, route provenance, independent session blocks | Unanswered; no comparative measurements in this snapshot |
| RQ2 / H2: Can a constrained device finish a useful task through offload that it cannot admit or finish locally? | Same heavy task/model; bounded local attempt or static admission limit, API offload and mesh offload; correctness and resource observations | Explicit local infeasibility/OOM/timeout category, remote correctness, end-to-end completion time and resource/cost measurements | Unanswered; do not invent an infinite speedup when local execution fails |
| RQ3 / H3: Which stages explain direct/relay/cross-region latency and recovery? | Measured discovery, scheduling/queueing, authorization, serialization, encryption, transport and relay stages; direct versus relayed routes with observed RTT/bandwidth/loss | Correlated stage timestamps, network characterization, actual selected path, bounded failure/reconnect trials | Unanswered; protocol descriptions do not substitute for route observations |
| RQ4 / H4: What locality, permission and operational-cost trade-offs accompany offload? | Identify input/output/metadata retained at client, provider, API or relay; explicit permissions, local storage and cost accounting | Redacted boundary traces, deny/revoke/offline behavior, configured retention, traffic and billed/resource quantities | Partly assessable from source and tests; whole-system and deployed claims remain open |

Do not preregister a conclusion that mesh always wins. Equal-model comparisons may show API and mesh similar, local faster for small tasks, or relay/network overhead dominating. The scientifically useful result is the condition under which a feasible job, lower tail latency, or greater retained control occurs, with its limitations.

The word “democratization” needs a bounded definition: making a specified computational capability accessible to a weaker client through authorized resource sharing. The present design and protocol do not measure population adoption, affordability across households, socioeconomic access or user satisfaction.

## 4. Abstract → methodology → evidence → conclusion audit

Both language versions should express the same study, evidence date and limits. The inspected abstract endings currently infer capability sharing and retained control from an implementation analysis. That conclusion is broader than targeted tests and inspected boundaries alone can establish for live cross-region deployments. Replace that ending with a source-and-date bounded statement until the controlled evaluation finishes.

### Proposed English abstract, owner-review draft

> This study examines whether a constrained voice-assistant client can complete specified computational tasks by using authorized resources on another device, and how that choice changes latency, feasibility and data exposure. Aurora provides the implementation examined in the study. The proposed evaluation compares local execution, a deployed API and a mesh route using the same tasks, model versions and execution settings, with successful-request p90 and p95 latency, completion and failure counts, and resource observations. Inspection of the accessible source and a targeted June 2026 functional-test record supports bounded statements about the architecture and access-control interfaces. A fresh October full unit baseline recorded 3,915 passed cases, 71 skips and one staging failure requiring correction. Comparative latency and weak-device offload results are not established by these records. The thesis therefore distinguishes implemented mechanisms and functional evidence from the measurements still required to answer its research questions.

This is a snapshot-aware draft, not a final abstract. After actual experiments, replace the pending-result sentences with measured estimates, denominators and conditions, then shorten to the institution's required length. Do not silently replace an earlier source result with a later result without updating its version and date.

### Resumo proposto em português, rascunho para revisão do proprietário

> Este trabalho investiga se um cliente de assistente de voz com recursos limitados consegue concluir tarefas computacionais definidas ao utilizar recursos autorizados de outro dispositivo, e como essa escolha altera a latência, a viabilidade e a exposição de dados. O Aurora fornece a implementação examinada. A avaliação proposta compara execução local, API implantada e rota em malha com as mesmas tarefas, versões de modelo e configurações, considerando os percentis p90 e p95 das requisições concluídas, os totais de conclusões e falhas e o consumo de recursos. A inspeção do código acessível e um registro de testes funcionais direcionados de junho de 2026 sustentam afirmações delimitadas sobre a arquitetura e as interfaces de controle de acesso. Uma execução completa e recente dos testes unitários, em outubro, registrou 3.915 casos aprovados, 71 ignorados e uma falha de preparação de arquivos que ainda exige correção. Esses registros não estabelecem resultados comparativos de latência nem benefícios medidos da execução remota para dispositivos limitados. A tese distingue, portanto, mecanismos implementados e evidência funcional das medições ainda necessárias para responder às perguntas de pesquisa.

Os dois textos usam o mesmo recorte temporal e não transformam 151 aprovações históricas em uma validação atual. Os números de outubro só podem constar de uma versão final se seu artefato, revisão de código e estado de correção forem citados explicitamente.

### Claim chain that every final conclusion must satisfy

1. State the question and the practical task, not just the technology used.
2. Define the outcome and comparator before reading the result.
3. Cite the executable/source version, manifest and raw case records.
4. Report successful observations and all attempted, failed and timed-out requests.
5. Describe uncertainty and network/resource conditions.
6. Answer the question only within those conditions; carry the same limitation into abstract and conclusion in both languages.

## 5. Methodology: controls that make the eventual measurements interpretable

The full authoritative plan remains the execution specification. Its country/device table separates intended geography from verified inventory. Brazil semdev server, Portugal personal notebook and US VPS must have their location and capabilities verified through authorized inventory or documentation; hostname and relay ID alone do not verify country. The observed overloaded US/Portugal resource sample is readiness/confounding evidence, not a benchmark or cleanup authorization. Unknown capabilities remain conditional readiness items.

Cover native/local clients, desktop-local and desktop-remote surfaces, browser clients and Android Waydroid, plus deployed API and P2P mesh execution. Preserve all intended directed pairs and supported application multi-hop cases. Label unsupported routes as unsupported, with a capability/source reason. ICE traversal or TURN relaying is not automatically application-level multi-hop job routing. Direct/relay/NAT/fallback labels must reflect the route actually observed during the case.

For matched-model comparisons record the exact task input hash, model identifier and weight hash, quantization, tokenization, seed, temperature, maximum generated tokens, thread count, acceleration and tool configuration. Report unavailable parity rather than comparing two different models as a pure transport speedup. A larger remotely available model belongs in a separate capability experiment with explicit quality criteria.

The plan proposes at least 300 attempted observations per must-have latency cell across three independent session blocks after warmups; 1,000 observations for optional tail analysis are an additional approved-budget choice, not a prerequisite that blocks the core study. Treat session blocks as the independent repetition unit where shared load and network conditions couple requests. Fix the success, timeout and correctness rule per task before execution. The initial pilot is bounded to at most 10 requests and 10 minutes; its p90/p95 estimates are descriptive and unstable, not a precise tail claim.

Primary quantiles are successful-request p90/p95. Use the declared Type 7 calculation: sort the successful latencies, set `h=(n-1)*p`, and linearly interpolate between indices `floor(h)` and `ceil(h)` using zero-based indexing. Always publish `n_success`, `n_total`, failure categories and timeout counts beside the quantiles. Timeouts are censored outcomes with their actual configured deadline; do not omit them silently, convert them to exact successful durations, or pool them into a normal successful-latency distribution. p50/p99 may supplement the primary results; a small sample does not justify a stable p99 claim.

Control background load, record CPU/RAM availability and storage headroom, randomize or counterbalance route order, separate cold from warm sessions, and describe shared-provider contention. A loaded baseline can be useful if it is explicitly a loaded condition, but it must not masquerade as a clean route comparison. Discovery, pairing and model loading should be either included in a declared end-to-end cold outcome or recorded separately from warm request latency.

For generative work distinguish request-to-first-response from first generated token and full completion; report TTFR/TTFT and tokens per second only when the task and clock boundaries make them meaningful. Throughput and concurrency require recorded arrivals, service/queue times, saturation and failures. CPU, RAM, network and storage observations require a sampling interval and measurement scope. Any stage decomposition should disclose unresolved spans; overlapping stages must not be added as if serial.

For a weak-device cell, perform one bounded admission/feasibility investigation per relevant task/model condition. An observed infeasible local condition closes that local cell with a reason; it does not justify hundreds of OOM retries. Report correctness and end-to-end feasibility for API and mesh alternatives. Device capability and output quality are separate from faster routing.

Failure/reconnect/offline cases should cover required main flows with explicit deadlines and failure categories, not an unbounded collection of speculative edge cases. Once a passing gate is closed, rerun it only for a relevant source delta or unresolved acceptance gap. Root owns execution and integration; the monitor supplies evidence-backed bounded nudges.

### Minimum raw record and reproducible manifest

Each attempted case needs a stable experiment/session/case/request ID; UTC observation time and monotonic timing span; source commit and dirty-diff hash; client/provider identifiers; verified versus intended location; surface and actual route; input/model/settings hashes; cold/warm and repetition index; configured timeout; success, correctness result or categorized failure; total latency and relevant first-response/token spans; stage/queue/relay observations with explicit unknowns; network RTT/bandwidth/loss context; resource samples; and raw-log references.

The manifest should record commands, dependency/runtime versions, hardware, relevant redacted configuration, model/task artifacts, route readiness, randomization order, sample budget, warmups, quantile method, exclusions and cost assumptions. Preserve all attempts and case history, including a failed pilot. Record privacy-sensitive fields as redacted or hashed; hashes do not by themselves establish that the provider never received the raw data.

Root should store full safe execution logs, raw data, case history and readable methodology/results Markdown under the project study docs. The monitor-owned subdirectory contains review, authorization diffs, ownership/event receipts and observation history. Private configuration/environment backups are not publication artifacts. Completed unit suites and performance data should have separate outcome tables.

## 6. Architecture and citation corrections

The short architectural paper is a concept note with broader claims than the later thesis. Its rewrite should preserve the idea while narrowing the assertions:

| Source claim / issue | Required correction | Evidence boundary |
|---|---|---|
| All commercial assistants process remotely or keep recordings universally for 24 hours | Remove universal wording; identify a specific product, policy version, setting and primary source before making a comparative claim | The accessible note supplies no current product-policy evidence for a universal claim |
| “100% private”, immediate deletion or no server logs | Replace with an explicit trust boundary, storage/retention configuration and observations; consider endpoint compromise and metadata | Local-first architecture and encrypted transport do not prove whole-system privacy |
| STUN/TURN as the only signaling server | Separate application signaling from connectivity checks, NAT traversal and relay service | The W3C WebRTC specification treats application signaling separately; ICE and data-channel standards specify narrower transport mechanisms |
| Negligible cost or no extra resource use | State this as an untested cost hypothesis; measure relay traffic, CPU/RAM, model/storage, electricity or billed charges with assumptions | No relevant raw cost experiment is available here |
| Only IP information reaches infrastructure | Inventory endpoint, relay and signaling metadata, retention and logs under deployed configuration | Encryption does not imply metadata absence |
| Medium devices must offload LLMs | Define the exact task/model/resource condition and local feasibility; report configurations that do run locally | Hardware classes alone are too vague |
| Nostr, stronger intelligence or alternative routing treated as delivered capability | Label design alternatives and future work; cite current implementation/version before a delivered claim | Proposal language is not implementation or measured quality |

Primary protocol references inspected for the original review were the [W3C WebRTC Recommendation](https://www.w3.org/TR/webrtc/), [RFC 8445: ICE](https://datatracker.ietf.org/doc/html/rfc8445) and [RFC 8831: WebRTC Data Channels](https://datatracker.ietf.org/doc/html/rfc8831). They support specific protocol explanations, not Aurora's end-to-end performance or security acceptance. The earlier reversible bibliography patch records the verified W3C Recommendation date of 13 March 2025; owner review is still required before canonical application.

Local bibliography checks found 32 unique entries in each language version, no missing cited keys and no duplicate keys. English used 27 unique keys, with five uncited entries (`abdelmoniem_edge_ai_2024`, `aurora_design_proposal`, `fastapi_openapi_docs`, `minder_voice_assistants_2023`, `nist_rbac_project`); Portuguese cited 32. This establishes local key consistency, not that every reference exists, is the best reference, or supports its attached claim. The June URL/DOI audit is historical and should retain its date. Avoid invented references or placeholder empirical citations.

If review-method disclosure is retained, distinguish it from thesis subject evidence. The original review checked the primary record for Scientific Agent Skills, Kassis et al. (2026), DOI `10.48550/arXiv.2609.00065`, [arXiv record](https://arxiv.org/abs/2609.00065), last revised 2026-09-02. That citation attributes review assistance; it is not evidence that Aurora's scientific claims are correct. No automated review role should be presented as an independent human reviewer or as a measured accuracy guarantee.

## 7. Chapter-by-chapter application, English and Portuguese

These proposals supplement the 23 complete draft files in the original package. They are reversible text suggestions; none has been applied to the canonical manuscript. Use the same study logic in both language trees.

| Chapter / source | Main correction | Required output |
|---|---|---|
| 1, `cap01.tex`, both versions | Lead with the task, constrained-client problem, four bounded questions and explicit objective; define computational accessibility narrowly | Objective/RQ-to-outcome table; no population adoption or automatic superiority claim |
| 2, `cap02.tex`, both versions | Select related work by which question/control it informs; separate signaling, connectivity, authorization, scheduling and privacy concepts | Comparison grounded in primary sources; distinguish protocol capability from actual Aurora observations |
| 3, `cap03.tex`, both versions | Make the matched local/API/mesh protocol, units, sample blocks, timeout denominators, Type 7 quantiles and route observation explicit | Manifest/raw-schema link; preregistered correctness and feasibility rules; optional cases cannot delay must-have evidence |
| 4, `cap04.tex`, both versions | Retain architecture details that explain the experimental boundaries; shorten unrelated technology inventory | Versioned route/task/permission sequence and a clear client/provider trust boundary |
| 5, `cap05.tex`, both versions | Separate source inspection, June tests, fresh October functional evidence and comparative measurements | Evidence table with dates/hashes; no invented latency, capacity, battery or privacy result |
| 6, `cap06.tex`, both versions | Answer each RQ only to the extent measured, then list specific remaining uncertainty | RQ/evidence/answer/limitation table aligned with abstract |
| Abstract/resumo and appendices | Carry identical scope and status into both languages; appendices should make the dataset reproducible | Same evidence counts/dates and quantitative limits; raw/log/manifest references rather than unsupported adjectives |

### Introduction: replacement objective paragraph

**English draft.** The objective is to assess whether authorized offload enables a resource-constrained Aurora client to complete defined tasks, and to compare the resulting latency, feasibility and data exposure with local execution and a deployed API under matched models and settings. The study distinguishes the overhead of the route from changes in model capability. It does not assume that remote execution is always faster or that encrypted communication removes every privacy risk.

**Rascunho em português.** O objetivo é avaliar se a execução remota autorizada permite que um cliente Aurora com recursos limitados conclua tarefas definidas, comparando a latência, a viabilidade e a exposição de dados com a execução local e uma API implantada, sob os mesmos modelos e configurações. O estudo distingue o custo da rota de comunicação das mudanças na capacidade do modelo. Não se pressupõe que a execução remota seja sempre mais rápida nem que a criptografia elimine todo risco à privacidade.

### Methodology: replacement outcome paragraph

**English draft.** The primary latency outcomes are p90 and p95 among requests that complete successfully under the declared correctness rule. Each reported quantile is accompanied by the number of successful requests, all attempted requests, categorized failures and configured timeouts. Quantiles use Type 7 interpolation on sorted successful observations. Runs are divided into independent session blocks, with model/task parity, background load and cold or warm state recorded in the manifest. A local infeasibility result is reported as such rather than converted into a successful latency or an infinite speedup.

**Rascunho em português.** Os desfechos principais de latência são p90 e p95 entre as requisições concluídas com sucesso conforme a regra de correção declarada. Cada percentil é acompanhado do número de sucessos, do total de tentativas, das falhas categorizadas e dos limites de tempo configurados. Os percentis usam interpolação do tipo 7 sobre as observações bem-sucedidas ordenadas. As execuções são divididas em blocos de sessão independentes, e o manifesto registra a equivalência do modelo e da tarefa, a carga de fundo e a condição fria ou aquecida. A inviabilidade local é relatada como tal, sem ser convertida em latência de sucesso ou ganho infinito de velocidade.

### Results: replacement evidence-boundary paragraph

**English draft.** The June targeted test artifact records 151 passed cases and eight skips. It supports the particular functional boundaries exercised at that time. The October full unit baseline at commit `5782746afba213f6b36907db2f09f0017625e218` records 3,915 passed cases, 71 skips and one staging failure; correction and fresh targeted verification remain pending in this snapshot. Neither record is a local/API/mesh benchmark. Comparative latency, weak-client feasibility gains and deployed route overhead will be reported only from traceable raw observations, including failed and timed-out attempts.

**Rascunho em português.** O artefato direcionado de junho registra 151 casos aprovados e oito ignorados, sustentando os limites funcionais exercitados naquele momento. A execução completa dos testes unitários de outubro, no commit `5782746afba213f6b36907db2f09f0017625e218`, registra 3.915 casos aprovados, 71 ignorados e uma falha de preparação de arquivos; sua correção e nova verificação direcionada permanecem pendentes neste recorte. Nenhum desses registros constitui um benchmark local/API/malha. A latência comparativa, os ganhos de viabilidade para clientes limitados e os custos de rotas implantadas serão apresentados apenas a partir de observações brutas rastreáveis, incluindo tentativas com falha e limite de tempo excedido.

### Conclusion: replacement answer paragraph

**English draft.** The available evidence supports describing an implementation that separates assistant services, exposes authorized remote task boundaries and permits a controlled comparison to be conducted. It does not yet answer whether mesh execution improves p90/p95 latency or completes the proposed heavy jobs more effectively than the matched alternatives. Those answers depend on the planned measurements and their conditions. The contribution at this stage is the bounded implementation analysis and reproducible evaluation protocol; any empirical advantage must be stated only after the corresponding data are available.

**Rascunho em português.** A evidência disponível sustenta a descrição de uma implementação que separa os serviços do assistente, expõe limites autorizados para tarefas remotas e permite realizar uma comparação controlada. Ela ainda não responde se a execução em malha melhora p90/p95 ou conclui os trabalhos pesados propostos de forma mais eficaz que as alternativas equivalentes. Essas respostas dependem das medições planejadas e de suas condições. A contribuição neste estágio é a análise delimitada da implementação e o protocolo de avaliação reproduzível; qualquer vantagem empírica deve ser afirmada somente após a obtenção dos dados correspondentes.

## 8. Thesis figures, tables and claim traceability

| Proposed figure/table | Claim it may support | Necessary source |
|---|---|---|
| Task/route/authorization sequence | How the tested task crosses boundaries | Versioned implementation references plus actual route trace |
| Hardware and readiness table | Which declared environments were available | Authorized inventory and manifest; country/capability unknowns visible |
| Paired p90/p95 latency plot | Conditional route differences for the same task/model | Raw attempts, successful quantiles, total/failure denominators and session uncertainty |
| Weak-device feasibility table | Correctly completed remote job versus a documented infeasible local condition | Admission/failure reason and correctness results for each comparator |
| Stage/queue/relay decomposition | Where observed end-to-end time was spent | Correlated clocks/spans, unresolved spans and actual path |
| Functional and failure/reconnect table | Required main-flow behavior under declared boundaries | Fresh logs/source version, exact target and failure denominators |
| Locality/privacy/cost table | Observed data destinations, retention and operational trade-offs | Redacted boundary/configuration observations and measured or declared cost assumptions |

Do not populate empty plots with simulated results presented as measurements. A design diagram can be labeled as a design diagram. Every empirical sentence in abstract/results/conclusion should map to a case set and artifact; every figure caption should state the observation count and scope.

## 9. Prioritized corrections and Oct 30 schedule

**P0, before any owner-ready thesis revision:** narrow universal privacy/performance/cost claims; distinguish all June evidence from October; keep live paper provenance unverified until an exact authorized terminal/incarnation or session evidence is supplied; align both abstracts and conclusions with the same questions and actual evidence. Retain traceable source versions and preserve canonical owner review.

**P1, finite execution sequence:** Root verifies the diagnosed T1 test-temp confound with the corrected owned temporary location and targeted checks; close unaffected passing gates. Then verify the owning-host/relay capability and run the bounded matched-model pilot. Its case history must include failures, timeout counts and route/host conditions. Admit the planned main sample blocks only after pilot readiness and budget are known; no monitor benchmark or duplicate validator.

**P2, must-have thesis evidence:** establish at least one valid matched local/API/mesh task comparison and one useful constrained-device feasibility comparison; preserve the planned platform/main-flow and directed-route coverage with explicit completed, failed, unavailable or unsupported dispositions. If a route/model is unavailable, narrow the corresponding claim rather than imply full coverage. All planned cases receive a disposition; missing cases are not passes.

**Optional:** additional model families, a 1,000-observation tail extension, extra concurrency sweeps, unsupported multi-hop implementations, broader aesthetic reviews and physical-phone energy/radio experiments cannot delay the core evidence. Android Waydroid satisfies the owner's Android surface target; phone energy/thermal/radio results remain outside that evidence.

Proposed staging, subject to actual readiness: Oct 14–16 repair/readiness/pilot and freeze manifests; Oct 17–22 execute the finite must-have comparisons and planned main-flow cases; Oct 23–25 analyze and draft figures/results; Oct 26–28 reconcile both language versions and owner review; Oct 29 freeze reproducible artifacts and submission candidate; Oct 30 owner-controlled delivery before the still-unknown local cutoff. These are target dates, not promises or records of completed work. Canonical application and submission require owner review; routine already-authorized test execution does not require redundant permission.

## 10. Durable monitoring mechanism and remaining genuine limits

The verified monitor mechanism is the original persisted native Codex Goal, confirmed ACTIVE after the supported `/goal resume`, plus the same Run's durable Orca FIFO mailbox with bounded `check --wait` calls of at most 45 seconds. There is no fabricated `/go` invocation or new polling agent. Official OpenAI documentation describes [goal resume and continuation at safe boundaries](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex); actual native goal reads, rather than screen labels alone, confirm the resumption here.

Personal observed event journal `a687f2af-9d7b-47eb-89ed-2d37dc8e0773`, sequence 751, with no reported gap at that snapshot, and an existing bounded event wait. Independently observed service state: `hermes-gateway.service` active/running PID 3883268; dedicated `hermes-orca-manager.service` inactive/dead PID 0. This review does not claim the dedicated Manager service is active. The monitor's Manager snapshot command failed with “Manager service credential is not configured”; no credentials or service permissions were changed and no duplicate Manager was created.

Remaining limits are concrete: the sole fresh unit failure needs corrected-temp targeted verification, after Root's reported harness diagnosis; actual comparative raw latency data do not exist in this snapshot; the approved SSH emulator relay cannot itself perform raw exec or APK install, so any necessary scripted deployment needs an existing authorized owning-host route; live PERSONAL/UNIVERSITY Claude paper lineage remains unverified; canonical remote thesis freshness and owner acceptance are not established by synced artifact access; the exact Oct 30 cutoff is unknown. These limits do not block producing this source-supported review.

The Personal delivery route is authorized for the existing Telegram topic 2. This Markdown file is the requested review artifact; its accepted terminal delivery and any actual Telegram message ID must be recorded separately. File creation or Personal input acceptance alone must never be reported as owner delivery, acceptance, thesis submission or aggregate goal completion.
