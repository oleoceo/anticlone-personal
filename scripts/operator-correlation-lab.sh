#!/usr/bin/env bash
# Reproducible local F13/F14 comparison using the existing isolated lab container.
# Exports tracked working files; never migrates a shared/production database.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
target=$(mktemp -d /tmp/anticlone-operator-source-XXXXXX)
evidence="$PWD/test-results/operator-correlation/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$evidence" "$target/baseline"
git ls-files -z | xargs -0 sha256sum > "$evidence/source.sha256"
finish(){ code=$?;trap - EXIT;cp -a "$target/test-results/." "$evidence/" 2>/dev/null || true;printf 'source=%s\nexit=%s\n' "$target" "$code" > "$evidence/result.txt";printf 'Evidence: %s\n' "$evidence";exit "$code"; }
trap finish EXIT
git ls-files -z | tar --null -T - -cf - | tar -xf - -C "$target"
git archive 8834bf3c9f34cc699404705495bdb09daf53a110 | tar -xf - -C "$target/baseline"
cat > "$target/run-comparison.sh" <<'RUN'
set -Eeuo pipefail
cd "$1"
export PATH=/opt/node22/bin:$PATH
container="anticlone-operator-comparison-$$"
trap 'docker rm -f "$container" >/dev/null' EXIT
docker run -d --name "$container" --publish 127.0.0.1::5432 --tmpfs /var/lib/postgresql/data -e POSTGRES_USER=anticlone -e POSTGRES_PASSWORD=test-only -e POSTGRES_DB=anticlone_test postgres:16 >/dev/null
for i in {1..60};do if docker exec "$container" pg_isready -U anticlone -d anticlone_test >/dev/null;then break;fi;sleep 1;done
port=$(docker port "$container" 5432/tcp);[[ $port =~ ^127\.0\.0\.1:([0-9]+)$ ]]
unset DATABASE_URL PGOPTIONS
export TEST_DATABASE_URL="postgres://anticlone:test-only@127.0.0.1:${BASH_REMATCH[1]}/anticlone_test"
npm ci >/dev/null
npm run build
ln -s ../node_modules baseline/node_modules
(cd baseline && npm run build)
export ACTIVITY_BASELINE_MODULE="$PWD/baseline/dist/apps/scoped-gateway.js"
node --test --test-concurrency=1 dist/tests/authorized-activity.test.js dist/tests/operator-shadow.test.js
RUN
docker start anticlone-investigation-lab >/dev/null
docker exec anticlone-investigation-lab bash "$target/run-comparison.sh" "$target" 2>&1 | tee "$evidence/focused.log"
