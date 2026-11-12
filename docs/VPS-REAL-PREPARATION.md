# VPS e homologação real — preparação consolidada

Base: `main` após #75, `d306459a98bb85ff174930f998d24668e0fa865c`.
Uma frente, dois momentos: preparação neste PR; execução somente após autorização
do proprietário e entrega segura dos acessos. Nenhuma operação externa foi feita.
Este roteiro operacional prevalece sobre instruções históricas do piloto para
esta instalação OPERATIONAL multiprojeto. Não modifica contratos D05/D07/D09/D15.
F03/F07/F38 são o recorte verificável; não é nova auditoria das 45 funções.

## 1. Informações mínimas para a execução autorizada

Entregar por canal privado, sem colar credenciais no PR/chat/logs:

| Informação/acesso | Uso |
|---|---|
| Autorização explícita da instalação, janela e responsável | Identificar comandos e serviços permitidos, abortar e recuperar |
| VPS Linux dedicada, arquitetura, recursos/disco, SSH com sudo e chave do host conferida | Docker Engine/Compose v2 compatível, armazenamento e operação |
| Hostname operacional e controle DNS, autorização de alteração | Um hostname direto à VPS, sem CDN/proxy intermediário neste perfil |
| Certificado/cadeia/chave e método autorizado de emissão/renovação | TLS válido; não presumir ACME instalado ou porta 80 aberta |
| LP original e cópia em outro domínio próprio, paths, editor e CSP | Começar em LP de teste sem visitantes comerciais; preservar versão original |
| Destinos próprios aprovados por oferta/CTA e URL de PAGE_REDIRECT | Testar ações separadamente, somente após observação |
| SMTP, porta, TLS, usuário/senha, remetente e caixa autorizada | Permissão explícita de enviar e-mails reais e confirmar chegada na caixa |
| Armazenamento privado de backup/offsite, retenção, RPO/RTO aceitos | Recuperação, espaço, criptografia e responsabilidade pela restauração |
| Contrato/ambiente sandbox do checkout e autorização de eventos de teste | Opcional para observação; obrigatório antes de conectar webhook real |

Não solicitar novas decisões sobre limitações aceitas F14/F22/F32 ou atribuição
incompleta F29/F31 para instalar. Sem contrato compatível de checkout, registrar
LIMITATION e continuar os cenários independentes. Não contratar serviços.

## 2. Configuração preparada, ainda sem aplicar

Pré-requisitos: Git, Docker Engine e plugin Compose, Node 22/npm para build e CLIs,
clientes PostgreSQL 16 (`pg_dump`, `pg_restore`, `psql`), relógio sincronizado,
SSH, espaço para banco + imagem + backup + restore isolado. Dimensionamento real
será observado; limites de memória do Compose não são garantia de capacidade.
Postgres 16 é o banco deste perfil. Não acrescentar Redis/BullMQ: os processos
existentes usam outbox PostgreSQL; não existe dependência Redis neste Compose.

Preparar checkout do SHA validado, limpo, preservando a imagem por SHA. Conferir
PR/CI no SHA escolhido; #75 tem merge `d306459` e check `validate-repo` SUCCESS.
Esse resultado é da base, não da VPS nem de um futuro ajuste.

```bash
git checkout --detach d306459a98bb85ff174930f998d24668e0fa865c
npm ci
npm run build
docker build -f infra/https/Dockerfile -t anticlone-operational:d306459a98bb85ff174930f998d24668e0fa865c .
```

Em diretório privado fora do checkout, root:root 0700, preparar `gateway.env`,
`admin.env`, senha PostgreSQL e certificado/chave root:root 0600. Os modelos em
[vps-models](vps-models/gateway.env.example) não são utilizáveis sem substituição.
Não executar `source` nesses arquivos: são formato env-file Docker, e o registro
de senha administrativo contém `$`. Não imprimir `docker inspect`, ambiente ou
`compose config` completo. Docker/root têm acesso aos segredos.

