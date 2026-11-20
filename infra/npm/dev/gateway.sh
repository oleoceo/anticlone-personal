#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

base=/opt/apps/apps/personal/anticlone-dev
release=$base/dev-gateway-release
private=$base/private/dev-public-gateway
node=$base/bin/node
unit=anticlone-dev-public-gateway.service
unit_dir=/home/anticlone-dev/.config/systemd/user
host=protect.leoceo.online
port=13003
[[ $(id -un) == anticlone-dev ]] ||
  { printf '%s\n' 'Execute como anticlone-dev.' >&2; exit 1; }
fail() { printf '%s\n' "$*" >&2; exit 1; }

fingerprint() {
  openssl x509 -in "$1" -noout -fingerprint -sha256 | cut -d= -f2
}

admin_env() {
  local pid
  pid=$(systemctl --user show -p MainPID --value anticlone-dev-admin.service)
  [[ $pid =~ ^[1-9][0-9]*$ ]] || fail 'Admin Dev inativo.'
  "$node" --input-type=module - "$pid" "$1" <<'JS'
import {readFileSync} from 'node:fs';
import {Pool} from 'pg';
const [pid, action] = process.argv.slice(2);
try {
  const entries = readFileSync('/proc/' + pid + '/environ', 'utf8').split('\0');
  const value = key => entries.find(entry => entry.startsWith(key + '='))?.slice(key.length + 1);
  const database = value('DATABASE_URL');
  const url = new URL(database);
  const commerce = value('COMMERCE_ENCRYPTION_KEY');
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' ||
      url.port !== '55432' || !/^\/[\w-]+$/.test(url.pathname) || url.search || url.hash ||
      !/^[!-~]+$/.test(database) || /["'\\#]/.test(database) || !/^[a-f0-9]{64}$/.test(commerce)) {
    throw Error('unexpected Dev environment');
  }
  if (action === 'credentials') {
    process.stdout.write(`DATABASE_URL=${database}\nCOMMERCE_ENCRYPTION_KEY=${commerce}\n`);
  } else {
    const pool = new Pool({connectionString: database, connectionTimeoutMillis: 2000, statement_timeout: 3000});
    try {
      const {rows: [row]} = await pool.query('SELECT count(*)::integer AS enabled FROM page_operational_authorizations WHERE enabled');
      process.stdout.write(String(row.enabled) + '\n');
    } finally { await pool.end(); }
  }
} catch {
  process.stderr.write('Falha ao validar o banco ou o ambiente efetivo do admin Dev.\n');
  process.exitCode = 1;
}
JS
}

validate_listener() {
  "$node" --input-type=module - "$1" "$2" <<'JS'
import {npmListenAddress} from './dist/apps/npm-transport.js';
const [address, peer] = process.argv.slice(2);
npmListenAddress({NPM_LISTEN_ADDRESS: address, NPM_PROXY_PEER_ADDRESS: peer});
JS
}

write_listener() {
  local address=$1 peer=$2
  validate_listener "$address" "$peer"
  local staged
  staged=$(mktemp "$private/.env.XXXXXX")
  if ! {
    admin_env credentials &&
    cat <<CONFIG
PORT=$port
SMTP_PORT=1
GATEWAY_MODE=OPERATIONAL
GATEWAY_TRANSPORT=NPM_MTLS
GATEWAY_BACKGROUND_MAINTENANCE=off
PUBLIC_GATEWAY_HOST=$host
RUNTIME_PUBLIC_ORIGIN=https://$host
NPM_LISTEN_ADDRESS=$address
NPM_PROXY_PEER_ADDRESS=$peer
NPM_TLS_KEY_FILE=$private/server/server.key
NPM_TLS_CERT_FILE=$private/server/server.crt
NPM_CLIENT_CA_FILE=$private/server/client-ca.crt
NPM_PROXY_FINGERPRINT=$(fingerprint "$private/npm/npm.crt")
NPM_MONITOR_FINGERPRINT=$(fingerprint "$private/monitor/monitor.crt")
CONFIG
  } > "$staged"; then
    rm -f -- "$staged"
    fail 'Falha ao gerar o ambiente do gateway.'
  fi
  mv -fT "$staged" "$private/gateway.env"
}

