#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
dev_release=/opt/apps/apps/personal/anticlone-dev/dev-gateway-release
private=/opt/apps/apps/personal/anticlone-dev/private/dev-public-gateway
docker_host=(docker --host unix:///var/run/docker.sock)
npm=nginx-proxy-manager-app-1
port=13003
site=nginx/proxy_host/13.conf
hook=nginx/custom/http_top.conf
exclusive=nginx/custom/anticlone-dev
[[ $EUID == 0 && ${SUDO_USER:-} == leoceo ]] || { echo 'Execute via sudo como leoceo.' >&2; exit 1; }
[[ $here =~ ^/var/lib/anticlone-dev-npm-tools/([0-9a-f]{40})/infra/npm/dev$ &&
   $(stat -c %u:%a /var/lib/anticlone-dev-npm-tools) == 0:700 ]] ||
  { echo 'Execute somente a cópia revisada no diretório privado de root.' >&2; exit 1; }
release_sha=${BASH_REMATCH[1]}
exec 9>/var/lib/anticlone-dev-npm-tools/gate.lock
flock -n 9 || { echo 'Já existe um procedimento AntiClone Dev em execução.' >&2; exit 1; }

fail() { printf 'BLOCKED NPM_TRAFFIC_GATE — %s\n' "$*" >&2; exit 1; }
live() { "${docker_host[@]}" exec -i --user 0 "$npm" "$@"; }
as_dev() {
  sudo -u anticlone-dev env XDG_RUNTIME_DIR="/run/user/$(id -u anticlone-dev)" "$@"
}
as_gateway() { as_dev bash "$dev_release/infra/npm/dev/gateway.sh" "$@"; }
copy_dev_tls() {
  local source=$1 target=$2
  as_dev cat "$private/$source" > "$target"
  chmod 400 "$target"
}

preflight() {
  local network driver proxy_id network_id
  image=$("${docker_host[@]}" inspect --format '{{.Image}}' "$npm")
  npm_id=$("${docker_host[@]}" inspect --format '{{.Id}}' "$npm")
  driver=$("${docker_host[@]}" network inspect --format '{{.Driver}}' proxy)
  [[ $driver == bridge ]] || fail 'A rede proxy não é uma bridge.'
  proxy_id=$("${docker_host[@]}" network inspect --format '{{.Id}}' proxy)
  network=$("${docker_host[@]}" inspect --format '{{with index .NetworkSettings.Networks "proxy"}}{{.NetworkID}} {{.Gateway}} {{.IPAddress}}{{end}}' "$npm")
  read -r network_id bridge peer <<< "$network"
  [[ $network_id == "$proxy_id" && -n $bridge && -n $peer ]] || fail 'NPM sem IPv4/gateway em proxy.'
  ip -o -4 addr show scope global | awk '{print $4}' | cut -d/ -f1 | grep -Fxq "$bridge" ||
    fail 'O endereço gateway de proxy não pertence ao host.'
  [[ $(ip -4 route get "$peer" from "$bridge" | head -1) == *" dev br-"* ]] ||
    fail 'Rota do gateway ao peer NPM não usa uma bridge Docker.'
  data=$("${docker_host[@]}" inspect --format '{{range .Mounts}}{{if and (eq .Destination "/data") .RW}}{{.Source}}{{end}}{{end}}' "$npm")
  [[ -n $data && -d $data && $(realpath -e -- "$data") == "$data" ]] ||
    fail 'Mount persistente /data gravável não comprovado.'
  [[ $("${docker_host[@]}" inspect --format '{{range .Mounts}}{{if eq .Destination "/etc/letsencrypt"}}yes{{end}}{{end}}' "$npm") == yes ]] ||
    fail 'Mount /etc/letsencrypt não comprovado.'
  [[ -f $data/$site && ! -L $data/$site && $(realpath -e -- "$data/$site") == "$data/$site" ]] ||
    fail 'Falta uma configuração renderizada e segura do host 13 para clonar.'
  [[ -d $data/nginx/custom && $(realpath -e -- "$data/nginx/custom") == "$data/nginx/custom" &&
     ! -L $data/$hook && ( ! -e $data/$hook || -f $data/$hook ) && ! -L $data/$exclusive ]] ||
    fail 'Caminhos custom do NPM incompatíveis.'
  master_uid=$(live sh -c 'ps -eo uid,args | awk '"'"'$2=="nginx:" && $3=="master" {print $1}'"'"'')
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
  (cd "$receipt" && sha256sum installation release-sha certificates dev-authorizations original/* candidate/* \
    live-before.conf clone-candidate.conf clone.diff clone-probe.log > approved.sha256)
  printf '%s\n' "$receipt"
)

atomic_config() {
  local src=$1 dst=$2 temp
  temp=$(mktemp "${dst%/*}/.anticlone-dev.XXXXXX")
  cat -- "$src" > "$temp"
  if [[ -f $dst ]]; then
    chmod --reference="$dst" "$temp"
    chown --reference="$dst" "$temp"
  else
    chown "$master_uid" "$temp"
    chmod 600 "$temp"
  fi
  mv -fT -- "$temp" "$dst"
}

remove_installation() {
  local item
  for item in {http-limits,proxy-host,proxy-location}.conf tls/{npm.crt,npm.key,server-ca.crt}; do
    if [[ -f $data/$exclusive/$item ]]; then unlink "$data/$exclusive/$item"; fi
  done
  if [[ -d $data/$exclusive/tls ]]; then rmdir -- "$data/$exclusive/tls"; fi
  if [[ -d $data/$exclusive ]]; then rmdir -- "$data/$exclusive"; fi
}

detach_hook() {
  if [[ ! -f $data/$hook ]]; then return; fi
  if cmp -s "$data/$hook" "$receipt/candidate/http_top.conf"; then
    if [[ -f $receipt/original/http_top.conf ]]; then
      atomic_config "$receipt/original/http_top.conf" "$data/$hook"
    else
      unlink "$data/$hook"
    fi
  else
    local clean
    clean=$(mktemp "$receipt/.hook.XXXXXX")
    python3 "$here/render.py" detach "$data/$hook" > "$clean"
    chmod --reference="$data/$hook" "$clean"
    chown --reference="$data/$hook" "$clean"
    if ! cmp -s "$clean" "$data/$hook"; then atomic_config "$clean" "$data/$hook"; fi
    unlink "$clean"
  fi
}

restore_original() {
  if cmp -s "$data/$site" "$receipt/candidate/13.conf"; then
    atomic_config "$receipt/original/13.conf" "$data/$site"
  elif grep -Fq '/data/nginx/custom/anticlone-dev/' "$data/$site"; then
    fail 'O host 13 mudou durante o stage e ainda usa os includes. Restaure o host na UI.'
  fi
  detach_hook
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
  [[ ! -e $data/$exclusive ]] || fail 'Diretório AntiClone Dev já existe no NPM.'
  grep -q " commit=$release_sha$" "$receipt/operator-approval" ||
    fail 'O recibo ainda precisa do aceite do administrador para este SHA.'
  cmp -s <(certificates) "$receipt/certificates" || fail 'Os certificados Dev mudaram desde o clone.'
  [[ $(as_gateway authorizations) == "$(cat "$receipt/dev-authorizations")" ]] ||
    fail 'O total de autorizações Dev mudou desde a revisão.'
  live nginx -T > "$receipt/live-pre-stage.conf" 2> "$receipt/live-pre-stage.log"
  python3 "$here/render.py" baseline "$receipt/live-before.conf" "$receipt/live-pre-stage.conf"
  as_gateway smoke > "$receipt/dev-smoke.log"
  local rebound=no success=no
  trap 'if [[ $success == no ]]; then
    restore_original
    if [[ $rebound == yes ]]; then as_gateway bind 127.0.0.1 127.0.0.1; fi
  fi' EXIT
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
  rebound=yes
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
  success=yes
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
  as_dev systemctl --user enable anticlone-dev-public-gateway.service
  touch "$receipt/verified"
  printf 'Proxy Host 13 validado no NPM. Recibo: %s\n' "$receipt"
}

rollback() {
  [[ -f $receipt/staged ]] || fail 'Recibo sem configuração staged.'
  # Restore the original UI values before removing files still referenced by this host.
  if grep -Fq '/data/nginx/custom/anticlone-dev/' "$data/$site"; then
    fail 'Restaure primeiro os campos anteriores do host 13 na UI.'
  fi
  detach_hook
  remove_installation
  live nginx -t > "$receipt/rollback-test.log" 2>&1
  live nginx -T > "$receipt/rollback.conf" 2> "$receipt/rollback.log"
  as_dev systemctl --user disable anticlone-dev-public-gateway.service
  as_gateway bind 127.0.0.1 127.0.0.1
  unlink "$receipt/staged"
  if [[ -f $receipt/verified ]]; then unlink "$receipt/verified"; fi
  touch "$receipt/rolled-back"
}

preflight
case ${1:-} in
  clone) clone_gate ;;
  stage|verify|rollback)
    receipt=${2:-}
    [[ $receipt =~ ^/var/backups/anticlone-dev-npm\.[A-Za-z0-9]{6}$ && -d $receipt &&
       $(stat -c %u:%a "$receipt") == 0:700 && ! -L $receipt ]] || fail 'Recibo privado inválido.'
    if [[ $1 == rollback ]]; then
      cmp -s <(metadata | sed -n '1,3p') <(sed -n '1,3p' "$receipt/installation") ||
        fail 'NPM, imagem ou mount mudaram desde o clone.'
    else
      cmp -s <(metadata) "$receipt/installation" || fail 'NPM, imagem, mount ou rede mudaram desde o clone.'
    fi
    (cd "$receipt" && sha256sum --status -c approved.sha256) || fail 'O recibo ou a candidata foram alterados.'
    [[ $(cat "$receipt/release-sha") == "$release_sha" ]] || fail 'O recibo pertence a outro checkout.'
    "$1"
    ;;
  *) fail 'Uso: npm-gate.sh clone | {stage,verify,rollback} <recibo>.' ;;
esac