Gateway: `DATABASE_URL` (senha percent-encoded) para `127.0.0.1:54332/anticlone`,
`PUBLIC_GATEWAY_HOST` sem esquema/porta, `RUNTIME_PUBLIC_ORIGIN=https://HOST`.
Omitir `PROJECT_ID`, `PILOT_ORIGINS`, `ALLOWED_ORIGIN`, `SCOPED_LAB_*` e
`LAB_CONTROLLED_*`. Sem SMTP real inicialmente: `SMTP_PORT=1`, sem
`SMTP_PROVIDER`. Isso mantém transporte local indisponível, não entrega externa.
Antes de habilitar alertas, substituir pelo conjunto SMTP completo autorizado
de [CLONE-SMTP](CLONE-SMTP.md) e recriar gateway/admin/worker pertinentes para
recarregar seus env-files (simples restart não recarrega ambiente).
Credenciais administrativas ficam somente em `admin.env`; SMTP deve coincidir
entre processos. Chave `COMMERCE_ENCRYPTION_KEY` só será provisionada para o teste
comercial autorizado (32 bytes em hex), com backup privado separado.

O renderer usa Node do checkout, nunca dados da requisição:

```bash
export PUBLIC_GATEWAY_HOST=runtime.owner.example
node dist/apps/https-config.js /CAMINHO-PRIVADO/nginx.conf
```

Conferir propriedade/permissões do resultado e TLS como descrito no runbook HTTPS.
Copiar arquivos reais de certificado para o diretório montado; symlinks externos
não funcionam. Definir apenas caminhos e referência de imagem no shell:

```bash
export GATEWAY_IMAGE=anticlone-operational:d306459a98bb85ff174930f998d24668e0fa865c
export GATEWAY_ENV_FILE=/CAMINHO-PRIVADO/gateway.env
export DATABASE_PASSWORD_FILE=/CAMINHO-PRIVADO/database-password
export NGINX_CONFIG=/CAMINHO-PRIVADO/nginx.conf
export TLS_DIRECTORY=/CAMINHO-PRIVADO/tls
dc() { docker compose -p anticlone-operational -f infra/https/compose.yaml -f infra/https/operational.yaml "$@"; }
dc config --quiet
```

Manter o mesmo nome de projeto Compose em toda a vida da instalação: ele determina
o volume `anticlone-operational_pilot_data` (nome histórico, não modo piloto).
Validar `nginx -t` sem rede antes de publicar, pelo comando endurecido de
[HTTPS-OBSERVE-RUNBOOK](HTTPS-OBSERVE-RUNBOOK.md). Não alterar a fronteira de proxy:
somente peer TLS direto, sem Cloudflare/CDN, sem real_ip ou headers confiados do cliente.

## 3. Execução autorizada: banco vazio até 064

Antes de iniciar, confirmar que esta é uma instalação nova e que o volume não
contém dados existentes. Não usar `down -v` nem apagar volume para corrigir falha.

```bash
dc up -d postgres
dc exec -T postgres pg_isready -h 127.0.0.1 -U anticlone -d anticlone
dc logs --no-color postgres
```

Revisar logs privadamente: exigir inicialização encerrada sem erro e servidor
final pronto por TCP. O Compose monta `infra/` inteiro em initdb, não uma lista
fixa até 024: nesta base são **63 arquivos SQL**, 001–064, sem 034. Em volume
novo o entrypoint os executa em ordem lexical uma vez. Conferir a lista no SHA
instalado (`git ls-files 'infra/*.sql'`), preservar hashes com `sha256sum infra/*.sql`
e evidência sanitizada dos arquivos executados, incluindo 063 e 064.
Prontidão sozinha não comprova esquema completo. Conferir, antes de aplicações:

```bash
dc exec -T postgres psql -X -v ON_ERROR_STOP=1 -U anticlone -d anticlone -c "SELECT to_regclass('protected_pages'),to_regclass('runtime_distributions'),to_regclass('page_operational_authorizations'),to_regclass('cta_delivery_attempts'),to_regclass('health_delivery_attempts'),to_regclass('commerce_models'),to_regclass('commerce_connection_versions'),to_regclass('commerce_version_samples');"
dc exec -T postgres psql -X -v ON_ERROR_STOP=1 -U anticlone -d anticlone -c "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='commerce_connections' AND column_name='legacy_model_version';"
```

