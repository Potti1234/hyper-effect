#!/usr/bin/env bash
# A throwaway Postgres for development, tests and the multi-node checks:
# postgres:17-alpine in Docker on localhost:55432 (HYPER_PG_PORT to change),
# database "hyper". Prints the connection URL.
# Stop it with: docker rm -f hyper-postgres
set -eu
name=hyper-postgres
port=${HYPER_PG_PORT:-55432}
url=postgres://hyper:hyper-dev@localhost:$port/hyper
if [ -z "$(docker ps -q -f name=^${name}$)" ]; then
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" -p "$port:5432" \
    -e POSTGRES_USER=hyper -e POSTGRES_PASSWORD=hyper-dev -e POSTGRES_DB=hyper \
    postgres:17-alpine >/dev/null
fi
for _ in $(seq 1 60); do
  docker exec "$name" pg_isready -U hyper -d hyper >/dev/null 2>&1 && break
  sleep 0.5
done
echo "$url"
