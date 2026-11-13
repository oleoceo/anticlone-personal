# AntiClone Personal atrás do NPM existente

Preparação em repositório, base `4e7d5a82be21bdf6d35961c189a8e4308c71af3e`.
Este documento não autoriza executar operações na VPS, DNS, Cloudflare, NPM ou LPs.
O proprietário deverá autorizar a instalação e a homologação externa separadamente.
Não existe domínio administrativo: não publicar `protect.leoceo.online` nem outro host
para o painel. Não usar Cloudflare Access. O perfil HTTPS direto permanece em
`infra/https`; **nunca mesclar os dois arquivos Compose**.

## 1. Inventário somente leitura, antes da instalação autorizada

No servidor autorizado, verificar `docker ps`, `docker network ls`, `docker network inspect
<rede>` e `docker inspect <NPM>` (selecionar somente redes/mounts/imagem; não imprimir
ambiente/segredos). Conferir `ss -lnt` para 3001, a versão/imagem do NPM, seus mounts
persistentes e a rede bridge compartilhada realmente conectada ao NPM. Não presumir
nomes, certificados, DNS ou portas da documentação histórica. Não reiniciar serviços.
Se 3001 estiver ocupada, interromper: não matar processo nem deslocar outro projeto.
Inspecionar a configuração Nginx efetiva para detectar real-IP global preexistente:
confiar em toda a rede Docker ou `0.0.0.0/0` invalida esta cadeia.

Layout proposto, sem sobrepor dados existentes:

```text
/opt/apps/apps/personal/anticlone-personal/
  releases/<git-sha>/             checkout verificado
  private/compose.env            0600, fora do Git
  private/gateway.env            0600
  private/admin.env              0600
  private/worker.env             0600
  private/database-password      0600
  private/gateway-tls/            server.crt, server.key, client-ca.crt
  private/monitor-tls/            monitor.crt, monitor.key, server-ca.crt
  backups/                       acesso restrito; cópia offsite definida pelo dono
```

Usar projeto Compose `anticlone-personal` somente após verificar ausência de conflito.
Exigir Docker Compose v2.30+ (`env_file.format: raw` preserva `$` no hash scrypt e
outros segredos sem interpolação); não retirar esse atributo para contornar versão.
Não há `container_name`. A rede externa `${NPM_PROXY_NETWORK}` já deve existir;
nunca recriá-la. Redes privadas são `<projeto>_private` (internal) e
`<projeto>_worker_egress`. Só gateway participa da rede proxy, com alias exclusivo
`anticlone-personal-public`; verificar ausência desse alias em outros projetos.
Gateway TLS:3000; PostgreSQL:5432 somente private; worker sem listener; admin
**host networking, somente 127.0.0.1:3001**. Nenhum `ports:` e nenhum bind80/443.
O admin alcança o banco pelo volume de socket Unix, sem publicar TCP5432 no host.
Host networking do admin é intencional: preserva localAddress/remoteAddress/Host
estritos; admin não recebe tráfego de bridge por um relay e não aceita proxy headers.

## 2. Imagens, segredos e TLS interno

Construir a imagem existente com `docker build -f infra/https/Dockerfile -t
anticlone-personal:<git-sha> .` a partir do SHA aprovado. Registrar image ID e preferir
digest de registry privado se houver. PostgreSQL16 deve ser fixado por digest
verificado (`docker image inspect postgres:16`), sem atualizar major. Não reconstruir
a aplicação na VPS implicitamente; transportar a imagem verificada conforme processo
do proprietário. Não usar `latest`. Registrar SHA/imagens/volumes no recibo da instalação.

`compose.env` (caminhos absolutos, valores substituídos após inventário):