Nenhuma relação acima pode ser NULL; coluna deve existir. São sentinelas, não
substituem os logs de todas as migrations. Falha parcial: parar o avanço, preservar
volume/logs, identificar primeiro SQL que falhou. Não reaplicar cegamente SQL.
Volume existente **não** executa novas migrations automaticamente. O módulo
`upgradeLaboratory` recusa banco operacional e não deve ser destravado/renomeado
para contornar a restrição. Adoção/upgrade de banco existente exige procedimento
específico com inventário, backup e autorização; não é caminho desta VPS vazia.

## 4. Administração privada e início em observação

Provisionar MFA em terminal privado sem gravação: `node dist/apps/admin-provision.js`.
Guardar senha no gerenciador, segredo TOTP e registro em `admin.env`; cadastrar
TOTP SHA-1/6 dígitos/30 s. A saída contém segredos, nunca anexar ao relatório.
`admin.env` usa o mesmo banco e origem pública de distribuição. O entrypoint
admin cria as duas tabelas de replay TOTP: preservar junto com o banco.

O Compose não inclui admin. Modelo do processo privado persistente:

```bash
docker run -d --name anticlone-admin --restart unless-stopped --network host \
  --env-file /CAMINHO-PRIVADO/admin.env --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --memory 256m --pids-limit 64 \
  --log-driver local --log-opt max-size=5m --log-opt max-file=2 \
  "$GATEWAY_IMAGE" node dist/apps/admin-server.js
dc up -d gateway proxy
ss -ltn
```

Admin escuta somente `127.0.0.1:3001`; gateway 3000 e banco 54332 também devem
ficar loopback. Somente 443 é público para aplicação; SSH restrito ao operador.
Mudança de firewall depende de autorização; conferir externamente que essas
portas internas não estão acessíveis. Não publicar admin pelo Nginx.
Na estação autorizada, túnel SSH local (não reverso), sem escutar em 0.0.0.0:

```bash
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:3001:127.0.0.1:3001 OPERADOR@VPS
```

Abrir `http://127.0.0.1:3001/admin/ui/`, mantendo exatamente host/porta esperados;
MFA, cookies/sessão e CSRF continuam obrigatórios. Este acesso privado segue o
runbook HTTPS atual; supera a proibição histórica de túnel em ADMIN-AUTH-LAB.
Não expor esse HTTP fora do loopback/túnel. Conferir login, logout e novo login
após restart com próximo código; não registrar códigos ou cookies.

No painel: criar projeto com origem oficial, cadastrar LP e path canônico,
habilitar coleta/instalação pelos controles existentes e consultar distribuição.
Em **Distribuição e instalação por LP**, publicar endereços e copiar HTML/CSS
retornados. Guardar IDs públicos e revisão, nunca inventar aliases ou SQL de cadastro.
**Não autorizar contexto operacional de cópia, nem ativar política comercial nesta
fase.** OPERATIONAL não é sinônimo de mitigação habilitada. Sem autorização scoped
e aprovações atuais, decisões permanecem em observação. Conferir isso na rede.

```bash
node dist/apps/installation-smoke.js https://HOST-APROVADO OPERATIONAL UUID-DA-INSTALACAO
```

Exigir healthz OPERATIONAL/SCOPED_AUTHORIZATION_REQUIRED, TLS confiável, scripts
disponíveis e admin/login públicos fechados. Smoke não verifica execução browser.
Não usar NODE_TLS_REJECT_UNAUTHORIZED=0. Verificador F08 isolado é opcional e tem
procedimento próprio; não montar Docker no gateway para habilitá-lo.

## 5. Endpoints e instalação por LP

Um hostname atende SCRIPT, TELEMETRY e STATIC_ASSETS inicialmente; configurar
`RUNTIME_PUBLIC_ORIGIN` no admin. Overrides por papel não criam infraestrutura.
Preservar aliases antigos e seus hosts ao publicar/rotacionar revisões.

