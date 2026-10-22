# Next product gate after V306

Read-only map prepared 2026-10-14 while Root owns the V306 serial main run. No checks were executed for this report.

## Gate

The next product gate is PER-286’s accepted functional handoff and its PRE-NATIVE-01–03 prerequisites. G008/PER-285 is still pending and explicitly forbids starting TEL-1–TEL-8 until PER-286 is accepted and integrated, its `native-speech-routing-acceptance.v1` record is validated, required platform gates pass, and OCR plus architecture/security review are complete. This makes PER-286 acceptance the single important blocker before telemetry implementation; V306 matched-latency work is not product telemetry or PER-286 acceptance.

Current plan evidence: `.omx/ultragoal/goals.json` SHA-256 `7c5333454d3175758d9daa8b898ff865a6059f1cfc4cec4481160315526b60f1`; G008 (`PER-285: Implement Aurora end-to-end telemetry across voice, text, tools, native and mesh`) is `pending`. PER-285 intake SHA-256 `86eddf54cb1fb7dfd93714cdf41a20704784b738b2328c97ff40c6588b5466e8`; its start gate is at lines 7 and 81. PER-286 intake SHA-256 `3018139f3e5d5b5ee83537d8c61cacff397b4896fbcc6c2c132694ea87708f95`.

The current acceptance record `.omx/evidence/receiving-session-20261006/native-speech-routing-acceptance.v1.json` has SHA-256 `c404d5ab4c1eea092f087df3b1f1d53402c09d81b3e81d5e98bb98734d3a4b84`, status `pending`, integrated commit `37a727a7644f6aaf8eceff9ef2f2ce94ece2691e`, and all ten required gates still `pending` with no command/exit code recorded. Its specific remaining live gaps are packaged Android execution, Apple-host iOS runtime acceptance, actual live native/browser model-host inference and optional experimental active-session KWS/VAD, plus full-task OCR and architecture/platform acceptance. The LIVE-001 note also says earlier browser cases are retained rather than fresh at the final integrated revision.

## Existing implementation boundary

There are already limited observability helpers: `app/shared/mesh/tracing.py` provides correlation IDs and audit-safe redaction (`0a0f8f492ebc5f96b64fb479c2f6ca127f3b8683570f09de0017bd6394b970fe`), while `app/shared/mesh/observability.py` defines payload-free mesh rollout/support diagnostics (`4d46ae71cb3d687f05c50a72ef06f5816c6b3bf09a52af1c3e43444e06e1ba51`). These are not the end-to-end voice/text/tool/native/mesh telemetry required by PER-285, and do not clear its start gate.

For the important native functional main, the existing packaged-app launchers are `android:voice:live` and `ios:voice:main:live` in `apps/aurora-tauri/package.json` (SHA-256 `27a424f7936c1951aa32ceb4d2c2daf17af5d7adbb10297b0cf7937c97cc646e`). The Android launcher is `pnpm --dir apps/aurora-tauri run android:voice:live`; the separate Apple runtime launcher is `pnpm --dir apps/aurora-tauri run ios:voice:main:live`. These are existing main-flow entry points, not telemetry tests and not evidence of a pass here. The record leaves both platform acceptance gates pending, so neither platform can be inferred from source or the V306 pilot.

The next concrete acceptance step is to close PER-286’s integrated functional evidence—especially the still-unvalidated real native host inference/KWS/VAD boundary and required Android/iOS main gates—then complete the specified independent reviews and PRE-NATIVE-01–03. Only after that should PER-285’s telemetry work begin. This report does not claim current V306 outcome or any unrun validation.