```dotenv
GATEWAY_IMAGE=anticlone-personal:<SHA_APROVADO>
POSTGRES_IMAGE=postgres:16@sha256:<DIGEST_VERIFICADO>
NPM_PROXY_NETWORK=<REDE_EXISTENTE>
GATEWAY_ENV_FILE=/opt/apps/apps/personal/anticlone-personal/private/gateway.env
ADMIN_ENV_FILE=/opt/apps/apps/personal/anticlone-personal/private/admin.env
WORKER_ENV_FILE=/opt/apps/apps/personal/anticlone-personal/private/worker.env
DATABASE_PASSWORD_FILE=/opt/apps/apps/personal/anticlone-personal/private/database-password
GATEWAY_TLS_DIRECTORY=/opt/apps/apps/personal/anticlone-personal/private/gateway-tls
MONITOR_TLS_DIRECTORY=/opt/apps/apps/personal/anticlone-personal/private/monitor-tls
```

Não colocar segredos em argumentos de shell, logs, PR ou imagem. `gateway.env`:
`DATABASE_URL=postgres://anticlone:<senha-percent-encoded>@postgres:5432/anticlone`,
`SMTP_PORT=1` (contrato existente, sem provedor habilitado), `PUBLIC_GATEWAY_HOST=<host-neutro>`,
`RUNTIME_PUBLIC_ORIGIN=https://<host-neutro>` e os dois pins abaixo. Preservar demais
chaves privadas necessárias ao contrato existente, inclusive criptografia comercial;
não montar env administrativo ou SMTP no gateway. `GATEWAY_MODE=OPERATIONAL` é fixado
no Compose e **não autoriza projetos/LPs**. Banco novo começa sem autorizações;
banco restaurado pode conter autorizações: revisar/suspender pelo fluxo autenticado
existente antes de permitir tráfego. Nunca editar tabelas de autorização manualmente.

`admin.env`: preservar `ADMIN_PASSWORD_RECORD`, `ADMIN_TOTP_SECRET` e demais chaves
privadas existentes; `DATABASE_URL=postgres://anticlone:<senha-percent-encoded>@localhost/anticlone?host=/run/anticlone-db`.
O socket exige SCRAM no banco novo (`POSTGRES_INITDB_ARGS`), não confiança local.
Volumes antigos não reaplicam initdb: verificar `pg_hba.conf` e SCRAM em procedimento
autorizado antes de reutilizar. Não reutilizar volume de outra aplicação ou do perfil
HTTPS sem migração/backup deliberados.

TLS interno usa uma CA de servidor e uma CA de clientes privadas. Emitir fora do
servidor, com chaves únicas e validade limitada: servidor com SAN DNS exatamente
`PUBLIC_GATEWAY_HOST`, EKU `serverAuth`; clientes separados NPM e monitor com EKU
`clientAuth`. Exemplo de emissão offline, em diretório privado novo:

```sh
umask 077
# Repetir para server-ca e client-ca; manter suas chaves offline, fora dos mounts.
openssl req -x509 -newkey rsa:3072 -nodes -keyout server-ca.key -out server-ca.crt -days 365 -subj /CN=AntiClone-server-CA
openssl req -x509 -newkey rsa:3072 -nodes -keyout client-ca.key -out client-ca.crt -days 365 -subj /CN=AntiClone-client-CA
openssl req -new -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj /CN=HOST_NEUTRO
printf 'subjectAltName=DNS:HOST_NEUTRO\nextendedKeyUsage=serverAuth\n' > server.ext
openssl x509 -req -in server.csr -CA server-ca.crt -CAkey server-ca.key -CAcreateserial -out server.crt -days 90 -extfile server.ext
printf 'extendedKeyUsage=clientAuth\n' > client.ext
for client in npm monitor; do
  openssl req -new -newkey rsa:2048 -nodes -keyout "$client.key" -out "$client.csr" -subj "/CN=AntiClone-$client"
  openssl x509 -req -in "$client.csr" -CA client-ca.crt -CAkey client-ca.key -CAcreateserial -out "$client.crt" -days 90 -extfile client.ext
  openssl x509 -in "$client.crt" -noout -fingerprint -sha256
done
```

