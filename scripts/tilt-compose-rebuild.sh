#!/usr/bin/env bash
# Rebuild process-mode images and refresh containers via a *running* Tilt session.
#
# Does NOT run `tilt down`. Redis and other services keep running; Tilt rebuilds/recreates
# only the Compose services you name (or all of them).
#
# Usage (repo root):
#   export PATH="$(git rev-parse --show-toplevel)/scripts:$PATH"
#
#   # With `tilt up` already running in another terminal:
#   ./scripts/tilt-compose-rebuild.sh                    # all services, sequential build
#   ./scripts/tilt-compose-rebuild.sh db-service         # one service
#   ./scripts/tilt-compose-rebuild.sh db-service auth-service
#
# If Tilt is not running, this still runs `docker compose build` so you can `tilt up` later.
# Triggers are skipped when the Tilt API is unreachable.
#
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="${ROOT}/scripts:${PATH}"
cd "$ROOT"
export COMPOSE_BAKE="${COMPOSE_BAKE:-false}"
eval "$(python scripts/config_to_docker_env.py --format shell)"



: "${AURORA_COMPOSE_PROJECT:=aurora-process}"
COMPOSE=(docker compose -p "${AURORA_COMPOSE_PROJECT}" -f docker-compose.process.yml -f docker-compose.tilt.yml)

ALL_SERVICES=(
  config-service
  db-service
  auth-service
  orchestrator-service
  gateway-service
  tts-service
  stt-transcription-service
  stt-wakeword-service
  scheduler-service
  tooling-service
  stt-coordinator-service
)

if [[ $# -eq 0 ]]; then
  SERVICES=("${ALL_SERVICES[@]}")
else
  SERVICES=("$@")
fi

_tilt_available() {
  tilt get uiresource >/dev/null 2>&1
}

for s in "${SERVICES[@]}"; do
  echo "========== docker compose build: $s =========="
  "${COMPOSE[@]}" build "$s"
done

if _tilt_available; then
  echo ""
  echo "Tilt detected — triggering resource updates (recreate containers from new images)..."
  for s in "${SERVICES[@]}"; do
    echo "  tilt trigger $s"
    tilt trigger "$s"
  done
  echo "Done. Watch the Tilt UI for progress."
else
  echo ""
  echo "Tilt API not reachable (is \`tilt up\` running?). Images are built; start or restart Tilt to use them,"
  echo "or run: ${COMPOSE[*]} up -d --no-deps <service>"
fi
