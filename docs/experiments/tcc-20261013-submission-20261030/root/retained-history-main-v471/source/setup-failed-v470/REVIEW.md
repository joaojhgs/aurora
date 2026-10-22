# V470 bounded independent retained-history main source review

2026-10-15 UTC. **APPROVE exact final five-file private harness for the one retained-history UI flow.** Source/retained-file hash inspection only; no imports/tests/browser/application/models/build/network/device/Orca operations, canonical/index/goals/vault writes or new agents. This report is the sole owned write.

Final source manifest SHA256 `1e45a7fe902348854c008180b2ebbd1baa9a956f08d854944640049301128897`; all five file bytes/hashes independently match:

- driver.py `b5326644fc505e74d710e3aac040b5a757a09daa716da474db858fb87d0685cf`.
- driver-controller.py `dee8859dad11add554648da8f2946e33536942fda5435a5931ba9188002cc132`.
- supervisor.py `44553ae23d5932abb3ac9ec2da24455b3b6cccab402f71cff7965d85b3be52ef`.
- backend-controller.py `45f40bc968bf3828b8535028f68ad5a83bfa924dc8e2852087b198181b770a04`.
- source_guard_v455.py `385338a94bff6ba2677348fd65714e52a21fd29157a7ba1a0d89afddbfc00d47`.

## Actual history path and predicates

The driver performs ordinary gateway setup, password Login, visible Assistant SPA navigation and one saved-row selection. It never clicks New conversation, Send, Read aloud or PTT and invokes no SDK/service/model itself. The controller fixes target session `6201eb4f-593b-4de9-a799-96de6f9c0ed0`. The driver requires that exact ID in authenticated history, unique fixed-prompt row/index selection, exact rendered instruction and ORBIT, successful GetSession containing the corresponding user/assistant contents and successful selected-session activation. It fails if observed Assistant/transcription/TTS write routes are dispatched; this is observation/failure, not a new product route blocker.

Current maintained `use-assistant-history.ts:429–445` loads GetSession with activate=false and explicitly awaits SetActiveSession before rendering the reopened session. Its `activatePersistedSession:273–280` confirms that call. Thus this driver's GetSession plus SetActiveSession requirements match the concrete current branch of the allowed GetSession-activation-or-separate-activation contract; no new activation policy is imposed. Actual role/content fields match the existing DB response. The result is history-only, not a newly generated reply or a seeded test substitute for V461.

## Runtime custody, caps and privacy

The parent retains the existing single global lock and 300-second cap, SIGTERM/finally scoped reverse-order cleanup, passed compatible production build and exact c90 factory/observer PID admission. The backend uses a separate copied DB data path and original V461 config/auth with only loopback port/CORS changes. No original DB, accounts or frozen source are intentionally written. Byte-identical original DB copy/no-WAL/source-continuity evidence is Root-owned preparation; these scripts consume that copy and do not themselves manufacture or independently prove its historical hash. Original fixture credentials are privately reused for normal login, not persisted into browser storage by the driver.

Driver and controller retain one90-second envelope, exclusive fresh case, frozen-driver hash, and parent-owned runtime. Failure primary/screenshot is captured inside Playwright lifetime before teardown. Network capture inspects only DB session bodies transiently and retains hashes/counts/match flags plus allowlisted headers; auth bodies/passwords are not written. Output and fixture files remain private. Latest supervisor/backend changes correct metadata to retained history and compatible build reuse, explicitly not deployment of V469 TTS. No credential/raw-message publication is authorized.

No material main-path blocker found. Actual UI reopening, zero unexpected model/speech requests, process retirement and source/DB continuity remain Root's one executable validation gate. This does not establish voice capture, a ninth voice flow, new inference/TTS playback, measured samples, full GPU/voice/platform acceptance or phase-2 release. No extra test/matrix or commit authority requested. Stop.
