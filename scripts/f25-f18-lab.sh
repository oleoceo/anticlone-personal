#!/usr/bin/env bash
# Export controlled sources; this is a laboratory run, never a deployment.
set -Eeuo pipefail
cd /mnt/c/Projetos/anticlone-personal
target=$(mktemp -d /tmp/anticlone-f25-f18-XXXXXX)
printf '%s\n' "$target" > /tmp/anticlone-f25-f18-path
evidence="$PWD/test-results/f25-f18/$(date -u +%Y%m%dT%H%M%SZ)"
finish(){ code=$?;trap - EXIT;mkdir -p "$evidence";for part in f25-f18 f18 full;do if [[ -d "$target/test-results/$part" ]];then cp -a "$target/test-results/$part" "$evidence/" || code=1;fi;done;printf 'source=%s\nexit=%s\n' "$target" "$code" > "$evidence/wrapper.txt";printf 'Evidence: %s\n' "$evidence";exit "$code"; }
trap finish EXIT
git ls-files -z | tar --null -T - -cf - | tar -xf - -C "$target"
docker start anticlone-investigation-lab >/dev/null
docker exec anticlone-investigation-lab bash -c 'getent hosts gateway.test >/dev/null || printf "127.0.0.1 gateway.test\n" >> /etc/hosts'
runner=f25-f18-focused.sh
if [[ ${1:-focused} == full ]];then runner=local-ci.sh;fi
docker exec -e PATH=/opt/node22/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin -e GIT_DIR=/gitroot/.git -e GIT_WORK_TREE="$target" -e LOCAL_CI_LOG_DIR="$target/test-results/full" anticlone-investigation-lab bash "$target/scripts/$runner" "$target"
