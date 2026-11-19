#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
snapshot=$(cd -- "$here/../../.." && pwd -P)
tools_dir=/var/lib/anticlone-dev-npm-tools
active_receipt=$tools_dir/active-receipt
private=/opt/apps/apps/personal/anticlone-dev/private/dev-public-gateway
docker_host=(docker --host unix:///var/run/docker.sock)
npm=nginx-proxy-manager-app-1
gateway_unit=anticlone-dev-public-gateway.service
gateway_unit_path=/home/anticlone-dev/.config/systemd/user/$gateway_unit
port=13003
site=nginx/proxy_host/13.conf
hook=nginx/custom/http_top.conf
exclusive=nginx/custom/anticlone-dev

fail() { printf 'BLOCKED NPM_TRAFFIC_GATE — %s\n' "$*" >&2; exit 1; }
live() { "${docker_host[@]}" exec -i --user 0 "$npm" "$@"; }
as_dev() {
  sudo -u anticlone-dev env XDG_RUNTIME_DIR="/run/user/$(id -u anticlone-dev)" "$@"
}
as_gateway() {
  # Root opens the reviewed helper. Bash runs it with the Dev identity.
  as_dev /bin/bash -p -s -- "$@" < "$here/gateway.sh"
}

verify_package() (
  cd -- "$snapshot" || return "$?"
  local -a files=(infra/npm/{http-limits,proxy-host,proxy-location}.conf
    infra/npm/dev/{npm-gate.sh,render.py,clone-probe.cjs,gateway.sh,anticlone-dev-public-gateway.service})
  local file
  for file in package.sha256 "${files[@]}"; do
    [[ -f $file && ! -L $file && $(stat -c %u:%a "$file") == 0:400 ]] || return 1
  done
  sha256sum -- "${files[@]}" | cmp -s package.sha256 -
)

check_gateway_unit() {
  local properties
  if properties=$(as_dev systemctl --user show "$gateway_unit" -p FragmentPath -p DropInPaths -p NeedDaemonReload) &&
     grep -Fxq "FragmentPath=$gateway_unit_path" <<< "$properties" &&
     grep -Fxq 'DropInPaths=' <<< "$properties" &&
     grep -Fxq 'NeedDaemonReload=no' <<< "$properties" &&
     cmp -s "$here/$gateway_unit" <(as_dev cat -- "$gateway_unit_path"); then
    return 0
  fi
  printf '%s\n' 'A unidade Dev instalada ou carregada diverge da unidade revisada.' >&2
  return 1
}
copy_dev_tls() {
  local source=$1 target=$2
  as_dev cat "$private/$source" > "$target"
  chmod 400 "$target"
}

preflight() {
  local network driver proxy_id network_id
  image=$("${docker_host[@]}" inspect --format '{{.Image}}' "$npm") || return "$?"
  npm_id=$("${docker_host[@]}" inspect --format '{{.Id}}' "$npm") || return "$?"
  driver=$("${docker_host[@]}" network inspect --format '{{.Driver}}' proxy) || return "$?"
  [[ $driver == bridge ]] || fail 'A rede proxy não é uma bridge.'
  proxy_id=$("${docker_host[@]}" network inspect --format '{{.Id}}' proxy) || return "$?"
  network=$("${docker_host[@]}" inspect --format '{{with index .NetworkSettings.Networks "proxy"}}{{.NetworkID}} {{.Gateway}} {{.IPAddress}}{{end}}' "$npm") || return "$?"
  read -r network_id bridge peer <<< "$network" || return "$?"
  [[ $network_id == "$proxy_id" && -n $bridge && -n $peer ]] || fail 'NPM sem IPv4/gateway em proxy.'
  ip -o -4 addr show scope global | awk '{print $4}' | cut -d/ -f1 | grep -Fxq "$bridge" ||
    fail 'O endereço gateway de proxy não pertence ao host.'
  [[ $(ip -4 route get "$peer" from "$bridge" | head -1) == *" dev br-"* ]] ||
    fail 'Rota do gateway ao peer NPM não usa uma bridge Docker.'
  data=$("${docker_host[@]}" inspect --format '{{range .Mounts}}{{if and (eq .Destination "/data") .RW}}{{.Source}}{{end}}{{end}}' "$npm") || return "$?"
  [[ -n $data && -d $data && $(realpath -e -- "$data") == "$data" ]] ||
    fail 'Mount persistente /data gravável não comprovado.'
  [[ $("${docker_host[@]}" inspect --format '{{range .Mounts}}{{if eq .Destination "/etc/letsencrypt"}}yes{{end}}{{end}}' "$npm") == yes ]] ||
    fail 'Mount /etc/letsencrypt não comprovado.'
  [[ -f $data/$site && ! -L $data/$site && $(realpath -e -- "$data/$site") == "$data/$site" ]] ||
    fail 'Falta uma configuração renderizada e segura do host 13 para clonar.'
  [[ -d $data/nginx/custom && $(realpath -e -- "$data/nginx/custom") == "$data/nginx/custom" &&
     ! -L $data/$hook && ( ! -e $data/$hook || -f $data/$hook ) && ! -L $data/$exclusive ]] ||
    fail 'Caminhos custom do NPM incompatíveis.'
  master_uid=$(live sh -c 'ps -eo uid,args | awk '"'"'$2=="nginx:" && $3=="master" {print $1}'"'"'') || return "$?"
  [[ $master_uid =~ ^[0-9]+$ ]] || fail 'UID do master Nginx não comprovado.'
}

metadata() { printf '%s\n' "$npm_id" "$image" "$data" "$bridge" "$peer" "$master_uid"; }
certificates() {
  local file
  for file in server/{server.crt,client-ca.crt} npm/{npm.crt,server-ca.crt} monitor/monitor.crt; do
    printf '%s ' "$file"
    as_dev cat "$private/$file" | sha256sum
  done
}

clone_gate() (
  [[ ! -e $data/$exclusive ]] || fail 'Diretório AntiClone Dev já existe no NPM.'
  receipt=$(mktemp -d /var/backups/anticlone-dev-npm.XXXXXX)
  printf 'Recibo privado %s\n' "$receipt" >&2
  metadata > "$receipt/installation"
  printf '%s\n' "$release_sha" > "$receipt/release-sha"
  cp -- "$snapshot/package.sha256" "$receipt/package.sha256"
  certificates > "$receipt/certificates"
  as_gateway authorizations > "$receipt/dev-authorizations"
  local clone_name="anticlone-dev-npm-gate-${receipt##*.}"
  local lab
  lab=$(mktemp -d /var/tmp/anticlone-dev-npm-gate.XXXXXX)
  trap '"${docker_host[@]}" rm -f -v "$clone_name" >/dev/null 2>&1 || true; find "$lab" -depth -delete' EXIT
  install -d "$receipt"/{candidate,original} "$lab"/{data,etc-nginx,etc-letsencrypt,gate}
  live nginx -V > "$receipt/npm-version.log" 2>&1
  live nginx -t > "$receipt/live-before-test.log" 2>&1
  live nginx -T > "$receipt/live-before.conf" 2> "$receipt/live-before.log"
  "${docker_host[@]}" inspect --format '{{json .Mounts}}' "$npm" > "$receipt/mounts.private.json"
  cp -p -- "$data/$site" "$receipt/original/13.conf"
  if [[ -f $data/$hook ]]; then cp -p -- "$data/$hook" "$receipt/original/http_top.conf"; fi
  cp -pR -- "$data/nginx" "$lab/data/"
  install -d "$lab/data/logs"
  if [[ -d $data/custom_ssl ]]; then cp -pR -- "$data/custom_ssl" "$lab/data/"; fi
  "${docker_host[@]}" cp -a "$npm:/etc/nginx/." "$lab/etc-nginx/"
  "${docker_host[@]}" cp -a "$npm:/etc/letsencrypt/." "$lab/etc-letsencrypt/"
  grep -Eq 'include[[:space:]]+/data/nginx/custom/http_top(\[\.\]|\.)conf;' "$lab/etc-nginx/nginx.conf" ||
    fail 'Hook http_top do NPM não encontrado.'
  python3 "$here/render.py" render "$receipt/candidate" "$bridge" "$receipt/original/13.conf" "$receipt/original/http_top.conf"
  for file in server.crt server.key client-ca.crt; do
    copy_dev_tls "server/$file" "$lab/gate/$file"
  done
  install -m 400 "$here/clone-probe.cjs" "$lab/gate/clone-probe.cjs"
  install -d "$lab/data/$exclusive/tls"
  for file in npm.crt npm.key server-ca.crt; do
    copy_dev_tls "npm/$file" "$lab/data/$exclusive/tls/$file"
  done
  "${docker_host[@]}" run -d --name "$clone_name" --network none --no-healthcheck --entrypoint /bin/sh \
    --mount "type=bind,src=$lab/data,dst=/data" \
    --mount "type=bind,src=$lab/etc-nginx,dst=/etc/nginx,readonly" \
    --mount "type=bind,src=$lab/etc-letsencrypt,dst=/etc/letsencrypt,readonly" \
    --mount "type=bind,src=$lab/gate,dst=/gate,readonly" \
    "$image" -c 'exec sleep infinity' >/dev/null
  local -a clone=("${docker_host[@]}" exec --user 0 "$clone_name")
  "${clone[@]}" nginx -T > "$receipt/clone-before.conf" 2> "$receipt/clone-before.log" ||
    fail "Nginx da imagem real falhou no clone isolado. Consulte $receipt/clone-before.log."
  python3 "$here/render.py" baseline "$receipt/live-before.conf" "$receipt/clone-before.conf"
  cp -- "$receipt/candidate/"{13,http_top,http-limits,proxy-host,proxy-location}.conf "$lab/gate/"
  sed -i -e "s/\"$bridge\"/\"127.0.0.1\"/" "$lab/gate/13.conf"
  sed -i -e "s|https://$bridge:$port;|https://127.0.0.1:$port;|" "$lab/gate/proxy-location.conf"
  cp -- "$lab/gate/13.conf" "$lab/data/$site"
  cp -- "$lab/gate/http_top.conf" "$lab/data/$hook"
  cp -- "$lab/gate/"{http-limits,proxy-host,proxy-location}.conf "$lab/data/$exclusive/"
  cat > "$lab/gate/other.conf" <<'NGINX'
server {
  listen 443 ssl;
  server_name other.fixture.test;
  ssl_certificate /gate/server.crt;
  ssl_certificate_key /gate/server.key;
  location / { return 200 "isolated fixture"; }
}
NGINX
  cp -- "$lab/gate/other.conf" "$lab/data/nginx/proxy_host/zz-anticlone-dev-gate.conf"
  "${clone[@]}" nginx -t > "$receipt/clone-candidate-test.log" 2>&1 ||
    fail "Configuração candidata incompatível. Consulte $receipt/clone-candidate-test.log."
  "${clone[@]}" nginx -T > "$receipt/clone-candidate.conf" 2> "$receipt/clone-candidate.log"
  python3 "$here/render.py" compare "$receipt/clone-before.conf" "$receipt/clone-candidate.conf" "$lab/gate" fixture
  "${clone[@]}" nginx > "$receipt/clone-start.log" 2>&1
  local pin
  pin=$(openssl x509 -in "$lab/data/$exclusive/tls/npm.crt" -noout -fingerprint -sha256 | cut -d= -f2)
  "${clone[@]}" node /gate/clone-probe.cjs "$pin" > "$receipt/clone-probe.log" 2>&1 ||
    fail "Teste de tráfego recusado. Consulte $receipt/clone-probe.log."
  diff -u "$receipt/clone-before.conf" "$receipt/clone-candidate.conf" > "$receipt/clone.diff" || [[ $? == 1 ]]
  (cd "$receipt" && sha256sum installation release-sha package.sha256 certificates dev-authorizations original/* candidate/* \
    live-before.conf clone-candidate.conf clone.diff clone-probe.log > approved.sha256)
  printf '%s\n' "$receipt"
)

atomic_config() (
  local src=$1 dst=$2 temp
  temp=$(mktemp "${dst%/*}/.anticlone-dev.XXXXXX") || return "$?"
  trap 'if [[ -e $temp ]]; then unlink "$temp"; fi' EXIT
  cat -- "$src" > "$temp" || return "$?"
  if [[ -f $dst ]]; then
    chmod --reference="$dst" "$temp" || return "$?"
    chown --reference="$dst" "$temp" || return "$?"
  else
    chown "$master_uid" "$temp" || return "$?"
    chmod 600 "$temp" || return "$?"
  fi
  mv -fT -- "$temp" "$dst"
)

remove_installation() {
  local item
  for item in {http-limits,proxy-host,proxy-location}.conf tls/{npm.crt,npm.key,server-ca.crt}; do
    if [[ -f $data/$exclusive/$item ]]; then unlink "$data/$exclusive/$item" || return "$?"; fi
  done
  if [[ -d $data/$exclusive/tls ]]; then rmdir -- "$data/$exclusive/tls" || return "$?"; fi
  if [[ -d $data/$exclusive ]]; then rmdir -- "$data/$exclusive"; fi
}

detach_hook() (
  if [[ ! -f $data/$hook ]]; then return 0; fi
  if cmp -s "$data/$hook" "$receipt/candidate/http_top.conf"; then
    if [[ -f $receipt/original/http_top.conf ]]; then
      atomic_config "$receipt/original/http_top.conf" "$data/$hook"
    else
      unlink "$data/$hook"
    fi
  else
    local clean
    clean=$(mktemp "$receipt/.hook.XXXXXX") || return "$?"
    trap 'unlink "$clean"' EXIT
    python3 "$here/render.py" detach "$data/$hook" > "$clean" || return "$?"
    if ! cmp -s "$clean" "$data/$hook"; then atomic_config "$clean" "$data/$hook"; fi
  fi
)

restore_original() {
  local status
  [[ -f $data/$site && ! -L $data/$site ]] || return 1
  if cmp -s "$data/$site" "$receipt/candidate/13.conf"; then
    atomic_config "$receipt/original/13.conf" "$data/$site" || return "$?"
  else
    status=0
    grep -Fq '/data/nginx/custom/anticlone-dev/' "$data/$site" || status=$?
    if [[ $status != 1 ]]; then
      printf '%s\n' 'O host 13 ainda usa os includes ou está ilegível. Confira os valores na UI.' >&2
      return 1
    fi
  fi
  detach_hook || return "$?"
  remove_installation
}

test_live_backend() {
  live node - "$bridge" <<'JS'
const {request} = require('node:https');
const {readFileSync} = require('node:fs');
const dir = '/data/nginx/custom/anticlone-dev/tls/';
const host = 'protect.leoceo.online';
const req = request({hostname: process.argv[2], port: 13003, path: '/healthz', servername: host,
  ca: readFileSync(dir + 'server-ca.crt'), cert: readFileSync(dir + 'npm.crt'), key: readFileSync(dir + 'npm.key'),
  headers: {Host: host, 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '127.0.0.1'}, timeout: 4000}, res => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    if (res.statusCode !== 200 || body !== '{"status":"ready","mode":"OPERATIONAL","action":"SCOPED_AUTHORIZATION_REQUIRED"}') {
      process.exitCode = 1;
    }
  });
});
req.on('timeout', () => req.destroy(Error('timeout')));
req.on('error', () => {process.exitCode = 1;});
req.end();
JS
}

stage() (
  local claim
  [[ ! -e $active_receipt ]] || fail 'Recupere o recibo ativo antes de executar outro stage.'
  [[ ! -e $data/$exclusive ]] || fail 'Diretório AntiClone Dev já existe no NPM.'
  grep -q " commit=$release_sha$" "$receipt/operator-approval" ||
    fail 'O recibo ainda precisa do aceite do administrador para este SHA.'
  cmp -s <(certificates) "$receipt/certificates" || fail 'Os certificados Dev mudaram desde o clone.'
  [[ $(as_gateway authorizations) == "$(cat "$receipt/dev-authorizations")" ]] ||
    fail 'O total de autorizações Dev mudou desde a revisão.'
  live nginx -T > "$receipt/live-pre-stage.conf" 2> "$receipt/live-pre-stage.log"
  python3 "$here/render.py" baseline "$receipt/live-before.conf" "$receipt/live-pre-stage.conf"
  as_gateway smoke > "$receipt/dev-smoke.log"
  claim=$(mktemp "$active_receipt.XXXXXX")
  if ! printf '%s\n' "$receipt" > "$claim" || ! mv -fT -- "$claim" "$active_receipt"; then
    unlink "$claim"
    fail 'Não foi possível registrar o recibo ativo.'
  fi
  trap 'finish_stage "$?"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  install -d -m 755 "$data/$exclusive"
  install -d -m 700 -o "$master_uid" "$data/$exclusive/tls"
  for fragment in http-limits proxy-host proxy-location; do
    install -m 644 "$receipt/candidate/$fragment.conf" "$data/$exclusive/$fragment.conf"
  done
  for file in npm.key npm.crt server-ca.crt; do
    copy_dev_tls "npm/$file" "$data/$exclusive/tls/$file"
    chown "$master_uid" "$data/$exclusive/tls/$file"
  done
  "${docker_host[@]}" exec --user "$master_uid" "$npm" sh -c \
    'test -r /data/nginx/custom/anticlone-dev/tls/npm.key'
  as_gateway bind "$bridge" "$peer"
  test_live_backend
  atomic_config "$receipt/candidate/http_top.conf" "$data/$hook"
  atomic_config "$receipt/candidate/13.conf" "$data/$site"
  "${docker_host[@]}" exec --user "$master_uid" "$npm" sh -c '
    for path do
      test -r "$path" || exit 1
    done
  ' sh "/data/$hook" "/data/$site" "/data/$exclusive/"{http-limits,proxy-host,proxy-location}.conf
  live nginx -t > "$receipt/live-stage-test.log" 2>&1
  live nginx -T > "$receipt/live-stage.conf" 2> "$receipt/live-stage.log"
  python3 "$here/render.py" compare "$receipt/live-before.conf" "$receipt/live-stage.conf" "$receipt/candidate"
  touch "$receipt/staged"
  printf 'Candidata conferida em disco e upstream mTLS privado validado. Destino HTTPS: %s:%s\n' "$bridge" "$port"
  cat "$receipt/candidate/advanced.conf"
)

verify() {
  [[ -f $receipt/staged ]] || fail 'Configuração candidata ausente.'
  cmp -s <(certificates) "$receipt/certificates" || fail 'Os certificados Dev mudaram desde o clone.'
  live nginx -t > "$receipt/live-after-test.log" 2>&1
  live nginx -T > "$receipt/live-after.conf" 2> "$receipt/live-after.log"
  python3 "$here/render.py" compare "$receipt/live-before.conf" "$receipt/live-after.conf" "$receipt/candidate" published
  test_live_backend
  live node - <<'JS'
const {request} = require('node:https');
const host = 'protect.leoceo.online';
(async () => {
  for (const [path, status] of [['/healthz',200], ['/admin/ui/',404], ['/login',404]]) {
    await new Promise((resolve, reject) => {
      // In-container smoke. Validate the public certificate separately.
      const req = request({hostname:'127.0.0.1', port:443, path, servername:host, headers:{Host:host},
        rejectUnauthorized:false, timeout:4000}, res => {
        res.resume();
        res.on('end', () => res.statusCode === status ? resolve() : reject(Error(path + ': ' + res.statusCode)));
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(Error('timeout')));
      req.end();
    });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
JS
  as_dev systemctl --user enable "$gateway_unit"
  touch "$receipt/verified"
  printf 'Proxy Host 13 validado no NPM. Recibo: %s\n' "$receipt"
}

recover_npm() (
  local origin=$1 status
  local -a docker_host=(timeout -k 2s 20s "${docker_host[@]}")
  if [[ $origin == operator ]]; then
    preflight || return "$?"
    check_npm_receipt rollback || return "$?"
    if [[ -f $receipt/staged ]]; then
      # The UI owns the persistent settings after a completed stage.
      status=0
      grep -Fq '/data/nginx/custom/anticlone-dev/' "$data/$site" || status=$?
      [[ $status == 1 ]] || fail 'Restaure os campos anteriores do host 13 na UI e repita o rollback.'
    fi
  fi
  restore_original || return "$?"
  live nginx -t > "$receipt/rollback-test.log" 2>&1 || return "$?"
  live nginx -T > "$receipt/rollback.conf" 2> "$receipt/rollback-nginx.log"
)

recover_gateway() {
  check_gateway_unit || return "$?"
  as_gateway bind 127.0.0.1 127.0.0.1 || return "$?"
  if [[ $1 == operator && -f $receipt/staged ]]; then
    as_dev systemctl --user disable "$gateway_unit"
  fi
}

recover_step() {
  local step=$1 action=$2 origin=$3 status=0
  "$action" "$origin" || status=$?
  printf '%s rollback=%s etapa=%s rc=%s\n' "$(date -u +%FT%TZ)" "$origin" "$step" "$status" |
    tee -a "$receipt/recovery.log" >&2 || :
  return "$status"
}

recover() {
  local origin=$1 trigger=$2 npm_status=0 gateway_status=0 gateway_pid npm_pid
  # Start both sides before waiting. Docker or systemd can block independently.
  recover_step loopback recover_gateway "$origin" &
  gateway_pid=$!
  recover_step npm recover_npm "$origin" &
  npm_pid=$!
  wait "$gateway_pid" || gateway_status=$?
  wait "$npm_pid" || npm_status=$?
  printf '%s rollback=%s erro_inicial=%s npm_rc=%s loopback_rc=%s\n' \
    "$(date -u +%FT%TZ)" "$origin" "$trigger" "$npm_status" "$gateway_status" |
    tee -a "$receipt/recovery.log" >&2 || :
  if ((npm_status || gateway_status)); then
    printf 'Rollback parcial. Repita rollback com o mesmo recibo: %s\n' "$receipt" >&2
    return 1
  fi
  touch "$receipt/rolled-back" || return "$?"
  rm -f -- "$receipt/staged" "$receipt/verified" || return "$?"
  unlink "$active_receipt"
}

finish_stage() {
  local status=$1
  trap - EXIT
  if ((status)); then recover stage "$status" || :; fi
  exit "$status"
}

check_npm_receipt() {
  if [[ $1 == rollback ]]; then
    cmp -s <(metadata | sed -n '1,3p') <(sed -n '1,3p' "$receipt/installation") ||
      fail 'NPM, imagem ou mount mudaram desde o clone.'
  else
    cmp -s <(metadata) "$receipt/installation" || fail 'NPM, imagem, mount ou rede mudaram desde o clone.'
  fi
}

check_receipt() {
  receipt=$1
  [[ $receipt =~ ^/var/backups/anticlone-dev-npm\.[A-Za-z0-9]{6}$ && -d $receipt &&
     $(stat -c %u:%a "$receipt") == 0:700 && ! -L $receipt ]] || fail 'Recibo privado inválido.'
  (cd "$receipt" && sha256sum --status -c approved.sha256) || fail 'O recibo ou a candidata foram alterados.'
  [[ $(cat "$receipt/release-sha") == "$release_sha" ]] &&
    cmp -s "$snapshot/package.sha256" "$receipt/package.sha256" ||
    fail 'O recibo pertence a outro pacote revisado.'
}

rollback() {
  if [[ $(cat -- "$active_receipt" 2>/dev/null) == "$receipt" ]]; then
    recover operator 0
  elif [[ -f $receipt/rolled-back ]]; then
    printf 'Rollback já concluído para %s\n' "$receipt"
  else
    fail 'O recibo informado não corresponde ao stage ativo.'
  fi
}

main() {
  [[ $EUID == 0 && ${SUDO_USER:-} == leoceo ]] || fail 'Execute via sudo como leoceo.'
  [[ $here =~ ^/var/lib/anticlone-dev-npm-tools/([0-9a-f]{40})/infra/npm/dev$ &&
     $(stat -c %u:%a "$tools_dir") == 0:700 && $(stat -c %u:%a "$snapshot") == 0:700 ]] ||
    fail 'Execute somente a cópia revisada no diretório privado de root.'
  release_sha=${BASH_REMATCH[1]}
  exec 9>"$tools_dir/gate.lock"
  flock -n 9 || fail 'Já existe um procedimento AntiClone Dev em execução.'
  verify_package || fail 'Arquivos do pacote revisado divergentes.'
  case ${1:-} in
    clone)
      check_gateway_unit || exit 1
      preflight
      clone_gate
      ;;
    stage|verify)
      check_receipt "${2:-}"
      check_gateway_unit || exit 1
      preflight
      check_npm_receipt "$1"
      if [[ $1 == verify && $(cat -- "$active_receipt" 2>/dev/null) != "$receipt" ]]; then
        fail 'O recibo informado não corresponde ao stage ativo.'
      fi
      "$1"
      ;;
    rollback)
      check_receipt "${2:-}"
      rollback
      ;;
    *) fail 'Uso: npm-gate.sh clone | {stage,verify,rollback} <recibo>.' ;;
  esac
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
