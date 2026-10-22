# Authorized matrix extraction (V755)

Read-only extraction from the authoritative owner snapshot through §30.37 and the current public Root status. This is not a new methodology plan, cell authorization, source review, or runtime result. The owner snapshot explicitly excludes active iOS work; the current `CURRENT.md` is used for the newer execution state where it supersedes dated snapshot checkpoints.

## Explicitly required matrix dimensions

**Active surfaces (non-iOS only).** Owner snapshot §26.0 excludes iOS from active coverage and denominators (lines 1119–1123). §14 names these applicable surface families (lines 868–880):

| ID | Surface | Required boundary / limitation |
|---|---|---|
| S-N | Native/headless local node | Production local engine/service, authenticated API, and authorized native mesh are separate. A crate-only engine result is not Assistant/UI/history proof. |
| S-DL | Desktop Tauri local | Compare the same desktop action across local/API/mesh; distinguish daemon capture from focused WebView PTT. |
| S-DC | Desktop remote-console client | Local capability is conditional; keep runtime role independent from desktop surface. |
| S-B | Browser/web client | Only a genuinely supported on-device browser counts as local; API requires deployed auth; mesh requires browser authority and supported peer session. |
| S-A | Authorized Waydroid Android native app/WebView; physical Android only if eligible | Native/local, API, and authorized mesh rows are separate; capture, rendered reply, and saved history have separate evidence. |

The surface × role × route × model × workload factors form a **finite applicable registry, not a full Cartesian product** (§14 lines 870–882; §26.3 lines 1150–1175). iOS receipts remain historical/excluded by owner, not missing active cells (§26.0, 1121–1123; §26.3 row H-IOS, 1173).

**Execution modes and cumulative stages.** §27.1 (lines 1207–1227) makes the current staged feature comparison cumulative and keeps unassigned stages local:

| Mode | Remote stages in the same complete request | Required comparison |
|---|---|---|
| K0 | None | Production local Python calling; actual engine/backend/surface must be evidenced. |
| K1 | TTS | Same full flow, actual HTTP API and production P2P mesh TTS; capture/wake, STT, orchestration/LLM, tools, playback/history remain local. |
| K2 | TTS + LLM/orchestration | Same full flow over HTTP and P2P; STT and unassigned tools remain local. |
| K3 | TTS + LLM/orchestration + STT | Same full flow over HTTP and P2P with correlated speech/text/audio stages; capture/wake, unassigned tools, playback/history remain local. |
| K4+ | Further stages only when expressly applicable/authorized | No implicit wake-word forwarding or added privacy authorization. |

Order K1 → K2 → K3, retain both same-device controls and real cross-device sweeps, and do not substitute a centralized R0 server for partial K1/K2 (§27.1 lines 1215–1227). Older P1–P5 single-resource descriptions and the frozen same-host typed-request study remain provenance/control evidence, not replacements for K1–K3 (§27 lines 1207–1211; §28.2 line 1271). Every request needs expected **and observed** `stage_provider_map`; configured placement alone is not proof (§27.1 lines 1226–1227).

**Plan-listed directed device pairs.** §15 explicitly lists 12 directed requester/provider pairs (lines 884–895): BR→PT/US/M; PT→BR/US/M; US→BR/PT/M; M→BR/PT/US. §26.3 additionally enumerates all six directed BR/PT/US edges plus eligible mobile directions (rows C03–C04, lines 1161–1162) and says to enumerate applicable approved combinations (line 1175). These are planned directions, **not proof that a device, grant, endpoint, or route currently exists**. `M` is not a verified physical identity. Section 26.2 names owner-requested BR server, PT personal notebook, US VPS, A-W Waydroid, and possible M-P physical Android, but requires host/region/capability/source/model proof; A-W→BR on the same semdev host is co-located/emulated and is not cross-region proof (§26.2 lines 1134–1148).

Route class is also a condition dimension: direct selected ICE, TURN/relay, deployed API, fallback-local, redirect-to-authorized-peer, or no feasible authorized fallback (§15 lines 897–906). Selected route evidence is required; configured TURN or successful signaling is insufficient. Multi-hop application-stage composition remains unsupported/readiness-unknown until production routing and every-hop grants exist (§15 lines 908–910).

