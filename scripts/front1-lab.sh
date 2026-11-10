#!/usr/bin/env bash
# Export the current controlled working copy to the existing local integration
# lab. This is not a worktree, deployment, or an untrusted-page verifier.
set -Eeuo pipefail
cd /mnt/c/Projetos/anticlone-personal
target=$(mktemp -d /tmp/anticlone-front1-source-XXXXXX)
evidence="$PWD/test-results/front1/$(date -u +%Y%m%dT%H%M%SZ)"
persist_evidence() {
  code=$?
  trap - EXIT
  mkdir -p "$evidence"
  if [[ -d "$target/test-results/front1" ]]; then cp -a "$target/test-results/front1/." "$evidence/" || code=1; fi
  printf 'source=%s\nwrapper_exit=%s\n' "$target" "$code" > "$evidence/wrapper.txt"
  printf 'Persistent evidence: %s\n' "$evidence"
  exit "$code"
}
trap persist_evidence EXIT
git ls-files -z | tar --null -T - -cf - | tar -xf - -C "$target"
printf 'source=%s\n' "$target"
docker start anticlone-investigation-lab >/dev/null
docker exec anticlone-investigation-lab bash -c 'getent hosts gateway.test >/dev/null || printf "127.0.0.1 gateway.test\n" >> /etc/hosts'
docker exec -e PATH=/opt/node22/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin -e GIT_DIR=/gitroot/.git -e GIT_WORK_TREE="$target" -e LOCAL_CI_LOG_DIR="$target/test-results/front1" anticlone-investigation-lab bash "$target/scripts/local-ci.sh" "$target"