issue_certificates() (
  local_ca=$(mktemp -d "$private/.ca.XXXXXX")
  trap 'rm -rf -- "$local_ca"' EXIT
  for ca in server client; do
    openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 365 \
      -subj "/CN=AntiClone Dev $ca CA" -addext 'basicConstraints=critical,CA:true,pathlen:0' \
      -addext 'keyUsage=critical,keyCertSign,cRLSign' \
      -keyout "$local_ca/$ca.key" -out "$local_ca/$ca.crt"
  done
  for label in server npm monitor unpinned; do
    ca=client
    printf 'basicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n' > "$local_ca/leaf.ext"
    if [[ $label == server ]]; then
      ca=server
      printf 'basicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:%s\n' "$host" > "$local_ca/leaf.ext"
    fi
    openssl req -new -newkey rsa:2048 -nodes -subj "/CN=AntiClone Dev $label" \
      -keyout "$private/$label/$label.key" -out "$local_ca/leaf.csr"
    openssl x509 -req -in "$local_ca/leaf.csr" -CA "$local_ca/$ca.crt" -CAkey "$local_ca/$ca.key" \
      -CAcreateserial -out "$private/$label/$label.crt" -days 90 -sha256 -extfile "$local_ca/leaf.ext"
  done
  install -m 400 "$local_ca/client.crt" "$private/server/client-ca.crt"
  for label in npm monitor; do
    install -m 400 "$local_ca/server.crt" "$private/$label/server-ca.crt"
  done
  chmod 400 "$private"/{server,npm,monitor,unpinned}/*.{key,crt}
)

probe() {
  local address=$1 label=$2 path=$3 header=${4:-$host} sni=${5:-$host}
  local -a identity=()
  [[ $label == none ]] || identity=(--cert "$private/$label/$label.crt" --key "$private/$label/$label.key")
  curl --noproxy '*' --silent --max-time 4 --http1.1 --cacert "$private/monitor/server-ca.crt" \
    --resolve "$sni:$port:$address" "${identity[@]}" \
    -H "Host: $header" -H 'X-Forwarded-Proto: https' -H 'X-Forwarded-For: 127.0.0.1' \
    --output /dev/null --write-out '%{http_code}' "https://$sni:$port$path"
}

ready() {
  local address=$1 attempt
  for ((attempt=0; attempt<40; attempt++)); do
    if [[ $(probe "$address" monitor /healthz) == 200 ]]; then return; fi
    sleep .25
  done
  fail 'Gateway Dev não respondeu ao monitor mTLS.'
}

bind_listener() {
  local address=$1 peer=$2 staged
  validate_listener "$address" "$peer"
  [[ $address == 127.0.0.1 ]] ||
    ip -o -4 addr show scope global | awk '{print $4}' | cut -d/ -f1 | grep -Fxq -- "$address"
  [[ $(grep -c '^NPM_LISTEN_ADDRESS=' "$private/gateway.env") == 1 &&
     $(grep -c '^NPM_PROXY_PEER_ADDRESS=' "$private/gateway.env") == 1 ]] ||
    fail 'Configuração do listener Dev ausente ou duplicada.'
  if grep -Fxq "NPM_LISTEN_ADDRESS=$address" "$private/gateway.env" &&
     grep -Fxq "NPM_PROXY_PEER_ADDRESS=$peer" "$private/gateway.env" &&
     [[ $(ss -H -ltn "sport = :$port" | awk '{print $4}') == "$address:$port" ]] &&
     [[ $(probe "$address" monitor /healthz) == 200 ]]; then
    return
  fi

  # Change only the listener, preserving credentials and certificate pins.
  staged=$(mktemp "$private/.env.XXXXXX")
  sed -e "s/^NPM_LISTEN_ADDRESS=.*/NPM_LISTEN_ADDRESS=$address/" \
    -e "s/^NPM_PROXY_PEER_ADDRESS=.*/NPM_PROXY_PEER_ADDRESS=$peer/" "$private/gateway.env" > "$staged"
  mv -fT "$staged" "$private/gateway.env"
  systemctl --user restart "$unit"
  ready "$address"
  [[ $(ss -H -ltn "sport = :$port" | awk '{print $4}') == "$address:$port" ]] ||
    fail 'O listener Dev não está limitado ao endereço solicitado.'
}

