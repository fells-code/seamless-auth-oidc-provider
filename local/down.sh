#!/usr/bin/env bash
# Stops this stack. --wipe also removes its volumes and generated secrets, to start from nothing.
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -f settings.env ]; then
  echo 'Nothing to stop: local/settings.env does not exist.'
  exit 0
fi

# Compose reads the env files even to stop services, so they must exist.
mkdir -p .generated
touch .generated/api.env .generated/edge.env .generated/postgres.env

if [ "${1:-}" = '--wipe' ]; then
  docker compose --env-file settings.env down -v --remove-orphans
  rm -rf .generated
else
  docker compose --env-file settings.env down --remove-orphans
fi