| Papel | Recurso v2 sob `/r/v2/ALIAS-DO-PAPEL/` | Uso |
|---|---|---|
| SCRIPT | `a.js`, `b.js`, `c.js` | Bootstrap, Core e Fallback |
| TELEMETRY | `e`, `f` | POST Core e Fallback |
| TELEMETRY | `g`, `h` | PAGE_REDIRECT e CTA refresh |
| TELEMETRY | `j`, `k` | Sessões e ações observadas |
| STATIC_ASSETS | `m.gif`, `n.gif`, `p.js` | HTML Canary, CSS Canary e inventário |
| Gateway | `/healthz` | Banco/modo, não disponibilidade externa completa |
| Comercial | `/commerce-webhook/UUID` | Conexão global; só após contrato/teste autorizado |
| Comercial legado | `/checkout-webhook` | Indisponível neste perfil sem PROJECT_ID; não usar na homologação multiprojeto |

As variantes legadas por projeto do Node não são publicadas pelo Nginx atual.
Usar `/commerce-webhook/UUID` neste perfil; não ampliar Nginx para tentar habilitar
o legado. Não somar fontes financeiras que representam o mesmo pedido.

Os três aliases são distintos. Copiar o snippet retornado pelo painel, que inclui
Bootstrap e **Fallback independente**, canário HTML e regra CSS; aplicar a classe
`anticlone-canary` em elemento visível. Core é carregado pelo Bootstrap.
Não usar `/runtime.js` legado sem instalação no modo multiprojeto. V1 e scoped
`/i/UUID/` continuam disponíveis conforme contrato; não substituir revisão publicada
por URLs fabricadas. Liberar apenas origens necessárias em script-src, connect-src
e img-src da CSP, respeitando nonces/política da LP. Não desligar CSP globalmente.

Bloquear só Core deixa Fallback e canários; bloquear Bootstrap deixa Fallback
diretamente instalado e canários; bloquear um canário deixa os outros canais.
Fallback e canários observam, não substituem o motor de mitigação. Sem scripts
ativos não há proteção comercial. Sem Referer, canário pode ficar desconhecido.
Todos dependem da mesma VPS/gateway/hostname/TLS nesta instalação: queda comum
atinge todos. Não há failover geográfico, servidor redundante ou alerta externo
garantido se VPS/rede/SMTP cair. Worker local mede backend, não internet/DNS/disco.

## 6. Homologação autorizada em ordem operacional

Executar somente na LP e cópia próprias, sem tráfego de clientes. Cada linha começa
**NOT_VERIFIED**; preencher observado/evidência depois da execução, sem promover
resultado laboratorial a PASS externo. Registrar SHA, revisão LP/política, UTC,
navegador/dispositivo/rede e evidência sanitizada. HAR contém cookies/URLs/dados:
não anexar bruto. Comparar original antes/depois de cada ação.