**Concurrency/load.** Coverage registry rows key requester/provider, physical-host relation, surface/role, workload, mode, route, source/model, cold/warm, and concurrency (§26.3 line 1152). The mandatory family list includes initial concurrency 1/2/4 and finite recovery/revocation/redirect cycles with queue, offered/completed rate, fairness, and duplicate-effect evidence (§26.3 row C12, line 1170). Section 29 requires separate controlled-unloaded reference and declared mixed-local-user-plus-mesh load/concurrency conditions; local+mesh sharing is an expected phase-2 study scenario, not automatically invalid interference (lines 1315–1321). These are explicitly named condition families, not permission to multiply every dimension into unbounded combinations (§26.3 line 1175).

## Per-condition allocation and phase barrier

- **Allocation:** 900 measured requests **per applicable condition**, independently for local Python, deployed HTTP API, and each K1/K2/K3 P2P configuration for each applicable non-iOS surface, requester/provider pair, workload, model, and settings condition (§27.2 lines 1229–1235). Do not split or pool across modes/devices/stages. Warmups are additional and excluded. Current matched audio conditions use 15 excluded warmups; the exact count must be pinned per frozen condition (CURRENT.md lines 13–20; owner snapshot §30.34 lines 2019–2025). Historical V491’s 900 requests use the original, different WAV and remain extra CPU evidence, not the new padded comparison (CURRENT.md lines 18, 22–24; §30.34 lines 2023–2024).
- **Denominators:** attempted incorrect, failed, timeout, cancelled, and interrupted measured requests remain in measured totals; success percentiles use successful population and preserve failure counts. Keep `n_planned=900` even when capability prevents a run; label bounded `infeasible_before_main` or `unsupported_documented`, with evidence, instead of manufacturing requests or forcing repeated OOM (§27.2 lines 1237–1241). Missing telemetry is `null` plus reason, never zero (§27.3 lines 1261–1263).
- **Individual-baseline barrier:** phase 1 finishes and seals required individual CPU and verified desktop-GPU performance baselines, isolated from measured cross-device traffic. Phase 2 begins only after both campaigns naturally finish, seal raw/result/manifest hashes, reconcile owned resources, and Root records the explicit transition; a pilot, initial sample, dispatch, or one finished campaign does not satisfy it (§29 lines 1309–1323). Current Root status still has V745 desktop continuation and worker V737 in progress (CURRENT.md lines 3, 30, 50), so this barrier is not yet met. Current status says no measured cross-device route is admitted and its endpoint/peer/grant/stage-provider/notebook evidence is incomplete (CURRENT.md lines 28, 51; snapshot §30.36 lines 2114–2118).
- **Cell-specific blockers:** the comparable performance boundary is controlled audio → actual STT → actual LLM → actual TTS → valid audio, with the same input/models/settings and correlated telemetry. Microphone/getUserMedia, playback, and Android rendering block only cells that depend on them; headless evidence does not prove browser/native/mobile capture or playback (owner snapshot §30.32 line 1942; CURRENT.md lines 28, 20). UI is not a global barrier to independent valid performance cells.

## Readiness facts and unresolved applicability

Each executed cell must pin requester/provider host/device, physical relationship, source/dirty diff, installed app/binary/ABI/runtime, backend/model/tokenizer/input/settings, grants, caps, load/power/thermal state, and actual route (§26.2 lines 1146–1148; §27.3 lines 1243–1261). Actual provider services, stage placement, request correlation, route/ICE or API evidence, per-device resources, and clock domains are required; SSH control access is explicitly not an Aurora product data-plane route (§26.4 lines 1177–1193; CURRENT.md line 51).

Present identity limits in the owner snapshot: BR/PT/US labels do not prove country or provider region; the coding host is not automatically the requested US VPS; A-W relay discovery is not current APK/source/install acceptance; M-P physical-phone identity/capabilities are unverified (§26.2 lines 1134–1146). Current Root status likewise says actual cross-host endpoint, peer/grant/route, stage-provider, and notebook-resource evidence are incomplete (CURRENT.md line 51). Therefore, the 12 planned directions and the non-iOS surface/mode families are required registry inputs, while which specific cells are presently eligible remains an evidence-backed applicability decision—not something to infer from host labels or source code.

The snapshot’s prior dated progress tables are not current execution state. Use CURRENT.md for present counts: V485/V497/V692 padded HTTP and original CPU V491 are recorded as sealed results, with incorrect outcomes preserved; V745 continuation and padded CPU V737 remain live/incomplete at the latest update (CURRENT.md lines 3–24, 30, 50). Existing sealed results are not automatically reusable baselines across a changed WAV, backend, surface, or condition; reuse requires explicit equivalence mapping (§27.2 lines 1235–1239).
