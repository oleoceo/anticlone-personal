#!/usr/bin/env bash
# Controlled local export, never a worktree or production deployment.
set -Eeuo pipefail
cd /mnt/c/Projetos/anticlone-personal
target=$(mktemp -d /tmp/anticlone-front3-source-XXXXXX)
evidence="$PWD/test-results/front3/$(date -u +%Y%m%dT%H%M%SZ)"
finish(){ code=$?; trap - EXIT; mkdir -p "$evidence"; if [[ -d "$target/test-results/front3" ]];then cp -a "$target/test-results/front3/." "$evidence/" || code=1;fi; printf 'source=%s\nwrapper_exit=%s\n' "$target" "$code" > "$evidence/wrapper.txt"; printf 'Evidence: %s\n' "$evidence"; exit "$code"; }
trap finish EXIT
git ls-files -z | tar --null -T - -cf - | tar -xf - -C "$target"
docker start anticlone-investigation-lab >/dev/null
docker exec anticlone-investigation-lab bash -c 'getent hosts gateway.test >/dev/null || printf "127.0.0.1 gateway.test\n" >> /etc/hosts'
runner=local-ci.sh
if [[ ${1:-full} == focused ]];then runner=front3-focused.sh;fi
docker exec -e PATH=/opt/node22/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin -e GIT_DIR=/gitroot/.git -e GIT_WORK_TREE="$target" -e LOCAL_CI_LOG_DIR="$target/test-results/front3" anticlone-investigation-lab bash "$target/scripts/$runner" "$target"