| Ordem/cenário | Esperado e evidência mínima | Resultado externo inicial |
|---|---|---|
| 1. Transporte/LP original | TLS/CSP, a/b/c 200, Core/Fallback e canários recebidos, diagnóstico por camada, sessão/eventos; links e conteúdo preservados | NOT_VERIFIED |
| 2. Independência/falha | Bloquear camadas individualmente e gateway; navegar normalmente, sem esperar rede no clique. Distinguir bloqueio no browser de recibo persistido | NOT_VERIFIED |
| 3. A — cópia em observação | Incidente/domínio/horários/canais/evidências/histórico e dedup; sinal não autentica operador. Nenhuma ação comercial | NOT_VERIFIED |
| 4. SMTP clone/CTA/saúde | Após autorização de envio: ambiente TLS e configuração pública coincidentes; habilitar alertas. Ver tentativa, retry/falha/histórico, restart worker e Message-ID sanitizado; confirmar separadamente na caixa de destino | NOT_VERIFIED |
| 5. B — PAGE_REDIRECT | Aprovar destino/snapshot e autorizar somente contexto HTTPS exato da cópia no painel. Medir deadline 150 ms, navegação real, atraso/queda fail-open e original intacto, desktop/mobile e redes próprias | NOT_VERIFIED |
| 6. C — REPLACE_CONVERSION | Desligar PAGE para isolar CTA. Vários links/ofertas/checkouts mapeados separadamente, política pronta substitui antes do clique, sem fetch no clique; outros links preservados. Testar sem decisão e gateway parado antes/depois do preparo e expiração até 120 s (D09) | NOT_VERIFIED |
| 7. D — troca checkout | Novo destino/vínculo revisado pelos fluxos comerciais e de proteção separados; manter histórico, provedores/contas simultâneos e aprovações. Nenhuma edição do ledger para reatribuir passado | NOT_VERIFIED |
| 8. E — oferta | Alterar preço/desconto/parcelas estruturados na cópia; observar UNKNOWN sem evidência segura, suspensão somente do CTA afetado, alerta e revisão. Texto livre não garante detecção | NOT_VERIFIED |
| 9. F — Stealth | Registrar ON/OFF, UNCERTAIN, ações visíveis e erros/acertos observados. D05 atual mantida, v3 não ativada; nenhuma alegação de invisibilidade | NOT_VERIFIED |
| 10. G — F29/F31 | Sessões/decisões/cliques/tentativas separados. Checkout inicialmente TEST, contrato HMAC suportado e chave provisionada privadamente; depois ACTIVE somente autorizado. Testar venda, duplicata/status/estorno suportado e preservar origem desconhecida | NOT_VERIFIED |
| 11. Operação/recuperação | Restart processos/VPS em janela autorizada, dados e MFA persistentes, worker retomado, backup restaurado isoladamente e smoke; medir RPO/RTO | NOT_VERIFIED |

Antes de SMTP: após editar os env-files privados e obter autorização de envio,
executar `dc up -d --force-recreate gateway` e habilitar/recriar o worker com
`dc --profile notifications up -d --force-recreate notifications`. Para atualizar
o ambiente do admin: `docker stop anticlone-admin`, `docker rm anticlone-admin`
e repetir o `docker run` da seção 4, com o novo env-file. Esses comandos removem
somente o container admin, não o banco; login terá de ser refeito. Não usar `rm -v`.
Ele usa o mesmo arquivo privado; exige configuração válida PROVIDER. Testar restart
via `dc --profile notifications restart notifications`. Saúde exige configuração e
linha de base apropriadas; ausência de tráfego não basta. Revisar backlog/UNKNOWN
antes de liberar efeitos. Alertas podem duplicar após interrupção/restore; aceitação
SMTP não confirma caixa postal. Caixa recebida sem autenticação de contexto também
não prova autoria de clone. Não simular falha alterando senha real em logs.

F29/F31: consultar [F29-F31-MULTIPROVIDER](F29-F31-MULTIPROVIDER.md) para contrato
exato, provisão Linux 0600 e algoritmos HMAC timestampados suportados. Marcas de
checkout não são homologadas automaticamente. Sem chegada/atribuição verificável,
vendas permanecem UNVERIFIED; clique/pagamento sem vínculo nunca é venda recuperada.
Não testar estorno parcial ou contrato não suportado como se fosse suportado.

Para cada execução preencher: esperado; observado; evidência sanitizada; PASS,
FAIL, LIMITATION ou NOT_VERIFIED; impacto sobre proteção/visitante; menor correção
se houver defeito reproduzido. F14/F22/F32 e lacunas F29/F31 permanecem explícitas,
sem bloquear automaticamente instalação observacional ou virar entrega integral.
Defeito: isolar, teste de regressão e revisão independente, sem refatoração ampla
ou merge sem revisão/aprovação do proprietário.

## 7. Backup, retenção, recuperação e rollback

Antes de mitigação, ensaiar [POSTGRES-RECOVERY](POSTGRES-RECOVERY.md) com clientes
PG16 e ambiente privado `RECOVERY_DATABASE_URL`. Não imprimir nem passar URL como
argumento. Checkout/build são necessários: imagem gateway não inclui pg_dump.

