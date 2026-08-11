# RAC-27 live transport checkpoint

This directory preserves the redacted reports used for the 2026-08-11 RAC-27 audit.

## Accepted evidence

- Browser/Python direct WebRTC passed from source `8fff7af6`: a selected host candidate pair, HTTP fallback disabled, manifest/registry/event/TTS/RPC/stream/reconnect/revocation/mutation assertions passed, and secrets were redacted.
- Browser/Python STUN WebRTC passed from source `8fff7af6`: a selected server-reflexive candidate pair matched the configured STUN server, HTTP fallback was disabled, the same protocol assertions passed, and secrets were redacted.
- Packaged Linux desktop direct WebRTC passed after the X-display harness repairs. The source-lane commits `947f6311`, `246e8acc`, and `0caff8ca` correspond to integrated commits `9ee5cd11`, `414675a8`, and `d429cbc4`. The packaged client selected a host pair and passed the protocol, local-tool-provider, role-switch, process-tree, and redaction gates.
- The original forced-TURN run failed because the local coturn fixture rejected same-host relay peers with `403 Forbidden IP`. A bounded diagnostic rerun passed after adding `allow-loopback-peers` and a non-empty CLI password: the DataChannel opened and the pairing/RPC/reconnect/revocation scenario completed. The fixture repair is integrated as `84a6353d`.
- Current-source boundary revalidation at `63b25066` passed the desktop native-voice self-test and check-only gate, 8 desktop profile tests, 5 service-boundary tests, 39 Python sidecar-profile tests, 6 Rust sidecar tests, and Tauri typecheck. Persisted `remote-console` profiles remain remote with or without a running sidecar; persisted `mesh-node` plus `python-full` selects the loopback sidecar. No `VITE_AURORA_RUNTIME_MODE` role assignment is present.

## Exact-HEAD packaged STUN revalidation

- A clean debug binary was rebuilt from `33a023756b2862392a981fc74ac0566f13a72d78` with SHA-256 `ee24c44e4332d0cb30516ce9e84c3c8b80d25aa8135cd208312e4596fe2c5c7a`.
- Two sequential packaged STUN runs selected an accepted server-reflexive route and repeatedly passed the public reverse-RPC canary, HTTP-disabled proof, redaction, event/TTS/stream/reconnect checks, and the 512 KiB fragmented RPC with 33 sent and 33 received fragments.
- Both aggregate reports remained failed on the same final assertion. Revocation succeeded, the route was not authorized, and Python reported zero authenticated and connected peers, but the desktop harness sampled the reconnect in `discovering-peer` after its fixed 2.5-second wait, before a new pairing prompt appeared. The scanner requires that prompt in addition to fail-closed authorization state.
- `packaged-desktop-stun-head-control-summary.json` retains the exact source/binary identity, temporary report hashes, repeated subclaims, and failure classification without copying raw logs or secrets.

## Remaining limitation

The successful TURN diagnostic report was cleaned before the original consolidation, so this directory still retains the pre-fix failure report plus the reviewed fixture change and its command-level result. A later userland Mosquitto/coturn fixture removed the old Docker-socket blocker, but an exact-HEAD packaged direct/STUN/TURN aggregate is still not retained. The current STUN blocker is the bounded post-revocation observation window described above, not the reverse-RPC or large-fragment transport path.

RAC-27 therefore remains `partial`; no phase or RAC count is promoted by this checkpoint.

## Files

- `browser-python-direct.json` — passed direct lane.
- `browser-python-stun.json` — passed STUN lane.
- `browser-python-turn-pre-fix.json` — failed forced-TURN lane retained for root-cause provenance.
- `packaged-desktop-direct.json` — passed packaged desktop direct lane after X-display repairs.
- `packaged-desktop-stun-head-control-summary.json` — two exact-HEAD STUN controls, repeated passing transport subclaims, and the repeated revocation-observation failure.
- `summary.json` — source, hash, disposition, and remaining-gap index.
