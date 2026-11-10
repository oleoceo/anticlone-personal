#!/usr/bin/env bash
# Run in Linux with Node 22, PostgreSQL 16 client tools, Python, Docker/Compose,
# OpenSSL, Playwright OS dependencies and gateway.test resolving to 127.0.0.1.
# Creates only a disposable PostgreSQL container; never consumes DATABASE_URL.
set -Eeuo pipefail
runner=$(realpath "${BASH_SOURCE[0]}")
cd "${1:-$(dirname "$runner")/..}"
sha=$(git rev-parse HEAD)
log_dir=${LOCAL_CI_LOG_DIR:-"$PWD/test-results/local-ci/$(date -u +%Y%m%dT%H%M%SZ)-${sha:0:12}"}
mkdir -p "$log_dir"
log_dir=$(realpath "$log_dir")
pg_container="anticlone-local-ci-$(date +%s)-$$"
printf 'step\tutc\tseconds\texit_code\tcommand\n' > "$log_dir/steps.tsv"
printf 'sha=%s\nstarted=%s\nsource=%s\n' "$sha" "$(date -u +%FT%TZ)" "$PWD" > "$log_dir/result.txt"
cp "$runner" "$log_dir/runner.sh"
started=$SECONDS
cleanup() {
  code=$?
  trap - EXIT
  if docker container inspect "$pg_container" >/dev/null 2>&1; then
    docker rm -f "$pg_container" > "$log_dir/cleanup.log" 2>&1 || { cleanup_code=$?; if ((code==0)); then code=$cleanup_code; fi; }
  fi
  printf 'finished=%s\nduration_seconds=%s\nexit_code=%s\n' "$(date -u +%FT%TZ)" "$((SECONDS-started))" "$code" >> "$log_dir/result.txt"
  printf 'Local CI exit=%s; evidence=%s\n' "$code" "$log_dir"
  exit "$code"
}
trap cleanup EXIT
step() {
  local name=$1; shift
  local start=$SECONDS utc code rendered
  local -a statuses
  utc=$(date -u +%FT%TZ)
  printf -v rendered '%q ' "$@"
  printf '\n[%s] %s\n' "$name" "$rendered"
  set +e
  "$@" 2>&1 | tee "$log_dir/$name.log"
  statuses=("${PIPESTATUS[@]}")
  code=${statuses[0]}
  if ((code==0)); then code=${statuses[1]}; fi
  set -e
  printf '%s\t%s\t%s\t%s\t%s\n' "$name" "$utc" "$((SECONDS-start))" "$code" "$rendered" >> "$log_dir/steps.tsv"
  return "$code"
}
step versions bash -c 'node --version; npm --version; python3 --version; pg_dump --version; pg_restore --version; openssl version; docker version; docker compose version'
step requirements bash -ec '[[ $(node -p "process.versions.node.split(\".\")[0]") == 22 ]]; pg_dump --version | grep -Eq " 16[.]"; pg_restore --version | grep -Eq " 16[.]"; getent ahostsv4 gateway.test | grep -q "^127.0.0.1 "'
git status --porcelain > "$log_dir/git-status.txt"
python3 - "$log_dir/source.sha256" <<'PY'
from pathlib import Path
import hashlib,sys
files=[p for root in ('apps','runtime','infra','shared','tests','scripts','docs','.github') if Path(root).is_dir() for p in Path(root).rglob('*') if p.is_file() and '__pycache__' not in p.parts]
files += [p for p in Path('.').glob('*') if p.is_file()]
Path(sys.argv[1]).write_text(''.join(hashlib.sha256(p.read_bytes().replace(b'\r\n',b'\n')).hexdigest()+'  '+str(p)+'\n' for p in sorted(set(files))),encoding='utf-8')
PY
step documents python3 scripts/validate_repo.py
step python python3 -m unittest discover -s scripts -p 'test_*.py'
step npm-ci npm ci
step chromium npx playwright install --with-deps chromium
step browser-version node --input-type=module -e 'import {chromium} from "playwright"; const b=await chromium.launch(); console.log("Playwright",(await import("playwright/package.json",{with:{type:"json"}})).default.version); console.log("Chromium",b.version()); await b.close();'
step nginx docker pull nginx:1.28-alpine
step image docker build -f infra/https/Dockerfile -t anticlone-pilot:test .
step compose env GATEWAY_IMAGE=anticlone-pilot:test GATEWAY_ENV_FILE=/dev/null DATABASE_PASSWORD_FILE=/dev/null NGINX_CONFIG=/tmp/nginx.conf TLS_DIRECTORY=/tmp/tls docker compose -f infra/https/compose.yaml config --quiet
step postgres docker run -d --name "$pg_container" --publish 127.0.0.1::5432 --tmpfs /var/lib/postgresql/data -e POSTGRES_USER=anticlone -e POSTGRES_PASSWORD=test-only -e POSTGRES_DB=anticlone_test postgres:16
step postgres-ready bash -ec 'for i in {1..60}; do if docker exec "$1" pg_isready -U anticlone -d anticlone_test; then exit 0; fi; sleep 1; done; exit 1' -- "$pg_container"
step postgres-version docker exec "$pg_container" psql -U anticlone -d anticlone_test -Atc 'SELECT version()'
step images docker image inspect --format '{{.Id}} {{json .RepoTags}} {{json .RepoDigests}}' postgres:16 nginx:1.28-alpine anticlone-pilot:test
pg_port=$(docker port "$pg_container" 5432/tcp)
[[ $pg_port =~ ^127\.0\.0\.1:([0-9]+)$ ]]
# Only this script-owned, loopback-published disposable database is admitted.
unset DATABASE_URL PGOPTIONS PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD PGPASSFILE
export TEST_DATABASE_URL="postgres://anticlone:test-only@127.0.0.1:${BASH_REMATCH[1]}/anticlone_test"
export HTTPS_GATE_TEST=1
step lint npm run lint
step typecheck npm run typecheck
step build npm run build
step tests npm test
step final-build npm run build
(cd "$log_dir" && sha256sum ./*.log steps.tsv source.sha256 runner.sh > evidence.sha256)
