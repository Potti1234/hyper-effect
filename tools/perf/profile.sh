#!/usr/bin/env bash
# CPU profile of the Dispatch server during a load test: starts the server
# (production, metrics on), runs the load test for 25 s, captures 6 s of
# profile in the middle, and prints the summary by file and function.
#
# usage: tools/perf/profile.sh [sessions=200] [rate=1]
#   writes output/server.cpuprofile (open it in Chrome DevTools > Performance)
#   EVENTS=<n>: every page also clicks n times a second (load-test.mjs --events).
set -u
sessions=${1:-200}
rate=${2:-1}
port=${PORT:-3000}
root="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$root/output"
cd "$root/examples/dispatch" || exit 1

rm -rf .hyper-sessions
. "$root/tools/secrets.sh"
PORT=$port DISPATCH_PRESENCE_SAMPLE_SECONDS=${PRESENCE:-2} NODE_ENV=production HYPER_METRICS=1 \
  node --import tsx src/main.ts > "$root/output/load-server.log" 2>&1 &
server=$!
trap 'kill $server 2>/dev/null' EXIT
for _ in $(seq 1 60); do curl -s -m 2 -o /dev/null "http://localhost:$port/greeter" && break; sleep 0.5; done

node scripts/load-test.mjs --sessions "$sessions" --rate "$rate" --duration 25 --url "http://localhost:$port" ${EVENTS:+--events $EVENTS} \
  > "$root/output/load-profiled.log" 2>&1 &
load=$!
# Connecting and settling take a few seconds; profile the steady state.
sleep 14
curl -s -X POST "http://localhost:$port/_hyper/metrics/profile?seconds=6" -o "$root/output/server.cpuprofile"
wait $load
grep -E "latency|server:|patches:|page events:" "$root/output/load-profiled.log"
echo
node "$root/tools/perf/profile-summary.mjs" "$root/output/server.cpuprofile"
