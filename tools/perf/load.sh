#!/usr/bin/env bash
# Load test of the Dispatch board under the documented conditions
# (docs/performance.md): production build, metrics on, presence sampled every
# 2 s, a fresh snapshot store, the server stopped afterwards.
#
# usage: tools/perf/load.sh [sessions=200] [rate=1] [duration=15] [mode=production]
#   PRESENCE=<seconds> overrides the presence sample interval.
#   PORT=<port> overrides the port (default 3000).
#   WORKERS=<n> runs src/cluster.ts: a router plus n worker processes on the
#   ports after PORT. DIRECT=1 makes the load test bypass the router.
#   ENCODING=br|gzip|identity: what the pages accept (load-test.mjs --encoding).
#   EVENTS=<n> makes every page also click its own selection n times a second
#   (answer latency is reported; see load-test.mjs --events).
#   NODE_FLAGS="<flags>" adds flags to the server's node command (V8 flags such
#   as --max-semi-space-size are not allowed in NODE_OPTIONS).
set -u
sessions=${1:-200}
rate=${2:-1}
duration=${3:-15}
mode=${4:-production}
port=${PORT:-3000}
workers=${WORKERS:-}
root="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$root/output"
cd "$root/examples/dispatch" || exit 1

entry=src/main.ts
[ -n "$workers" ] && entry=src/cluster.ts

rm -rf .hyper-sessions
PORT=$port WORKERS=$workers DISPATCH_PRESENCE_SAMPLE_SECONDS=${PRESENCE:-2} NODE_ENV=$mode HYPER_METRICS=1 \
  node --expose-gc ${NODE_FLAGS:-} --import tsx "$entry" > "$root/output/load-server.log" 2>&1 &
server=$!

stop() {
  kill "$server" 2>/dev/null
  # Workers listen on the ports after the router's; stop them by port too.
  if command -v powershell >/dev/null 2>&1; then
    ports=$(seq -s, "$port" "$((port + ${workers:-0}))")
    powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort $ports -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique | ForEach-Object { Stop-Process -Id \$_ -Force -Confirm:\$false }" >/dev/null 2>&1
  fi
}
trap stop EXIT

for _ in $(seq 1 120); do
  [ "$(curl -s -m 2 -o /dev/null -w '%{http_code}' "http://localhost:$port/greeter")" = 200 ] && break
  sleep 0.5
done
# With workers, wait until every one of them reports metrics.
if [ -n "$workers" ]; then
  for _ in $(seq 1 120); do
    curl -s -m 2 "http://localhost:$port/_hyper/metrics" | grep -q "\"processes\":$((workers + 1))" && break
    sleep 0.5
  done
fi

node scripts/load-test.mjs --sessions "$sessions" --rate "$rate" --duration "$duration" --url "http://localhost:$port"   ${DIRECT:+--direct 1} ${EVENTS:+--events $EVENTS} ${ENCODING:+--encoding $ENCODING} ${RAW:+--raw 1} 2>&1 |
  grep -E "connect:|memory:|latency|server:|generator|patches:|page events:|RESULT"
