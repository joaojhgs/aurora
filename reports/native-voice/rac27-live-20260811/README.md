# RAC-27 live transport checkpoint

This directory preserves the redacted reports used for the 2026-08-11 RAC-27 audit.

## Accepted evidence

- Browser/Python direct WebRTC passed from source `8fff7af6`: a selected host candidate pair, HTTP fallback disabled, manifest/registry/event/TTS/RPC/stream/reconnect/revocation/mutation assertions passed, and secrets were redacted.
- Browser/Python STUN WebRTC passed from source `8fff7af6`: a selected server-reflexive candidate pair matched the configured STUN server, HTTP fallback was disabled, the same protocol assertions passed, and secrets were redacted.
- Packaged Linux desktop direct WebRTC passed after the X-display harness repairs. The source-lane commits `947f6311`, `246e8acc`, and `0caff8ca` correspond to integrated commits `9ee5cd11`, `414675a8`, and `d429cbc4`. The packaged client selected a host pair and passed the protocol, local-tool-provider, role-switch, process-tree, and redaction gates.
- The original forced-TURN run failed because the local coturn fixture rejected same-host relay peers with `403 Forbidden IP`. A bounded diagnostic rerun passed after adding `allow-loopback-peers` and a non-empty CLI password: the DataChannel opened and the pairing/RPC/reconnect/revocation scenario completed. The fixture repair is integrated as `84a6353d`.
- Current-source boundary revalidation at `63b25066` passed the desktop native-voice self-test and check-only gate, 8 desktop profile tests, 5 service-boundary tests, 39 Python sidecar-profile tests, 6 Rust sidecar tests, and Tauri typecheck. Persisted `remote-console` profiles remain remote with or without a running sidecar; persisted `mesh-node` plus `python-full` selects the loopback sidecar. No `VITE_AURORA_RUNTIME_MODE` role assignment is present.

## Remaining limitation

The successful TURN diagnostic report was cleaned before consolidation, so this directory retains the pre-fix failure report plus the reviewed fixture change and its command-level result. A fresh integrated aggregate run is still required for durable packaged direct/STUN/TURN acceptance. The current `developer` user cannot access `/var/run/docker.sock`; no rootless Docker/Podman socket or current-user Mosquitto/coturn binary is available, and the required WebSocket MQTT port `9001` and TURN port `3478` are not listening. TCP MQTT port `1883` is listening but does not satisfy the maintained aggregate fixture. The integrated packaged desktop command completed its frontend/native build and then stopped at that Docker prerequisite.

RAC-27 therefore remains `partial`; no phase or RAC count is promoted by this checkpoint.

## Files

- `browser-python-direct.json` — passed direct lane.
- `browser-python-stun.json` — passed STUN lane.
- `browser-python-turn-pre-fix.json` — failed forced-TURN lane retained for root-cause provenance.
- `packaged-desktop-direct.json` — passed packaged desktop direct lane after X-display repairs.
- `summary.json` — source, hash, disposition, and remaining-gap index.
