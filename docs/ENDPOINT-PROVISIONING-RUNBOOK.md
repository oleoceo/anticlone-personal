# Provisionamento de endpoints do AntiClone Dev

## Arquitetura e acesso

Cloudflare → Nginx Proxy Manager (NPM) existente → Gateway público Dev em
`https://172.20.0.1:13003` na bridge privada. O Admin é um serviço de usuário
`anticlone-dev-admin.service` e opera sobre o banco Dev. A pool controla a
publicação de revisões de instalação.

| Proxy Host | Nome externo |
|---|---|
| 13 | `protect.leoceo.online` |
| 15 | `web-frame.net` |
| 16 | `static-layer.com` |

O operador da VPS administra DNS, certificados e NPM. O usuário de serviço
`anticlone-dev` administra a configuração privada do Admin Dev. Conserve os
owners, modos e mounts estabelecidos. O NPM lê certificado e chave cliente e CA
do Gateway em `/data/nginx/custom/anticlone-dev/tls/`. O Gateway mantém sua
chave, certificado e CA de clientes sob o diretório privado do serviço.
Restrinja chaves aos respectivos serviços. Guarde backups e detalhes de acesso
no ambiente privado.

## Adicionar um domínio

1. No Cloudflare, configure um registro DNS com proxy para o ingresso existente.
   Use TLS **Full (strict)** e regra de **Bypass cache** para o hostname.
   Emita ou selecione no NPM um certificado válido para o nome, ative Force SSL
   e acompanhe a renovação no fluxo normal do NPM.
2. Faça backup da configuração que será alterada. Crie um Proxy Host com um
   único hostname e encaminhamento HTTPS para `172.20.0.1:13003`. Em Advanced,
   use estes includes existentes.

   ```nginx
   include /data/nginx/custom/anticlone-dev/proxy-host.conf;
   include /data/nginx/custom/anticlone-dev/proxy-location.conf;
   ```

   O primeiro fragmento aplica os guards de Host e as regras do vhost. O
   segundo delimita rotas públicas e aplica mTLS, verificação da CA, Host e SNI
   canônicos `protect.leoceo.online` e sanitização de headers. As zonas são
   carregadas pelo hook existente `/data/nginx/custom/http_top.conf` a partir
   de `http-limits.conf`. Cada novo domínio tem seu próprio Proxy Host.
3. Execute `nginx -t` e o aceite abaixo. Faça a alteração e a regressão
   individualmente antes de passar ao próximo domínio. Foi esse o procedimento
   usado por leoceo nos Hosts 15 e 16, com backup prévio na VPS real.
4. Acrescente a origem HTTPS exata, sem barra final, à lista privada separada
   por vírgulas `RUNTIME_TELEMETRY_POOL_ORIGINS`. No Dev a lista fica em
   `~/.config/systemd/user/anticlone-dev-admin.service.d/95-telemetry-endpoint.conf`.
   Preserve as entradas existentes. Faça `systemctl --user daemon-reload` e
   reinicie apenas `anticlone-dev-admin.service`. Confirme a origem na
   configuração efetiva do processo e o estado ativo do serviço.
5. No Admin Dev, em **Configurações → Endpoints de telemetria**, cadastre a
   origem, habilite e verifique. Exija estado `OPERATIONAL` atual antes de
   publicar. A verificação usa o probe HTTPS público. A pool admite até 50
   origens e exige HTTPS na porta padrão.
6. Na instalação da LP, escolha um endpoint único ou atribua um endpoint a
   cada função. `SCRIPT` serve Bootstrap, Core e fallback.
   `TELEMETRY` atende decisão, coleta, atualização e recibos.
   `STATIC_ASSETS` serve pixels e inventário de CTA. Um domínio pode ocupar
   mais de uma função. Em uma revisão existente, **Usar origens padrão**
   prepara uma publicação com as origens configuradas para cada função,
   inclusive padrões válidos fora da pool. **Manter endereços da revisão
   atual** cancela a escolha. Confirme a publicação e aplique o trecho da
   nova revisão somente na LP escolhida. Preserve os ingressos usados por
   trechos anteriores.

## Limites e aceite

As zonas existentes usam a chave `$server_name|$realip_remote_addr`.
Os limites de referência dos fragmentos Dev são 2 requisições/s com burst 20,
10 conexões simultâneas, HTTP 429 por excesso e corpo máximo de 2 KiB.
Respeite os limites ao executar sondas e valide os valores efetivos se a
configuração mudar.

