#!/usr/bin/env bash
set -euo pipefail

LANE="${1:-direct}"

cleanup() {
  scripts/webrtc_interop_services.sh down
}

trap cleanup EXIT INT TERM
scripts/webrtc_interop_services.sh up
scripts/webrtc_interop.sh "$LANE"
