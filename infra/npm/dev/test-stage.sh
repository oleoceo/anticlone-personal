#!/usr/bin/env bash
# Exercises the real stage/rollback functions with a private filesystem and process doubles.
set -Eeuo pipefail
script=$(realpath -- "${BASH_SOURCE[0]}")
source "$(dirname -- "$script")/npm-gate.sh"

fixture() {
  local directory=$1 operation=$2
  data=$directory/data
  receipt=$directory/receipt
  active_receipt=$directory/active-receipt
  release_sha=0606060606060606060606060606060606060606
  bridge=172.19.0.1
  peer=172.19.0.2
  master_uid=$(id -u)
  docker_host=(true)
  check_gateway_unit() { :; }
  check_npm_receipt() { :; }
  preflight() { [[ ! -f $directory/npm-unavailable ]]; }
  certificates() { printf '%s\n' 'fixture certificate inventory'; }
  copy_dev_tls() { printf 'fixture certificate %s\n' "$1" > "$2"; }
  as_dev() { [[ $* == "systemctl --user disable $gateway_unit" ]]; }
  as_gateway() {
    case $1 in
      authorizations) echo 0 ;;
      smoke) [[ $(cat "$directory/listener") == 127.0.0.1:13003 ]] ;;
      bind)
        [[ "$2:$3" == "$bridge:$peer" || "$2:$3" == 127.0.0.1:127.0.0.1 ]]
        printf '%s\n' "$2" >> "$directory/bind-attempts"
        if [[ $2 == 127.0.0.1 && -f $directory/deny-loopback ]]; then return 34; fi
        printf '%s:13003\n' "$2" > "$directory/listener"
        if [[ $2 == "$bridge" && -f $directory/fail-bridge ]]; then return 47; fi
        ;;
      *) return 1 ;;
    esac
  }
  test_live_backend() { :; }
  live() {
    case $* in
      'nginx -T') cat "$receipt/live-before.conf" ;;
      'nginx -t')
        if [[ ! -e $directory/stage-failed ]] && cmp -s "$data/$site" "$receipt/candidate/13.conf"; then
          touch "$directory/stage-failed"
          printf '%s\n' 'include /other/project.conf;' >> "$data/$hook"
          return 53
        fi
        ;;
      *) return 1 ;;
    esac
  }
  mv() {
    if [[ ${*: -1} == "$data/$site" && -f $directory/stage-failed ]]; then
      if [[ -f $directory/wait-for-loopback ]]; then
        # Prove stage recovery does not wait for the NPM leg to finish first.
        local i
        for ((i=0; i<60; i++)); do
          if [[ $(cat "$directory/listener") == 127.0.0.1:13003 ]]; then break; fi
          sleep .05
        done
        [[ $(cat "$directory/listener") == 127.0.0.1:13003 ]] || return 74
      fi
      if [[ -f $directory/deny-npm ]]; then return 71; fi
    fi
    command mv "$@"
  }
  "$operation"
}

if [[ ${1:-} == fixture ]]; then
  fixture "$2" "$3"
  exit
fi

sandbox=$(mktemp -d)
trap 'find "$sandbox" -depth -delete' EXIT

init_fixture() {
  local directory=$1
  mkdir -p "$directory/data/nginx/"{custom,proxy_host} "$directory/receipt/"{candidate,original}
  printf '%s\n' 'server { server_name protect.leoceo.online; }' > "$directory/data/$site"
  printf '%s\n' 'server { server_name another.test; }' > "$directory/data/nginx/proxy_host/17.conf"
  printf '%s\n' 'include /other/original.conf;' > "$directory/data/$hook"
  cp "$directory/data/$site" "$directory/receipt/original/13.conf"
  cp "$directory/data/$hook" "$directory/receipt/original/http_top.conf"
  cp "$directory/data/nginx/proxy_host/17.conf" "$directory/other"
  printf '%s\n' 'include /data/nginx/custom/anticlone-dev/proxy-host.conf;' > "$directory/receipt/candidate/13.conf"
  cat "$directory/data/$hook" > "$directory/receipt/candidate/http_top.conf"
  printf '%s\n' 'include /data/nginx/custom/anticlone-dev/http-limits.conf;' >> "$directory/receipt/candidate/http_top.conf"
  touch "$directory/receipt/candidate/"{http-limits,proxy-host,proxy-location,advanced}.conf
  printf '# configuration file /etc/nginx/nginx.conf:\nhttp {}\n' > "$directory/receipt/live-before.conf"
  printf '%s\n' 'leoceo commit=0606060606060606060606060606060606060606' > "$directory/receipt/operator-approval"
  printf '%s\n' 'fixture certificate inventory' > "$directory/receipt/certificates"
  echo 0 > "$directory/receipt/dev-authorizations"
  echo 127.0.0.1:13003 > "$directory/listener"
}

run_fixture() {
  local expected=$1 directory=$2 operation=$3 status=0
  bash "$script" fixture "$directory" "$operation" > "$directory/$operation.out" 2>&1 || status=$?
  if [[ $status != "$expected" ]]; then cat "$directory/$operation.out" >&2; return 1; fi
  cmp "$directory/other" "$directory/data/nginx/proxy_host/17.conf"
}

check_restored_npm() {
  local directory=$1
  cmp "$directory/receipt/original/13.conf" "$directory/data/$site"
  if [[ -e $directory/stage-failed ]]; then
    cmp "$directory/data/$hook" <(cat "$directory/receipt/original/http_top.conf"; echo 'include /other/project.conf;')
  else
    cmp "$directory/data/$hook" "$directory/receipt/original/http_top.conf"
  fi
  [[ ! -e $directory/data/$exclusive ]]
}