- Faça o probe `/assets/js/app.00000000000000000000.js` diretamente no NPM,
  com TLS/SNI do nome externo, e via Cloudflare. Exija HTTP 200,
  `status=ready`, `mode=OPERATIONAL`, `action=SCOPED_AUTHORIZATION_REQUIRED`.
  Via Cloudflare, confira `CF-Cache-Status: DYNAMIC` e
  `Cache-Control: no-store`.
- Exija 404 em `/admin`, `/admin/ui/`, `/login` e em uma rota fora da lista
  pública. Correlacione o fallback no log NPM com `upstream_status "-"`.
- Após cada mudança, confira o probe e o script histórico do Host 13.
  Nas novas rotas, use um script histórico da instalação de laboratório.
- Na LP de laboratório, valide recursos por função, carregamento dos scripts
  e pixels, coleta, decisão e CTA. Confira novamente o trecho anterior após
  publicar nova revisão e valide o comportamento do fail-open quando aplicável.
- Registre status, cache, duração HTTP e comportamento do runtime por amostra.
  O HTTP mede a viagem da requisição. O prazo da decisão de página começa no
  Bootstrap, antes da resposta. O orçamento é de 150 ms de relógio monotônico
  local, e o callback pode rodar mais tarde conforme o agendamento do navegador.
  Uma resposta tardia pode ter HTTP 200 e ainda assim ser descartada para
  redirecionamento inicial. A decisão local de CTA segue seu próprio fluxo.

## Rollback

Se o ingresso novo falhar antes de receber instalações, restaure o Advanced
anterior ou retire de exposição somente o novo Proxy Host. Confirme `nginx -t`
e o probe e o script do Host 13. Para suspender novas publicações, desabilite a
origem na pool e confirme o estado no Admin. Se já houver consumidores,
consulte as páginas afetadas na pool e migre e valide os trechos antes de
retirar o ingresso, incluindo os que usam revisões históricas. Para recuar a
release do Admin, restaure o drop-in anterior e reinicie o Admin Dev.
Só restaure a lista anterior quando os novos domínios puderem ser retirados da
publicação. Preserve os registros de instalações e revisões.

## Evidências de novembro de 2026

Leoceo informou `nginx -t` aprovado, probe direto e via Cloudflare aprovado,
404 administrativo em ambos os caminhos, fallback 404 sem upstream, Host 13 e
script histórico preservados. Os Hosts 15 e 16 foram aplicados individualmente
com os dois includes existentes. A tentativa no clone descartável foi
abandonada por falhas de reprodução da imagem do NPM.

Em 25/11/2026 as três sondas públicas retornaram 200, `DYNAMIC` e
`no-store`. Tempos HTTP das sondas nessa rodada: 122 ms no Host 13, 235 ms
em `web-frame.net` e 113 ms em `static-layer.com`. As quatro rotas
negativas retornaram 404 nos três hosts. O teste direto e a correlação com
o log do NPM são evidências fornecidas pelo operador.

