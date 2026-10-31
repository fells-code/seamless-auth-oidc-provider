#!/usr/bin/env bash
# Stops what start.sh started. The Postgres container goes too unless KEEP_DB=1.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
RUN_DIR="${RUN_DIR:-${HERE}/../.run}"
for name in edge api ses; do
  [ -f "${RUN_DIR}/${name}.pid" ] && kill "$(cat "${RUN_DIR}/${name}.pid")" 2>/dev/null
  rm -f "${RUN_DIR}/${name}.pid"
done
[ "${KEEP_DB:-0}" = 1 ] || docker rm -f "${PG_CONTAINER:-seamless-conformance-pg}" >/dev/null 2>&1
