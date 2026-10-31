#!/usr/bin/env bash
# Brings up the stack the OpenID conformance suite tests: Postgres, the API (built from
# API_DIR), a fake SES, and this service over TLS as https://op.seamless.test:5321.
# Writes everything it generates (secrets, certificate, logs) to RUN_DIR.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${HERE}/../.." && pwd)"
: "${API_DIR:?set API_DIR to a built seamless-auth-api checkout}"
RUN_DIR="${RUN_DIR:-${ROOT}/conformance/.run}"
PG_CONTAINER="${PG_CONTAINER:-seamless-conformance-pg}"
PG_PORT="${PG_PORT:-5447}"
API_PORT=5320
EDGE_PORT=5321
EDGE_HOST=op.seamless.test
ISSUER="https://${EDGE_HOST}:${EDGE_PORT}"

mkdir -p "${RUN_DIR}"
cd "${RUN_DIR}"

secret() { openssl rand -hex 32; }
if [ ! -f secrets.env ]; then
  {
    echo "OIDC_SERVICE_TOKEN=$(secret)"
    echo "REFRESH_TOKEN_LOOKUP_SECRET=$(secret)"
    echo "DECOY_SUBJECT_SECRET=$(secret)"
    echo "TOTP_SECRET_ENCRYPTION_KEY=$(secret)"
    echo "OAUTH_STATE_SECRET=$(secret)"
    echo "COOKIE_SECRET=$(secret)"
    echo "OIDC_COOKIE_KEY=$(secret)"
  } > secrets.env
fi
# shellcheck disable=SC1091
source secrets.env

if [ ! -f provider-jwks.json ]; then
  node -e "
    const { generateKeyPairSync } = require('node:crypto');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    process.stdout.write(JSON.stringify({ keys: [{ ...privateKey.export({ format: 'jwk' }), kid: 'conformance-1' }] }));
  " > provider-jwks.json
fi

if [ ! -f tls.crt ]; then
  openssl req -x509 -nodes -newkey rsa:2048 -days 30 -subj "/CN=${EDGE_HOST}" \
    -addext "subjectAltName=DNS:${EDGE_HOST}" -keyout tls.key -out tls.crt 2>/dev/null
fi
# Chromium accepts the certificate by its key hash; WebAuthn needs a secure context.
openssl x509 -in tls.crt -pubkey -noout | openssl pkey -pubin -outform der \
  | openssl dgst -sha256 -binary | base64 > spki.txt

if ! docker ps --format '{{.Names}}' | grep -qx "${PG_CONTAINER}"; then
  docker rm -f "${PG_CONTAINER}" >/dev/null 2>&1 || true
  docker run -d --name "${PG_CONTAINER}" -p "127.0.0.1:${PG_PORT}:5432" \
    -e POSTGRES_USER=seamless -e POSTGRES_PASSWORD=seamless -e POSTGRES_DB=seamless \
    postgres:18-alpine >/dev/null
fi
for _ in $(seq 1 60); do
  docker exec "${PG_CONTAINER}" pg_isready -U seamless -d seamless >/dev/null 2>&1 && break
  sleep 1
done

cat > api.env <<EOF
NODE_ENV=development
HOST=127.0.0.1
PORT=${API_PORT}
ISSUER=http://127.0.0.1:${API_PORT}
APP_ID=conformance
APP_NAME="Seamless Conformance"
APP_ORIGINS=${ISSUER}
DB_HOST=127.0.0.1
DB_PORT=${PG_PORT}
DB_NAME=seamless
DB_USER=seamless
DB_PASSWORD=seamless
LOGIN_METHODS=passkey,email_otp
DEFAULT_ROLES=user
AVAILABLE_ROLES=user,admin
ACCESS_TOKEN_TTL=30m
REFRESH_TOKEN_TTL=1d
RPID=${EDGE_HOST}
ORIGINS=${ISSUER}
FRONTEND_URL=${ISSUER}
OWNER_EMAIL=owner@seamless.test
DISABLE_AUTH_RATE_LIMITS=true
RATE_LIMIT=100000
DELAY_AFTER=100000
OIDC_PROVIDER_ENABLED=true
OIDC_ISSUER=${ISSUER}
OIDC_ALLOW_CLIENT_SECRETS=true
SEAMLESS_OIDC_SERVICE_TOKEN=${OIDC_SERVICE_TOKEN}
REFRESH_TOKEN_LOOKUP_SECRET=${REFRESH_TOKEN_LOOKUP_SECRET}
DECOY_SUBJECT_SECRET=${DECOY_SUBJECT_SECRET}
TOTP_SECRET_ENCRYPTION_KEY=${TOTP_SECRET_ENCRYPTION_KEY}
OAUTH_STATE_SECRET=${OAUTH_STATE_SECRET}
OIDC_JWKS_ACTIVE_KID=conformance-1
OIDC_JWKS_KEYS='$(cat provider-jwks.json)'
SEAMLESS_DEV_KEYS_DIR=${RUN_DIR}/api-keys
MESSAGING_ENABLE_IN_DEV=true
MESSAGING_AWS_REGION=us-east-1
MESSAGING_EMAIL_FROM=noreply@seamless.test
AWS_ENDPOINT_URL_SES=http://127.0.0.1:4590
AWS_ACCESS_KEY_ID=conformance
AWS_SECRET_ACCESS_KEY=conformance
EOF

cat > edge.env <<EOF
PORT=${EDGE_PORT}
SEAMLESS_API_URL=http://127.0.0.1:${API_PORT}
SEAMLESS_OIDC_SERVICE_TOKEN=${OIDC_SERVICE_TOKEN}
SEAMLESS_COOKIE_SECRET=${COOKIE_SECRET}
OIDC_COOKIE_KEYS=${OIDC_COOKIE_KEY}
TLS_KEY=${RUN_DIR}/tls.key
TLS_CERT=${RUN_DIR}/tls.crt
EOF

# shellcheck disable=SC1091
(cd "${API_DIR}" && set -a && source "${RUN_DIR}/api.env" && set +a && npx sequelize-cli db:migrate > "${RUN_DIR}/migrate.log" 2>&1)

wait_for() {
  local url="$1" name="$2" log="$3"
  for _ in $(seq 1 60); do
    curl -ksf -o /dev/null --resolve "${EDGE_HOST}:${EDGE_PORT}:127.0.0.1" "${url}" && return 0
    sleep 1
  done
  echo "${name} did not come up; last log lines:" >&2
  tail -n 40 "${log}" >&2
  return 1
}

launch() {
  local dir="$1" name="$2"
  shift 2
  (cd "${dir}" && exec "$@" > "${RUN_DIR}/${name}.log" 2>&1 < /dev/null) &
  echo $! > "${RUN_DIR}/${name}.pid"
}

launch "${HERE}" ses node fake-ses.mjs
launch "${API_DIR}" api node --env-file="${RUN_DIR}/api.env" dist/server.js
wait_for "http://127.0.0.1:${API_PORT}/health/status" API api.log
launch "${ROOT}" edge node --env-file="${RUN_DIR}/edge.env" conformance/stack/edge-https.mjs
wait_for "${ISSUER}/.well-known/openid-configuration" edge edge.log

echo "stack up: API http://127.0.0.1:${API_PORT}, edge ${ISSUER}"
