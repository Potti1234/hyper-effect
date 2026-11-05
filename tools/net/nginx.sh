#!/usr/bin/env bash
# Starts nginx (Docker) in front of the app on host port 3000:
# http://localhost:8080 (HTTP/1.1) and https://localhost:8443 (HTTP/2, a
# self-signed certificate). Stop it with: docker rm -f hyper-nginx
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
certs="$here/../../output/nginx-certs"
mkdir -p "$certs"
if [ ! -f "$certs/cert.pem" ]; then
  MSYS_NO_PATHCONV=1 docker run --rm -v "$(cygpath -w "$certs" 2>/dev/null || echo "$certs"):/out" node:26-bookworm \
    openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj /CN=localhost \
    -keyout /out/key.pem -out /out/cert.pem >/dev/null 2>&1
fi
docker rm -f hyper-nginx >/dev/null 2>&1 || true
MSYS_NO_PATHCONV=1 docker run -d --name hyper-nginx -p 8080:8080 -p 8443:8443 \
  --add-host host.docker.internal:host-gateway \
  -v "$(cygpath -w "$here/nginx.conf" 2>/dev/null || echo "$here/nginx.conf"):/etc/nginx/nginx.conf:ro" \
  -v "$(cygpath -w "$certs" 2>/dev/null || echo "$certs"):/etc/nginx/certs:ro" \
  nginx:alpine >/dev/null
sleep 1
docker logs hyper-nginx 2>&1 | tail -3