early=$sandbox/bridge
init_fixture "$early"
touch "$early/fail-bridge"
unlink "$early/data/$hook"
unlink "$early/receipt/original/http_top.conf"
run_fixture 47 "$early" stage
cmp "$early/receipt/original/13.conf" "$early/data/$site"
[[ ! -e $early/data/$hook && ! -e $early/data/$exclusive ]]
[[ $(cat "$early/listener") == 127.0.0.1:13003 && -f $early/receipt/rolled-back && ! -e $early/active-receipt ]]
grep -q 'erro_inicial=47 npm_rc=0 loopback_rc=0' "$early/receipt/recovery.log"

npm_failure=$sandbox/npm
init_fixture "$npm_failure"
touch "$npm_failure/deny-npm" "$npm_failure/wait-for-loopback"
run_fixture 53 "$npm_failure" stage
grep -q 'erro_inicial=53 npm_rc=71 loopback_rc=0' "$npm_failure/receipt/recovery.log"
[[ $(cat "$npm_failure/listener") == 127.0.0.1:13003 && -f $npm_failure/active-receipt ]]
cmp "$npm_failure/receipt/candidate/13.conf" "$npm_failure/data/$site"
unlink "$npm_failure/deny-npm"
touch "$npm_failure/npm-unavailable"
run_fixture 1 "$npm_failure" rollback
grep -q 'rollback=operator etapa=loopback rc=0' "$npm_failure/receipt/recovery.log"
unlink "$npm_failure/npm-unavailable"
run_fixture 0 "$npm_failure" rollback
check_restored_npm "$npm_failure"
[[ -f $npm_failure/receipt/rolled-back && ! -e $npm_failure/active-receipt ]]
attempts=$(wc -l < "$npm_failure/bind-attempts")
run_fixture 0 "$npm_failure" rollback
[[ $(wc -l < "$npm_failure/bind-attempts") == "$attempts" ]]

loopback_failure=$sandbox/loopback
init_fixture "$loopback_failure"
touch "$loopback_failure/deny-loopback"
run_fixture 53 "$loopback_failure" stage
check_restored_npm "$loopback_failure"
grep -q 'erro_inicial=53 npm_rc=0 loopback_rc=34' "$loopback_failure/receipt/recovery.log" || { cat "$loopback_failure/receipt/recovery.log" "$loopback_failure/stage.out"; exit 1; }
[[ $(cat "$loopback_failure/listener") == 172.19.0.1:13003 && -f $loopback_failure/active-receipt ]]
run_fixture 1 "$loopback_failure" stage
grep -q 'Recupere o recibo ativo' "$loopback_failure/stage.out"
unlink "$loopback_failure/deny-loopback"
run_fixture 0 "$loopback_failure" rollback
check_restored_npm "$loopback_failure"
[[ $(cat "$loopback_failure/listener") == 127.0.0.1:13003 && ! -e $loopback_failure/active-receipt ]]

printf '%s\n' 'PASS stage: bridge parcial, restauração NPM, retorno a loopback, recuperação repetível e outro Proxy Host preservado.'

(
  repository=$snapshot
  snapshot=$sandbox/package
  here=$snapshot/infra/npm/dev
  mkdir -p "$here"
  files=(infra/npm/{http-limits,proxy-host,proxy-location}.conf
    infra/npm/dev/{npm-gate.sh,render.py,clone-probe.cjs,gateway.sh,anticlone-dev-public-gateway.service})
  for file in "${files[@]}"; do cp "$repository/$file" "$snapshot/$file"; done
  printf 'printf "helper revisado %%s\\n" "$1"\n' > "$here/gateway.sh"
  (
    cd "$snapshot"
    sha256sum -- "${files[@]}" > package.sha256
    chmod 400 package.sha256 "${files[@]}"
  )
  # Simulate uid 0 for the package files. All paths and modes are real.
  stat() { printf '0:%s\n' "$(command stat -c %a "${*: -1}")"; }
  verify_package
  gateway_unit_path=$sandbox/installed.service
  cp "$here/$gateway_unit" "$gateway_unit_path"
  drop_in=
  reload=no
  as_dev() {
    if [[ $1 == systemctl ]]; then
      printf 'FragmentPath=%s\nDropInPaths=%s\nNeedDaemonReload=%s\n' "$gateway_unit_path" "$drop_in" "$reload"
    else
      "$@"
    fi
  }
  check_gateway_unit
  [[ $(as_gateway smoke) == 'helper revisado smoke' ]]
  drop_in=/example/override.conf
  if check_gateway_unit 2>/dev/null; then exit 1; fi
  drop_in=
  reload=yes
  if check_gateway_unit 2>/dev/null; then exit 1; fi
  reload=no
  chmod 600 "$gateway_unit_path"
  echo '# modified installed unit' >> "$gateway_unit_path"
  if check_gateway_unit 2>/dev/null; then exit 1; fi
  chmod 600 "$here/gateway.sh"
  echo '# modified helper' >> "$here/gateway.sh"
  chmod 400 "$here/gateway.sh"
  if verify_package; then exit 1; fi
  printf '%s\n' 'PASS integridade: helper revisado, detecção de alteração, unidade instalada, drop-ins e reload pendente.'
)
