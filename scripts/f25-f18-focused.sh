#!/usr/bin/env bash
set -Eeuo pipefail
cd "$1"
mkdir -p test-results/f25-f18
container="anticlone-f25-f18-$(date +%s)-$$"
finish(){ code=$?;trap - EXIT;docker rm -f "$container" >/dev/null 2>&1 || true;printf 'exit=%s\n' "$code" > test-results/f25-f18/result.txt;exit "$code"; }
trap finish EXIT
docker run -d --name "$container" --publish 127.0.0.1::5432 --tmpfs /var/lib/postgresql/data -e POSTGRES_USER=anticlone -e POSTGRES_PASSWORD=test-only -e POSTGRES_DB=anticlone_test postgres:16 >/dev/null
for i in {1..60};do if docker exec "$container" pg_isready -U anticlone -d anticlone_test >/dev/null;then break;fi;sleep 1;done
port=$(docker port "$container" 5432/tcp);[[ $port =~ ^127\.0\.0\.1:([0-9]+)$ ]]
unset DATABASE_URL PGOPTIONS
export TEST_DATABASE_URL="postgres://anticlone:test-only@127.0.0.1:${BASH_REMATCH[1]}/anticlone_test" HTTPS_GATE_TEST=1
npm ci > test-results/f25-f18/npm.log 2>&1
npm run build > test-results/f25-f18/build.log 2>&1
node --test --test-concurrency=1 dist/tests/cta-commercial.test.js dist/tests/cta-selection-ui.test.js dist/tests/f18-gate-browser.test.js dist/tests/f18-timing.test.js dist/tests/scoped-gateway.test.js 2>&1 | tee test-results/f25-f18/focused.log
