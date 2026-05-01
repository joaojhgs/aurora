#!/usr/bin/env bash
# Set per-service log level in repo-root .env and recreate that container via Compose.
# Usage: ./scripts/tilt-set-service-log-level.sh <compose-service-name> [DEBUG|INFO|...]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SERVICE="${1:?service name required}"
LEVEL="${2:?log level required (e.g. DEBUG, INFO)}"
ENV_FILE="${ROOT}/.env"

case "$SERVICE" in
  config-service) VAR=CONFIG_SERVICE_LOG_LEVEL ;;
  db-service) VAR=DB_SERVICE_LOG_LEVEL ;;
  auth-service) VAR=AUTH_SERVICE_LOG_LEVEL ;;
  orchestrator-service) VAR=ORCHESTRATOR_SERVICE_LOG_LEVEL ;;
  gateway-service) VAR=GATEWAY_SERVICE_LOG_LEVEL ;;
  tts-service) VAR=TTS_SERVICE_LOG_LEVEL ;;
  stt-transcription-service) VAR=STT_TRANSCRIPTION_SERVICE_LOG_LEVEL ;;
  stt-wakeword-service) VAR=STT_WAKEWORD_SERVICE_LOG_LEVEL ;;
  scheduler-service) VAR=SCHEDULER_SERVICE_LOG_LEVEL ;;
  tooling-service) VAR=TOOLING_SERVICE_LOG_LEVEL ;;
  stt-coordinator-service) VAR=STT_COORDINATOR_SERVICE_LOG_LEVEL ;;
  *)
    echo "Unknown service: $SERVICE" >&2
    exit 1
    ;;
esac

touch "$ENV_FILE"
if grep -q "^${VAR}=" "$ENV_FILE" 2>/dev/null; then
  if [[ "$(uname -s)" == "Darwin" ]]; then
    sed -i '' "s/^${VAR}=.*/${VAR}=${LEVEL}/" "$ENV_FILE"
  else
    sed -i "s/^${VAR}=.*/${VAR}=${LEVEL}/" "$ENV_FILE"
  fi
else
  echo "${VAR}=${LEVEL}" >> "$ENV_FILE"
fi

echo "Updated ${VAR}=${LEVEL} in .env"

export COMPOSE_FILE="docker-compose.process.yml:docker-compose.tilt.yml"
docker compose -p aurora-process up -d --no-deps --force-recreate "$SERVICE"
echo "Recreated container: $SERVICE"