Substituir HOST_NEUTRO antes de emitir. `NPM_PROXY_FINGERPRINT` e
`NPM_MONITOR_FINGERPRINT` em gateway.env são SHA256 em maiúsculas com dois-pontos,
distintos. Somente certificados autorizados pela CA **e** com pin exato passam.
Montar apenas server.key/server.crt/client-ca.crt no gateway (UID1000, chave0400,
diretório0500). Monitor recebe somente sua chave/certificado e server-ca.crt
(UID1000,0400). NPM recebe somente npm.key/npm.crt/server-ca.crt no caminho privado
`/run/anticlone/`, legível pelo master Nginx, sem CA privada. Não compartilhar chaves
entre NPM e worker. Rotação requer atualizar arquivos/pins e reiniciar somente os
processos AntiClone necessários, com janela de perda observacional; nunca retirar
verificação TLS para contornar expiração. Proteger acesso Docker equivale a root.

## 3. Inicialização e validação privada

Os comandos seguintes são para instalação futura autorizada, a partir do release:

```sh
docker compose --env-file /opt/apps/apps/personal/anticlone-personal/private/compose.env -f infra/npm/compose.yaml config --quiet
docker compose --env-file /opt/apps/apps/personal/anticlone-personal/private/compose.env -f infra/npm/compose.yaml up -d postgres gateway admin
```

Em volume **novo**, o entrypoint PostgreSQL aplica todos os SQL existentes ordenados
001–064 em `infra/`; não inventar SQL034 ausente nem rodar novamente sobre volume
inicializado. Confirmar logs de init sem erros e tabela `commerce_connection_versions`
de064. Falha parcial: parar apenas este projeto, preservar volume e diagnosticar;
não repetir SQL às cegas. Não há mudança nas migrations históricas.

