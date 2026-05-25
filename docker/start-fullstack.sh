#!/usr/bin/env bash
set -euo pipefail

api_pid=""
worker_pid=""

shutdown() {
  if [ -n "$api_pid" ]; then
    kill -TERM "$api_pid" 2>/dev/null || true
  fi
  if [ -n "$worker_pid" ]; then
    kill -TERM "$worker_pid" 2>/dev/null || true
  fi
  wait 2>/dev/null || true
}

trap shutdown TERM INT

if [ "${RUN_DB_MIGRATIONS:-true}" = "true" ]; then
  npx prisma migrate deploy
fi

node services/api/dist/server.js &
api_pid="$!"

node services/worker/dist/worker.js &
worker_pid="$!"

set +e
wait -n "$api_pid" "$worker_pid"
status="$?"
set -e
shutdown
exit "$status"
