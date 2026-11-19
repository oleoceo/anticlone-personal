# Gateway público de teste do AntiClone Dev

O serviço de usuário `anticlone-dev-public-gateway.service` usa o mesmo
PostgreSQL em `127.0.0.1:55432` que o admin Dev usa. A preparação lê somente
`DATABASE_URL` e `COMMERCE_ENCRYPTION_KEY` do processo autenticado do admin. A
conexão de preparação consulta apenas a contagem de autorizações habilitadas.
A instância adicional atende requisições e deixa os trabalhos periódicos no
gateway privado da porta 13002.

O listener inicial fica em `127.0.0.1:13003`. Após o ensaio do NPM, o procedimento
passa o bind para o IPv4 privado da bridge `proxy` e configura o IPv4 atual do
container NPM como único peer autorizado a usar a credencial de proxy. O endereço
local da bridge aceita o certificado de monitor, limitado a `GET /healthz`.
O gateway confere SNI e Host exatos, CA dos clientes e pins SHA-256 distintos.
O NPM autentica o SAN do servidor e a CA privada de servidor. O bind em bridge
filtra o peer no serviço e autentica o TLS. A porta continua sujeita ao roteamento
do host, inclusive tentativas de conexão de outros containers.

A emissão Dev usa duas CAs efêmeras, SAN fixo e folhas de 90 dias. As chaves
das CAs são descartadas após a assinatura. As chaves de folha ficam em
diretórios privados separados por uso, sob o usuário Dev até a integração.
Os processos do mesmo UID Dev compartilham essa fronteira de confiança.
No NPM, somente `npm.crt`, `npm.key` e `server-ca.crt` entram no mount
persistente verificado, legíveis pelo master Nginx. Após mudança de IP do NPM ou
expiração, repita a prova com o destino e certificados atuais. A integração
falha fechada quando o peer ou o pin diverge.

As autorizações existentes ficam no banco Dev. A instância exige a configuração
operacional por LP já definida pelo produto. Se houver autorizações habilitadas
no recibo, confira no admin os projetos, páginas, revisões e contextos de cópia
que o proprietário efetivamente aprovou para esse hostname antes de publicar.
Aguarde até o fim do ensaio para salvar alterações nesses registros. Instalação
de snippets e autorização de mitigação são ações explícitas no painel.
O admin Dev atualmente gera snippets para outra origem. Os URLs de aliases já
publicados são persistidos por revisão. Os testes controlados usam `owner.test`
e `copy.test` em PostgreSQL descartável com dados sintéticos.

## Procedimento para o administrador leoceo

Execute o bloco na VPS como `leoceo` com o sudo existente, a partir de um
terminal interativo. Use uma janela em que ninguém esteja editando a configuração
do NPM. Salve os valores anteriores de Scheme, Forward Host, Forward Port e
Advanced do Proxy Host 13 em local privado. O clone precisa de uma configuração
renderizada existente para o host 13, certificado público configurado, Force SSL
e a localização padrão. Se o host já estiver desabilitado e o arquivo renderizado
não existir, use um snapshot privado do host para preparar e validar a candidata
em um clone da versão instalada. Mantenha o host desabilitado durante essa etapa.