A allowlist Dev preservou `https://protect.leoceo.online`. O Admin verificou
`https://web-frame.net` e `https://static-layer.com` como `OPERATIONAL`.
O Admin foi promovido para `adcf9b12` (PR #94) com a flag de aliases
compactos já ativa e atualizado para `10703eb` após a correção do P2. O gateway Dev já servia o contrato utilizado pelo PR.
Lint, typecheck, build e o check oficial `validate-repo` passaram.

Chromium carregou LPs de laboratório com HTML servido por interceptação local
e recursos e POSTs reais via Cloudflare no Dev. Cada caso preservou revisão
1 no Host 13 e publicou revisão 2 no contrato 4. As seis rotas de recursos
retornaram 200, decisão retornou `REPLACE_CONVERSION`, coleta e sessão
retornaram 204, o CTA chegou ao destino de laboratório, e os recibos de
Bootstrap, Core, fallback e canários foram persistidos. As autorizações
temporárias foram suspensas ao fim. Outras 15 revisões históricas v2
(8 públicas e 7 privadas) serviram o Bootstrap com e sem query string,
com conteúdo idêntico para cada par.

| Script | Telemetria | Estáticos | HTTP da decisão (ms) | Callback do prazo no navegador (ms) |
|---|---|---|---:|---:|
| web-frame.net | web-frame.net | web-frame.net | 411 | 162 |
| static-layer.com | static-layer.com | static-layer.com | 191 | 180 |
| web-frame.net | static-layer.com | static-layer.com | 191 | 162 |
| static-layer.com | web-frame.net | static-layer.com | 203 | 155 |
| web-frame.net | static-layer.com | protect.leoceo.online | 276 | 157 |

O HTTP da decisão foi medido entre `requestStart` e `responseEnd`.
O navegador programou o encerramento da janela inicial em 149,6–150 ms e
executou o callback em 155–180 ms nas amostras. O código compara o relógio
monotônico com o prazo de 150 ms quando considera aplicar redirecionamento.
Os casos acima exercitaram o caminho de CTA. Eles não medem navegação por
`PAGE_REDIRECT` nem formam uma distribuição estatística de latência.
Os registros brutos ficaram no diretório privado da release Dev.

A revisão independente `/root/revisao` detectou no SHA `adcf9b12` a
ausência da ação para restaurar os padrões. O SHA `10703eb` restabelece
essa ação via `telemetryOrigin: null`. O teste focal em Chromium e PostgreSQL
confere cancelamento, payload, publicação fora da pool e preservação da
revisão anterior. Os três testes focais passaram. A revisão independente
`/root/p2` aprovou o delta `f5659a99b67a6186dece9de65ee35f95f694944948a302ad7890e44d4f6e27b8`.
A primeira CI oficial identificou uma asserção remanescente que ainda
esperava a revisão anterior como atual. O SHA `6d00d0c` ajustou somente
as asserções de histórico e prontidão. A revisão independente aprovou
o delta adicional. [CI oficial do SHA final do PR #94](https://github.com/oleoceo/anticlone-personal/actions/runs/45701475272).

### Decisão inicial de página via Cloudflare

O Chromium carregou HTML de LPs próprias de laboratório por interceptação
local e usou Bootstrap e decisões reais do Dev via Cloudflare. As
autorizações das fixtures foram suspensas ao fim. O tempo HTTP vai de
`requestStart` a `responseEnd`. O tempo desde o Bootstrap termina quando o
JSON foi entregue ao runtime após leitura e decodificação. A condição
aquecida incluiu sondas prévias no mesmo contexto do navegador. O teste
não confirmou o reúso de cada conexão.

| Telemetria | Conexão | HTTP (ms) | Desde o Bootstrap (ms) | Resultado |
|---|---|---:|---:|---|
| static-layer.com | Fria | 168,3 | 196,3 | Descartado |
| static-layer.com | Aquecida | 141,1 | 162,7 | Descartado |
| static-layer.com | Aquecida | 133,4 | 150,1 | Descartado |
| static-layer.com | Aquecida | 158,6 | 173,8 | Descartado |
| web-frame.net | Aquecida | 227,0 | 262,3 | Descartado |
| web-frame.net | Aquecida | 157,7 | 170,5 | Descartado |
| web-frame.net | Aquecida | 123,8 | 136,7 | Aplicado |
| web-frame.net | Aquecida | 111,8 | 119,9 | Aplicado |
| static-layer.com | Aquecida | 185,2 | 207,7 | Descartado |
| static-layer.com | Aquecida | 145,3 | 172,2 | Descartado |
| static-layer.com | Aquecida | 153,4 | 166,1 | Descartado |
| static-layer.com | Aquecida | 174,2 | 191,4 | Descartado |

As 12 respostas retornaram HTTP 200 com `PAGE_REDIRECT`. As duas entregues
dentro de 150 ms levaram ao destino aprovado. Nas dez entregues fora do
prazo, a LP permaneceu aberta e seu link nativo continuou navegável.
Em uma falha de transporte injetada somente no navegador, a requisição
rejeitou após 60,9 ms desde o Bootstrap, e a navegação nativa também
funcionou. A amostra de CTA no mesmo fluxo de laboratório retornou
`REPLACE_CONVERSION` em HTTP 119,8 ms, com entrega em 139,3 ms, e o clique
chegou ao checkout aprovado. A primeira tentativa de clique expirou no
seletor textual do fixture. Uma reprodução isolada confirmou que, sem
a declaração UTF-8, o Chromium interpretou o HTML como Windows-1252
e alterou o nome acessível. O reteste declarou UTF-8, selecionou o CTA
pelo marcador e confirmou a navegação ao destino.

A diferença entre os relógios explica descartes mesmo com HTTP abaixo de
150 ms. O ensaio mede a latência de ponta a ponta observada no navegador.
Ele não isola latência de Cloudflare, NPM ou Gateway por componente e
não estabelece percentis. O prazo e o runtime continuam os mesmos.
