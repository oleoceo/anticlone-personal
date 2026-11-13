#!/usr/bin/env bash
# CI only: a PG18 archive/restore emits transaction_timeout, unsupported by PG16.
# Invoked via pg_dump/pg_restore symlinks; credentials remain in the environment.
set -euo pipefail
tool=$(basename "$0")
case "$tool" in pg_dump|pg_restore) ;; *) exit 64 ;; esac
exec docker run --rm --network host --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --user "$(id -u):$(id -g)" \
  --mount type=bind,src=/tmp,dst=/tmp,readonly \
  --env PGHOST --env PGPORT --env PGDATABASE --env PGUSER --env PGPASSWORD \
  --env PGOPTIONS --env PGAPPNAME postgres:16 "$tool" "$@"
