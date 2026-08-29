#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-aurora-hosted-thin-e2e}"
exec "$ROOT/scripts/hosted_peer_e2e.sh" "$@"