smoke() {
  local private_health result label path
  ready 127.0.0.1
  result=$(curl --noproxy '*' -fsS --max-time 4 --cacert "$private/monitor/server-ca.crt" \
    --resolve "$host:$port:127.0.0.1" --cert "$private/monitor/monitor.crt" --key "$private/monitor/monitor.key" \
    -H "Host: $host" -H 'X-Forwarded-Proto: https' -H 'X-Forwarded-For: 127.0.0.1' "https://$host:$port/healthz")
  [[ $result == '{"status":"ready","mode":"OPERATIONAL","action":"SCOPED_AUTHORIZATION_REQUIRED"}' ]]
  printf '%s\n' "$result"
  for label in none server; do
    if result=$(probe 127.0.0.1 "$label" /healthz) || [[ $result != 000 ]]; then
      fail 'TLS aceitou uma identidade de cliente inválida.'
    fi
    printf 'TLS %s recusado\n' "$label"
  done
  [[ $(probe 127.0.0.1 unpinned /healthz) == 403 ]]
  [[ $(probe 127.0.0.1 npm /healthz unexpected.test) == 400 ]]
  [[ $(probe 127.0.0.1 monitor /runtime.js) == 403 ]]
  for path in /admin /admin/ui/ /admin/api/projects /login; do
    [[ $(probe 127.0.0.1 npm "$path") == 404 ]]
  done
  [[ $(ss -H -ltn "sport = :$port" | awk '{print $4}') == "127.0.0.1:$port" ]]
  private_health=$(curl --noproxy '*' -fsS --max-time 4 http://127.0.0.1:13002/healthz)
  [[ $private_health == *'"mode":"PILOT_OBSERVE"'* ]]
  systemctl --user is-active --quiet anticlone-dev-admin.service
  printf 'Pins, Host, papel monitor, rotas administrativas e listeners conferidos. Autorizações Dev habilitadas: %s\n' "$(admin_env count)"
}

cd "$release"
case ${1:-} in
  prepare)
    [[ -f dist/apps/server.js && -d node_modules ]] || fail 'Compile o checkout antes da preparação.'
    [[ -z $(ss -H -ltn "sport = :$port") ]] || fail "Porta $port ocupada."
    [[ ! -e $private && ! -e $unit_dir/$unit ]] || fail 'Preparação já existe. Use smoke ou revise os arquivos privados.'
    authorization_count=$(admin_env count)
    install -d -m 700 "$private"/{server,npm,monitor,unpinned} "$unit_dir"
    issue_certificates >"$private/issuance.log" 2>&1 || fail 'Falha de emissão. Consulte issuance.log no diretório privado.'
    rm -- "$private/issuance.log"
    write_listener 127.0.0.1 127.0.0.1
    install -m 644 infra/npm/dev/anticlone-dev-public-gateway.service "$unit_dir/$unit"
    systemctl --user daemon-reload
    systemctl --user start "$unit"
    printf 'Autorizações Dev habilitadas antes do start: %s\n' "$authorization_count"
    smoke
    ;;
  smoke) smoke ;;
  authorizations) admin_env count ;;
  bind)
    [[ $# == 3 ]] || fail 'Uso: gateway.sh bind <endereço> <peer NPM>.'
    bind_listener "$2" "$3"
    ;;
  *) fail 'Uso: gateway.sh prepare | smoke | authorizations | bind <endereço> <peer NPM>.' ;;
esac