O script confirma o mount real de `/data` e o hook HTTP. Ele copia a configuração
efetiva e a árvore de certificados para uma área temporária privada, executa
somente o Nginx da imagem do NPM com rede `none` e compara os dumps completos.
No clone, somente o endereço upstream é substituído por loopback e um vhost
sintético é acrescentado para o teste. Os dois limites usam o peer TCP original
do Nginx, mesmo quando real-IP global reescreve `$remote_addr`. Se a origem estiver
atrás de CDN, clientes podem dividir o orçamento de um IP do edge.
[Endereço original no módulo real-IP](https://nginx.org/en/docs/http/ngx_http_realip_module.html#var_realip_remote_addr)

A prova inclui
corpo de 2 KiB, 2 req/s com burst 20, 10 requisições simultâneas, `429` antes
do upstream, recuperação e vhost de controle. O procedimento usa os hooks HTTP
e Advanced da versão instalada. [Hooks oficiais do NPM](https://nginxproxymanager.com/advanced-config/#custom-nginx-configurations)

Se o clone falhar por módulo, hook, mount ou resolução estática preexistente,
consulte o log apontado no recibo. Use somente no clone a montagem ou o fixture
que faltar para reproduzir a configuração efetiva. O gate exige o diff completo e
a prova de tráfego. Diante de um erro após o stage, use a opção de rollback,
restaure primeiro somente o host 13 pela UI e confira o resultado do script.

```bash
(
  set -Eeuo pipefail
  set +x
  release=/opt/apps/apps/personal/anticlone-dev/dev-gateway-release
  tools_dir=/var/lib/anticlone-dev-npm-tools

  sudo -v
  read -r -p 'Operação (integrar ou rollback): ' action
  if [[ $action == rollback ]]; then
    read -r -p 'Caminho do recibo exibido na integração: ' receipt
    [[ $receipt =~ ^/var/backups/anticlone-dev-npm\.[A-Za-z0-9]{6}$ ]]
    approved_sha=$(sudo cat "$receipt/release-sha")
    [[ $approved_sha =~ ^[0-9a-f]{40}$ ]]
    gate=$tools_dir/$approved_sha/infra/npm/dev/npm-gate.sh
    printf '%s\n' 'No NPM, restaure somente os valores originais do host 13 e salve.'
    read -r -p 'Digite RESTAURADO após salvar: ' confirmation
    [[ $confirmation == RESTAURADO ]]
    sudo bash "$gate" rollback "$receipt"
    printf '%s\n' 'Salve novamente o host 13 pela UI para efetivar a remoção das zonas na configuração carregada.'
    exit 0
  fi
  [[ $action == integrar ]]

  read -r -p 'SHA completo do commit AntiClone Dev revisado: ' approved_sha
  [[ $approved_sha =~ ^[0-9a-f]{40}$ ]]
  [[ $(sudo -u anticlone-dev git -C "$release" rev-parse HEAD) == "$approved_sha" ]]
  sudo -u anticlone-dev git -C "$release" diff --quiet "$approved_sha" --
  sudo install -d -o root -g root -m 0700 "$tools_dir"
  snapshot=$tools_dir/$approved_sha
  if ! sudo test -d "$snapshot"; then
    extracted=$(sudo mktemp -d "$tools_dir/.extract.XXXXXX")
    files=(infra/npm/{http-limits,proxy-host,proxy-location}.conf infra/npm/dev/{npm-gate.sh,render.py,clone-probe.cjs})
    sudo -u anticlone-dev git --no-replace-objects -C "$release" archive "$approved_sha" -- "${files[@]}" |
      sudo tar --extract --file=- --directory="$extracted" --no-same-owner --no-same-permissions
    for file in "${files[@]}"; do
      sudo test -f "$extracted/$file"
      sudo test ! -L "$extracted/$file"
    done
    sudo mv -T --no-clobber "$extracted" "$snapshot"
  fi
  gate=$snapshot/infra/npm/dev/npm-gate.sh
  receipt=$(sudo bash "$gate" clone)
  printf 'Recibo privado %s\n' "$receipt"
  sudo cat "$receipt/clone-probe.log"
  printf 'Autorizações Dev habilitadas: '
  sudo cat "$receipt/dev-authorizations"
  sudo less "$receipt/clone.diff"
  read -r -p 'Após revisar o diff, o TLS público e as autorizações, digite APROVADO: ' confirmation
  [[ $confirmation == APROVADO ]]
  printf 'leoceo %s commit=%s\n' "$(date -u +%FT%TZ)" "$approved_sha" |
    sudo tee "$receipt/operator-approval" >/dev/null

  sudo bash "$gate" stage "$receipt"
  printf '%s\n' \
    'Abra somente o Proxy Host 13 na UI.' \
    'Configure Scheme=https, Forward Host=IPv4 privado indicado acima e Forward Port=13003.' \
    'Acrescente os dois includes exibidos à aba Advanced, preservando o texto existente.' \
    'Preserve o certificado e o Force SSL. Salve o host somente após o stage bem-sucedido.'
  read -r -p 'Digite SALVO após salvar o host 13: ' confirmation
  [[ $confirmation == SALVO ]]
  sudo bash "$gate" verify "$receipt"
  health=$(curl --noproxy '*' --fail --show-error --silent --max-time 10 https://protect.leoceo.online/healthz)
  [[ $health == '{"status":"ready","mode":"OPERATIONAL","action":"SCOPED_AUTHORIZATION_REQUIRED"}' ]]
  printf '%s\n' "$health" | sudo tee "$receipt/public-health.json"
  printf 'Recibo final: %s\n' "$receipt"
)
```

O `stage` testa a conectividade mTLS da rede `proxy`, os arquivos em disco
com `nginx -t/-T` e a leitura pelo UID real do master. A mesma configuração
é persistida na UI do host 13 depois da conferência em disco. O `verify` compara
os arquivos gerados pela UI, sonda o HTTPS dentro do NPM e registra o recibo.
O `curl` final valida o certificado público pela cadeia do sistema e a saúde
pelo hostname. Guarde o recibo em `/var/backups`, pois contém configuração
privada do NPM. O rollback preserva outras linhas do hook HTTP, remove os
arquivos Dev e devolve a instância à porta 13003 em loopback.
