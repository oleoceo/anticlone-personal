#!/usr/bin/env bash
# Focused diagnostics only. Never substitute this result for complete CI.
set -Eeuo pipefail
cd "$1"
mkdir -p test-results/front3
container="anticlone-front3-focused-$(date +%s)-$$"
finish(){ code=$?;trap - EXIT;docker rm -f "$container" >/dev/null 2>&1 || true;printf 'focused_exit=%s\n' "$code" > test-results/front3/focused-result.txt;exit "$code"; }
trap finish EXIT
docker run -d --name "$container" --publish 127.0.0.1::5432 --tmpfs /var/lib/postgresql/data -e POSTGRES_USER=anticlone -e POSTGRES_PASSWORD=test-only -e POSTGRES_DB=anticlone_test postgres:16 >/dev/null
for i in {1..60};do if docker exec "$container" pg_isready -U anticlone -d anticlone_test >/dev/null;then break;fi;sleep 1;done
port=$(docker port "$container" 5432/tcp);[[ $port =~ ^127\.0\.0\.1:([0-9]+)$ ]]
unset DATABASE_URL PGOPTIONS
export TEST_DATABASE_URL="postgres://anticlone:test-only@127.0.0.1:${BASH_REMATCH[1]}/anticlone_test" HTTPS_GATE_TEST=1
npm ci > test-results/front3/focused-npm.log 2>&1
npm run build > test-results/front3/focused-build.log 2>&1
node --test --test-concurrency=1 dist/tests/front3-*.test.js dist/tests/multiple-cta-surfaces.test.js 2>&1 | tee test-results/front3/focused.log
