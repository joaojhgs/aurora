#!/usr/bin/env bash
# Native WebRTC transport interop lanes.
#
# Verifies that the webrtc-rs stack behind `native_webrtc.rs` can actually carry
# an Aurora data channel against the peers it has to meet:
#
#   aiortc            the Python mesh node  (required)
#   chromium-direct   a browser peer, host candidates
#   chromium-mdns     a browser peer, default mDNS-obfuscated candidates
#
# CI runs all three as gating with AURORA_NATIVE_INTEROP_REQUIRE_BROWSER=1. The
# browser lanes used to be informational because webrtc-dtls 0.10 aborted the
# handshake with ErrInvalidNamedCurve against current Chromium; that fix now
# ships vendored, so a browser-lane failure here is a real regression rather
# than the known bug. Leaving the variable unset keeps them informational, which
# is only useful when bisecting the transport itself. See
# tests/e2e/webrtc_native_interop/README.md.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
lane_dir="$repo_root/tests/e2e/webrtc_native_interop"
peer_dir="$lane_dir/peer"
require_browser="${AURORA_NATIVE_INTEROP_REQUIRE_BROWSER:-0}"
python_bin="${AURORA_NATIVE_INTEROP_PYTHON:-$repo_root/.venv/bin/python3}"
browser="${AURORA_INTEROP_BROWSER:-chromium}"

echo "==> building native interop peer"
cargo build --manifest-path "$peer_dir/Cargo.toml" --bin aurora-webrtc-interop-peer
peer_bin="$peer_dir/target/debug/aurora-webrtc-interop-peer"

failures=0

echo "==> lane: aiortc (required)"
if "$python_bin" "$lane_dir/aiortc_peer.py" "$peer_bin"; then
  echo "    aiortc lane passed"
else
  echo "    aiortc lane FAILED" >&2
  failures=$((failures + 1))
fi

for mdns in off on; do
  echo "==> lane: $browser (mdns=$mdns)"
  set +e
  AURORA_INTEROP_MDNS="$mdns" node "$lane_dir/browser_peer.mjs" "$peer_bin"
  lane_status=$?
  set -e
  if [[ $lane_status -eq 0 ]]; then
    echo "    $browser lane (mdns=$mdns) passed"
  elif [[ "$require_browser" == "1" ]]; then
    echo "    $browser lane (mdns=$mdns) FAILED" >&2
    failures=$((failures + 1))
  else
    echo "    $browser lane (mdns=$mdns) failed — informational, see README" >&2
  fi
done

if [[ $failures -gt 0 ]]; then
  echo "native interop: $failures required lane(s) failed" >&2
  exit 1
fi
echo "native interop: all required lanes passed"
