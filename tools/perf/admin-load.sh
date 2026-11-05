#!/usr/bin/env bash
# Load test of the catalog admin (phase B6): production build, metrics on,
# fresh session snapshots; the server stopped afterwards.
#
# usage: tools/perf/admin-load.sh [sessions=200] [rate=1] [duration=15]
#   VARIED=1   every list has its own query (load-test.mjs --varied)
#   PG=1       products, images and snapshots in Postgres (tools/postgres),
#              tables dropped first
#   PORT=<port> (default 3200)
set -u
sessions=${1:-200}
rate=${2:-1}
duration=${3:-15}
port=${PORT:-3200}
root="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$root/output"
cd "$root/examples/admin" || exit 1

database=""
if [ "${PG:-}" = 1 ]; then
  database=$(bash "$root/tools/postgres/start.sh")
  docker exec hyper-postgres psql -q -U hyper -d hyper -c \
    "DROP TABLE IF EXISTS products, images, hyper_snapshots; DROP SEQUENCE IF EXISTS product_ids;" >/dev/null
fi
rm -rf .hyper-sessions
env PORT=$port NODE_ENV=production HYPER_METRICS=1 ${database:+DATABASE_URL=$database} \
  node --expose-gc --import tsx src/main.ts > "$root/output/admin-load-server.log" 2>&1 &
server=$!
stop() {
  kill "$server" 2>/dev/null
  if command -v powershell >/dev/null 2>&1; then
    powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique | ForEach-Object { Stop-Process -Id \$_ -Force -Confirm:\$false }" >/dev/null 2>&1
  fi
}
trap stop EXIT
for _ in $(seq 1 120); do
  [ "$(curl -s -m 2 -o /dev/null -w '%{http_code}' "http://localhost:$port/login")" = 200 ] && break
  sleep 0.5
done
node scripts/load-test.mjs --sessions "$sessions" --rate "$rate" --duration "$duration" --url "http://localhost:$port" \
  ${VARIED:+--varied 1} 2>&1 | grep -E "latency|server:|RESULT"
