#!/usr/bin/env bash
# Run Docker Compose v2 via the official docker:24-cli image when the host has no
# `docker compose` / docker-compose CLI (but Docker Engine is available).
#
# Usage (from repo root):
#   ./scripts/compose-docker.sh -f docker-compose.process.yml config
#   ./scripts/compose-docker.sh -f docker-compose.process.yml -f docker-compose.tilt.yml config
#
# Requires: Docker can bind-mount the repo directory (works on typical Linux/macOS;
# fix Docker Desktop file sharing if you see "no such file" inside the container).

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec docker run --rm -i \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "${ROOT}:${ROOT}" \
  -w "${ROOT}" \
  docker:24-cli \
  docker compose "$@"