```bash
npm run recovery -- backup /CAMINHO-PRIVADO/backups/UTC-NOVO
# Em banco NOVO isolado, sem migrations/apps/worker e com URL privada própria:
npm run recovery -- restore /CAMINHO-PRIVADO/backups/UTC-NOVO anticlone_restore_ensaio
```

Exigir manifest/hash/inventário conferidos e `restore-verified.json`; validar
conexões/ledger 064, configuração, login MFA e smoke com processos isolados sem
SMTP externo nem mitigação. Dump conserva replay TOTP antigo: não usar restauração
como modo de reutilizar códigos; recuperar com cuidado e novo fator se necessário.
Guardar separadamente segredos MFA/SMTP/COMMERCE_ENCRYPTION_KEY, TLS, env-files,
config Nginx, SHA/imagens e parâmetros Compose. Bundle operacional não é cofre.
Não rotacionar chave mestra comercial simplesmente trocando a variável.

Proposta a aprovar antes da operação: backup diário e antes de mudança, sete diários
e quatro semanais, cópia criptografada offsite diária, restore mensal, alerta de
falha/disco e responsável definido. Isso não está automatizado por este PR; RPO
proposto 24 h, RTO será medido. Sem aprovação/ensaio não declarar recuperação pronta.
Retenção do banco mantém contratos atuais (sinais sete dias, incidentes/históricos
conforme respectivas políticas, ledger financeiro sem purga autorizada). Expiração
no banco não apaga backups. Logs Docker locais rotacionados 2×5 MB/serviço, mas sem
expiração temporal garantida: definir revisão/limpeza privada, não publicar erros
brutos. Rotação, renovação TLS, offsite e monitor externo precisam de operação real.

Falha antes de mitigar: `dc stop proxy gateway` e parar worker, preservar banco.
Se já houver LP instalada, remover/reverter snippet pela versão salva quando
necessário; scripts indisponíveis deixam navegação nativa. Para suspender ações,
suspender autorização no painel; snapshots CTA já entregues duram até 120 s.
Manter evidência da falha sem dados privados.

Rollback de código: selecionar imagem/config anterior comprovadamente compatível
com schema, recriar gateway/proxy/admin e repetir smoke antes de reabrir. Primeira
instalação não tem versão anterior: manter publicação parada. Não down-migrar nem
apagar ledger/volume. Após migração de formato de conta na 064, executável anterior
pode não suportar recebimento: manter receptor compatível ou restaurar backup
isolado anterior + código coordenadamente, com remetente e reenvio dos eventos
posteriores. Restore não oferece exactly-once SMTP; reconciliar outbox e eventos
externos antes de ligar worker. Nenhum rollback de produção está autorizado agora.

## 8. Critério para iniciar e encerrar a homologação

Iniciar quando houver autorização, VPS/domínios/LPs de teste controlados, TLS,
esquema completo conferido, admin privado MFA, portas internas fechadas, originais
salvos e backup/restore ensaiado. Começar sem autorização scoped ou políticas
comerciais ativas; validar decisão observacional. SMTP/webhook dependem de suas
autorizações próprias. Ativar cada cenário comercial somente na cópia, isoladamente.

Encerrar com registro dos resultados reais e limitações, incidentes/alertas
sanitizados e ações desativadas na cópia. A passagem a tráfego real é decisão
posterior do proprietário, não consequência automática de PASS na LP de teste.

Preparação local: initdb real PostgreSQL 16 descartável, montagem idêntica de
`infra/`, 63 arquivos executados sem ERROR/FATAL, 87 tabelas públicas, oito relações
sentinelas e coluna 064 conferidas. Container sem rede/portas, dados em tmpfs,
removido após o ensaio. Compose OPERATIONAL `config --quiet`, lint, typecheck,
build e validação documental passaram. Não houve mudança de código funcional nem
reexecução extensa das 45 funções. Revisão e CI deste delta: consultar STATUS e PR.
DNS/TLS públicos, VPS, SMTP/caixa postal, LP e checkout reais continuam NOT_VERIFIED.