No computador do administrador, usar a mesma porta local/remota:

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:3001:127.0.0.1:3001 USUARIO@VPS
# Abrir http://127.0.0.1:3001/admin/ui/
```

Não usar localhost, domínio, outra porta local, bind0.0.0.0 ou encaminhamento remoto.
Se3001 local estiver ocupada, liberar o processo local deliberadamente antes do túnel.
Senha+TOTP, replay persistido, sessão de15min, cookies HttpOnly/SameSite Strict,
CSRF, origem exata e logout permanecem. HTTP é somente loopback dentro do canal SSH
criptografado; não adicionar Secure ao cookie sem listener HTTPS privado.
Confirmar login real, logout e rejeição de Origin/Host/proxy headers adulterados.
`ss -lnt` deve mostrar3001 somente127.0.0.1; container em bridge não deve alcançar
essa porta pelo gateway do host. Não criar Proxy Host para administração.

## 4. Proxy Host público no NPM (mudança futura autorizada)

Selecionar somente o host neutro, HTTPS upstream `anticlone-personal-public:3000`,
certificado público válido no NPM e Force SSL. Não adicionar domínio administrativo,
WebSocket ou cache automático. A aba Advanced deste **único** Proxy Host deve conter:

```nginx
if ($host != "HOST_NEUTRO") { return 421; }
if ($http_host != "HOST_NEUTRO") { return 421; }
if ($scheme != https) { return 400; }
client_max_body_size 2k;
client_body_timeout 5s;
client_header_timeout 5s;
keepalive_timeout 10s;
send_timeout 5s;
# Incluir aqui o conteúdo renderizado de infra/npm/proxy-location.conf.
```

Substituir **todas** as ocorrências `PUBLIC_GATEWAY_HOST` na cópia privada do fragmento
pelo host verificado, inclusive Host e SNI. O fragmento contém somente as rotas
públicas existentes e mTLS com validação do servidor. A localização `/` gerada pelo
NPM não recebe certificado de cliente: caminhos fora da allowlist falham fechados
(normalmente502); gateway público não implementa admin. Não colocar o certificado
de cliente em escopo global/server: mantê-lo apenas na localização do fragmento.
NPM deve suportar os módulos/diretivas usados; confirmar `nginx -t` e configuração
efetiva antes de habilitar esse host, sem editar globalmente outros hosts.
O ensaio usa Nginx real com o mesmo fragmento; a UI/versão NPM instalada ainda
precisa de homologação externa. Se o NPM não aceitar a configuração, parar essa
instalação, não retirar mTLS nem publicar HTTP interno sem autenticação.

Limites globais1200/min e120/min por IP validado no gateway são por processo e
limitam o mapa a1200 entradas/min. Reutilizar os limites de conexão/taxa do perfil
direto **somente neste host**, se suportados pela instalação: zonas Nginx exigem
contexto http e nomes exclusivos. Não editar um arquivo global NPM que afete todos
os hosts sem autorização específica. Gateway mantém limites de corpo, headers,
timeouts e admissões existentes; TLS não substitui defesa volumétrica upstream.

## 5. Cadeia Cloudflare → NPM → gateway

Preferência inicial: Cloudflare Proxied, SSL/TLS **Full (strict)**, certificado
compatível no NPM, HTTPS público. No server deste host, `real_ip_header
CF-Connecting-IP; real_ip_recursive off;` e `set_real_ip_from <CIDR>` **somente**
para as faixas oficiais atuais de Cloudflare, verificadas pelo proprietário em
https://www.cloudflare.com/ips/ (IPv4 e IPv6). Não confiar em rede Docker, XFF,
0.0.0.0/0 ou IP fixo de container. Conferir se a versão NPM já inclui faixas oficiais
e se a origem TCP ainda é Cloudflare; real-IP global conflitante bloqueia o aceite.
Atualizar a lista por processo revisado; nunca executar um script remoto às cegas.

O fragmento sobrescreve XFF com `$remote_addr`, Host e proto com valores aprovados,
remove Forwarded/X-Forwarded-Host/X-Real-IP/CF-Connecting-IP. Gateway aceita somente
um IP literal, Host exato e `https`, após TLS+pin do NPM. Outros containers não têm
o certificado; estar na mesma bridge não concede autoridade. IP serve só ao
orçamento de requisições em memória, nunca identifica operador de clonagem.
Se real-IP não estiver disponível, o orçamento agrega no IP do edge/NPM; não
usar headers arbitrários para recuperar granularidade. IP ausente/inválido no
gateway resulta400. Evitar Workers/Transforms que alterem esses headers; validar
IPv6/Pseudo IPv4 no ambiente real. Não inferir IP de pessoa a partir de proxies.

DNS only é compatível usando certificado publicamente confiável no NPM: não confiar
em CF-Connecting-IP vindo de clientes diretos; usar endereço TCP real. O teste
simula edge confiável e cliente direto com claim Cloudflare falsa. Não certifica
Cloudflare real, WAF, DNS ou as faixas vigentes na VPS. Proteger origem contra bypass
do edge é decisão futura do proprietário: não alterar firewall compartilhado aqui.

Cache por hostname/rota, sem regra global na conta:

| Rotas | Política inicial |
|---|---|
| observe, observe/fallback, observed-session/action, entry-decision, cta-refresh e aliases e/f/g/h/j/k | Bypass Cache; respeitar no-store; sem transformação de corpo |
| canary/*.gif, html.gif/css.gif, aliases m.gif/n.gif | Bypass Cache, mesmo para GET/imagem; chegada precisa atingir gateway |
| commerce-webhook/:uuid e checkout-webhook | Bypass Cache; POST/HMAC intactos; sem desafio interativo |
| runtime/core/fallback/cta-inventory e aliases a.js/b.js/c.js/p.js | Inicialmente Bypass, preservando Cache-Control atual; alias estável pode rotacionar conteúdo, não é imutável |
| healthz | Bypass; não prova disponibilidade da LP nem entrega de email |

Somente assets com URL de revisão **imutável comprovada** poderão receber TTL curto
controlado em mudança posterior, com purge/rollback e prova de atualização. Não
configurar Cache Everything para o domínio. Desabilitar otimização que reescreva ou
atrase scripts **apenas nesse host**, se interferir no ensaio. Manter WAF global;
se logs mostrarem falso positivo, exceção mínima por host+rota+método+regra afetada,
com revisão, sobretudo webhooks autenticados. Não desabilitar WAF da conta.

Bloqueio/desafio/cache equivocado impede observação/decisão; não significa ausência
de cópia. Gateway não vê bloqueios anteriores. Falha/atraso de CF/NPM/TLS/gateway:
runtime mantém navegação nativa e PAGE_REDIRECT fail-open em150ms, sem redirect tardio.
REPLACE_CONVERSION com política já entregue mantém seu contrato D09. Não aumentar
o prazo para compensar a infraestrutura. Medir no navegador controlado o intervalo
bootstrap→resposta parseada, p50/p95/p99 e proporção antes/depois de150ms, desktop e
mobile, cache frio/quente; medir também script/Core e CF-Ray/timing sem registrar
dados pessoais. Comparar Proxied/DNS only e simular indisponibilidade autorizada.
Nenhuma latência pública é prometida por este PR.

## 6. Monitor e notificações

`worker.env`: DATABASE_URL privado via postgres, PUBLIC_GATEWAY_HOST, SMTP_PROVIDER,
SMTP_HOST/PORT/TLS/SENDER/RECIPIENT/USER/PASSWORD conforme contratos existentes
`CLONE-SMTP.md` e `PRE-VPS-FRONT2.md`. Sem credencial SMTP, manter perfil notifications
**desligado**; não usar um host/conta real nesta tarefa. Após configuração autorizada,
ativar `--profile notifications up -d notifications`. O worker usa `gateway:3000`
com TLS/SNI/CA e certificado monitor exclusivo; só GET /healthz é permitido pelo pin.
Não confundir127.0.0.1 do worker com gateway. Rede worker_egress permite SMTP/DNS;
não participa da rede NPM. Falha real abre episódio, recuperação fecha; retries,
outbox, histórico e desconhecimento de entrega final permanecem. Esse monitor
certifica backend privado, não a cadeia externa Cloudflare/NPM. Sem SMTP ativo,
monitor/notificações não estão operando: registrar essa limitação explicitamente.

## 7. Aceite, backup, rollback e suspensão

Antes de liberar tráfego: verificar redes via inspect, nenhum publish5432/3000/3001,
nenhum listener público3001, login SSH/MFA/CSRF/logout, health/scripts/Core/Fallback,
canários/telemetria e aliases publicados, limites/body, rejeição de mTLS sem cert,
Host/proto/forwarding falsos. Gateway não pode servir admin. Rever autorizações
operacionais: iniciar em observação, sem nova autorização de mitigação/LP real.
Testar de fora somente após autorização, pelo proprietário, sem alegar homologação
a partir das simulações. Conferir NPM e Cloudflare em ambos os modos e150ms real.

Backup lógico com ferramentas PostgreSQL16, via `docker compose ... exec -T postgres`
e `pg_dump -Fc`, usando arquivo privado de credencial/PGPASSFILE (não argumento).
Guardar dump, SHA256, SHA/imagem, arquivos privados criptografados e recibo do restore
em banco vazio separado conforme `POSTGRES-RECOVERY.md`. Não copiar volume ativo como
substituto de dump consistente. Recuperação deve conservar replay TOTP e chaves.
Não publicar5432 para executar backup. Evitar logs com env/DSN/códigos TOTP.

Rollback: suspender host AntiClone e parar somente gateway/notifications/admin deste
projeto; preservar data/db_socket e backup; restaurar referência à imagem SHA anterior
testada e seus arquivos privados, validar compatibilidade001–064 e acesso SSH antes
de reabrir tráfego. Não reverter migrations históricas/destrutivamente. Se precisar
restaurar dados, usar banco/volume **novo** e procedimento de restore autorizado;
guardar volume original. Não executar `down -v`, prune, rm global ou restart do NPM.

Suspender somente AntiClone: `docker compose --env-file <compose.env> -f
infra/npm/compose.yaml stop gateway notifications admin` (incluir postgres se o dono
desejar parada total). Não tocar rede externa, containers de outros projetos ou
NPM. Desabilitar apenas o Proxy Host AntiClone requer autorização operacional.

## 8. Provas e riscos residuais

`npm-boundary`: TLS real, pins, papel health-only, headers, budgets. `npm-topology`:
Compose real descartável, SQL001–064, socket SCRAM, SSH direto-tcpip, UI MFA/CSRF/cookie/
logout, isolamento e monitor em container separado com falha/recuperação. `https-gateway`:
perfil direto original e variante mTLS com fragmento Nginx real, edge CF simulado,
DNS only, distribuição, scripts, corpos, taxa, indisponibilidade/navegação nativa.
Suíte integral mantém testes PAGE_REDIRECT pontual/tardio150ms e demais contratos.
Logs/CI por SHA no PR; não considerar testes pendentes como aprovados.

Limites: NPM real/Cloudflare/VPS não acessados; faixas/certificados/DNS/WAF existentes
desconhecidos. Admin host network conserva fronteira loopback mas compartilha namespace
do host: root/Docker e processos locais são parte confiável da operação. mTLS não
impede DoS de handshake por container hostil ou comprometimento do NPM. Budgets são
por processo; sem promessa de DoS distribuído. Egress SMTP não é allowlist de rede
do host. Certificados expiram e pins exigem rotação coordenada. Sem mudanças de
proteção comercial, migrations ou homologação externa.

Fontes primárias consultadas para a preparação: [NPM advanced config](https://nginxproxymanager.com/advanced-config/),
[Cloudflare headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/),
[Full strict](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/).

## 9. Evidências da preparação no repositório

- Base obrigatória4e7d5a8; código c9d4ddf e correção de harness b1c57b2.
- Integral local PostgreSQL16/Node22/Chromium:132 PASS/1 FAIL, sem skips; única falha
  no fanout da fixture Nginx, que descartava429 e virava timeout. Revisão independente
  reproduziu7 respostas429 numa fixture sem portas; fases agora isolam somente esse
  proxy descartável e conferem URLs/status exatos, sem alterar limites ou150ms.
- Foco após correção: `node --test --test-concurrency=1 dist/tests/npm-boundary.test.js
  dist/tests/npm-topology.test.js dist/tests/https-gateway.test.js`:5/5 PASS,0 skips.
  Inclui PAGE_REDIRECT real autorizado só para a cópia sintética, entrega em100ms e
  tardia em151ms de relógio Chromium controlado, com fetch real NPM/mTLS/PostgreSQL.
- `front3-upgrade` e `recovery` com clientes16 em Docker:2/2 PASS,0 skips. A primeira CI
  usou clientes18.6 do runner atualizado e falhou no comando transaction_timeout
  contra servidor16; `scripts/ci-postgres-tool.sh` fixa as ferramentas16 só na CI.
  A imagem do servidor, código de recuperação e migrations não mudaram.
- Lint/typecheck/build, validação documental e Python passaram no laboratório.
  Logs locais ficam fora do Git, em test-results e no laboratório temporário;
  [PR78](https://github.com/oleoceo/anticlone-personal/pull/78) reúne resultados e CI
  oficial do SHA final. Exigir o check integral verde desse SHA antes de marcar pronto.
- Revisão independente read-only `/root/npm_review`: favorável ao código e deltas,
  sem P0/P1/P2 pendente. SHA256: transporte54805D3D, boundary903D275A, ComposeE373DC0C,
  fragmento758B4AE4, topologiaB989AB2C, HTTPS29D44E7E, wrapper87BC5FD1.
  O revisor executou mTLS1/1 PASS e reproduziu o limite Nginx; demais provas acima
  foram executadas pelo implementador. Revisão documental final identificada no PR.
