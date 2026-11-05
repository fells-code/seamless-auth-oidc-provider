#!/usr/bin/env bash
# Brings the local stack up from nothing and seeds it. Safe to rerun.
set -euo pipefail

cd "$(dirname "$0")"

[ -f settings.env ] || cp settings.env.example settings.env
# shellcheck disable=SC1091
source settings.env
compose() { docker compose --env-file settings.env "$@"; }

for port in "${TLS_PORT}" "${API_PORT}" "${MAILBOX_PORT}"; do
  owner="$(docker ps --filter "publish=${port}" --format '{{.Label "com.docker.compose.project"}}')"
  if [ "${owner}" = "${COMPOSE_PROJECT_NAME}" ]; then
    continue
  fi
  if (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; then
    echo "Port ${port} is in use. Pick another in local/settings.env (TLS_PORT, API_PORT, MAILBOX_PORT)." >&2
    exit 1
  fi
done

mkdir -p .generated
# Runs as you, so the files stay yours on Linux too.
HOST_UID="$(id -u)"
HOST_GID="$(id -g)"
export HOST_UID HOST_GID
docker run --rm --user "${HOST_UID}:${HOST_GID}" \
  -v "${PWD}/stack:/stack:ro" -v "${PWD}/.generated:/generated" \
  "${NODE_IMAGE}" node /stack/generate-secrets.mjs /generated

compose up -d --build --wait --remove-orphans edge proxy

compose cp proxy:/data/caddy/pki/authorities/local/root.crt .generated/ca.crt >/dev/null 2>&1

cat <<DONE

Up. The issuer is https://auth.${APP_NAME}.localhost:${TLS_PORT}
  CA to trust   local/.generated/ca.crt
  Mailbox       http://127.0.0.1:${MAILBOX_PORT}
  Client ids    local/.generated/recipe.json

Next: node local/sign-in.mjs
DONE
