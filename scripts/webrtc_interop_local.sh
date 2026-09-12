#!/usr/bin/env bash
set -euo pipefail

LANE="${1:-direct}"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-aurora-webrtc-interop-local}"

cleanup() {
  scripts/webrtc_interop_services.sh down
}

trap cleanup EXIT INT TERM
scripts/webrtc_interop_services.sh up
scripts/webrtc_interop.sh "$LANE"
