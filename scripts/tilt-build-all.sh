#!/usr/bin/env bash
# Build every process-mode Compose service image sequentially (reduces OOM risk vs parallel Tilt builds).
# Usage (from repo root):
#   export PATH="$(git rev-parse --show-toplevel)/scripts:$PATH"
#   ./scripts/tilt-build-all.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="${ROOT}/scripts:${PATH}"
cd "$ROOT"
export COMPOSE_BAKE="${COMPOSE_BAKE:-false}"
eval "$(python scripts/config_to_docker_env.py --format shell)"
COMPOSE=(docker compose -f docker-compose.process.yml -f docker-compose.tilt.yml --project-name aurora-process)
SERVICES=(
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
for s in "${SERVICES[@]}"; do
  echo "========== build: $s =========="
  "${COMPOSE[@]}" build "$s"
done
echo "All images built. Run: tilt up"
