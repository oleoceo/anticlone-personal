# Contrato de arquitetura e distribuição v1

Base inspecionada: main após PR #63, 34853e1. Este contrato precede alterações do runtime. F07/F03 são a capacidade verificável desta consolidação; nenhuma capacidade ausente passa a entregue por este documento.

| Camada atual | Entrada e identidade | Saída / dependências | Falha |
|---|---|---|---|
| Bootstrap (`runtime/bootstrap.js`) | URL do script, pathname, sessão pública, sinais declarados | Inicia a decisão em paralelo com o Core; aplica PAGE_REDIRECT e snapshots CTA; consulta entry-decision/cta-refresh; recibos F29. Fallback é instalado separadamente | Redirect 150ms fail-open; CTA sem fetch no clique, resposta até 5s, TTL 120s; navegação nativa |
| Core (`runtime/core.js`) | URL, origem/pathname, atribuição limitada | POST observe; somente coleta, não é o motor completo | Melhor esforço, sem bloquear página |
| Fallback (`runtime/fallback.js`) | Sua própria URL e contexto | POST observe/fallback, observação independente quando instalado diretamente | Sem promessa de mitigação; falha silenciosa |
| HTML/CSS Canary | GET imagem com Referer alegado | observeCanary; agregados passivos, sem decisão | Referer ausente é desconhecido; nenhuma mitigação |
| Gateway (`server.ts`, `scoped-gateway.ts`) | IDs públicos de instalação, JSON limitado, headers não confiáveis | resolvePageContext -> projeto/LP; coleta, políticas, elegibilidade e respostas | Observação 4xx/503; decisão OBSERVE_ONLY; proxy e limites preservados |
| Motor (`page-redirect.ts`, `cta-policy.ts`, `allocation.ts`) | Snapshot aprovado e versionado, destino validado, classe/sessão | Decisão por ação, percentuais independentes, drift por ponto/superfície | Sem aprovação/elegibilidade mantém original; ainda limitado ao laboratório |
| Stealth (`risk.ts`, `stealth.ts`) | Evidência com procedência e avaliação separada | Legado LOW; v2 OFF sem veto de risco; ON conserva UNCERTAIN (D05) | Sem HIGH operacional fabricado; fixture HIGH somente laboratório |
| Alias Manager (novo v1) | Instalação da LP + papel + revisão | Associação durável, pública, sem credenciais; caminhos antigos preservados | Sem migration/configuração, distribuição explicitamente indisponível |
| Instalação/painel (`protected-pages.ts`, `admin-ui.ts`) | Admin autenticado/CSRF, projeto + LP | Criação explícita de distribuição; consulta sem gerar aliases; HTML/CSS e diagnóstico por camada | NOT_VERIFIED: sinais alegados não comprovam instalação |

## Distribuição v1

Três papéis lógicos SCRIPT, TELEMETRY e STATIC_ASSETS compartilham inicialmente uma origem operacional própria. Configuração privada associa cada papel à sua origem; acesso admin permanece privado e separado. Origem pública nunca é inferida de Host/Origin da requisição. O consumidor recebe URLs completas por papel. Não há identidade falsa de terceiros.

Cada revisão persiste origens e aliases por instalação/papel. Publicar revisão posterior é explícito; revisões anteriores continuam resolvíveis. Alterar configuração não altera URLs distribuídas. Rotas legadas `/runtime.js`, `/i/:installation/...` permanecem. Identificadores/aliases são correlação, não autenticação. Novos caminhos usam `/d/v1/:alias/:endpoint` e retornam o mesmo contrato de decisão atual; v1 de distribuição não muda versões das políticas.

Bootstrap continua responsável pela execução de ações; Core continua coletor. Scripts distribuídos recebem as três bases por papel; Fallback aparece como script independente no HTML. Reinseri-lo permite nova tentativa após falha. Canários são passivos e vinculados à instalação, com diagnóstico limitado; retenção dos sinais de LP permanece sete dias. Sem scripts ativos não há promessa de proteção ativa.

F45: canários autorizados atualizam a atividade na instalação existente, quando o schema opcional está presente. F44: `runtime-layer-observations.ts` liga Core/Fallback e canários scoped ao avaliador existente, somente para IDs/origem SCOPED_LAB autorizados em loopback. Fila serial limitada a 100, lacuna monotônica após reinício/saturação/perda conhecida, retenção e limiares existentes. A manutenção conserva a mesma origem de correlação. Falhas depois do contexto resolvido invalidam a linha de base; rejeições anteriores ao contexto/proxy continuam desconhecidas. Correlação é por projeto/host, não comprova adulteração individual de uma LP. Stealth não consome essa inferência como identidade de operador.

## Configuração e instalação

Migration 051 sucede 050 e as migrations existentes, somente no laboratório autorizado nesta entrega. Gateway e admin compartilham banco/código; o proxy público continua recusando rotas administrativas. Admin permanece no processo privado existente. `/admin/ui/distribution` usa sessão e CSRF existentes.

Configuração privada inicial do admin: `RUNTIME_PUBLIC_ORIGIN=https://runtime.owner.test`, sem barra final. É exemplo próprio, não endereço publicado. SCRIPT, TELEMETRY e STATIC_ASSETS herdam essa origem única. Quando houver hostname administrativo configurado, informar também `ADMIN_PUBLIC_ORIGIN`; publicação recusa o mesmo hostname operacional. URLs não vêm de campos do browser nem de headers. Aliases são públicos.

No painel, informe projeto e ID da LP em **Distribuição e instalação por LP**. **Consultar distribuição** não cria nem troca aliases. **Publicar endereços de instalação** grava três aliases atomicamente e é idempotente enquanto a configuração não mudar. Copie HTML para a LP e CSS para sua folha de estilos; aplique `anticlone-canary` a um elemento visível existente. A regra CSS pode ser sobrescrita pelo site: confirme a requisição no navegador. Ajuste CSP da página sob seu controle para script-src/connect-src/img-src das origens configuradas; sem permissão da plataforma a camada pode não carregar.

Diagnóstico lista Core/Fallback/HTML/CSS recebidos nos últimos sete dias; Bootstrap não tem sinal próprio e permanece UNKNOWN. Confira runtime.js e core.js na aba Rede para essa camada. Sinal é alegação forjável, portanto NOT_VERIFIED não vira verificação controlada. Canários sem Referer podem produzir agregado desconhecido sem sinal autorizado da LP. Não confundir ausência com adulteração.

Evolução explícita: `RUNTIME_SCRIPT_ORIGIN`, `RUNTIME_TELEMETRY_ORIGIN`, `RUNTIME_STATIC_ASSETS_ORIGIN` no ambiente privado sobrescrevem cada papel. Publicar novamente cria outra revisão; consultar não muda revisão. Revisões e aliases são imutáveis. Manter hostnames/proxies antigos enquanto houver instalação anterior; desligá-los exige migração explícita. O HTTPS fornecido atende um hostname inicial: múltiplos hosts não estão publicados ou homologados e exigirão fronteiras TLS/proxy autorizadas. Consumidores v1 já usam três bases e não precisam mudar.

## Inspeção no painel React

`inspect` retorna os pré-requisitos de publicação, mudança de origens e rotação e o primeiro bloqueador da verificação. Falhas esperadas dos comandos usam códigos seguros em HTTP 400. A inspeção mantém o histórico e os snippets existentes mesmo quando a configuração privada impede novas publicações. Aptidão para gerar endereços é uma verificação de configuração e schema. A entrega dos recursos depende do gateway e da rota usada pela LP.

O diagnóstico distingue ausência de prova recente, verificador sem configuração e tentativa inconclusiva. As cinco camadas exibem a medição controlada da revisão atual quando disponível e, separadamente, acessos por alias ou sinais declarados. Os acessos por alias se referem à revisão exibida. A camada Bootstrap usa o recibo recente da entrega de `runtime.js` pelo alias de scripts da revisão atual, vinculado à LP e à instalação. A prova de execução continua na medição controlada. Os sinais declarados pertencem à LP. Os resultados da carga controlada obedecem ao [contrato F08](F08-CONTROLLED-VERIFIER.md).

## Provas reproduzíveis

`tests/runtime-distribution.test.ts`: PostgreSQL/Chromium, painel autenticado, consultas sem rotação, publicação concorrente idempotente, isolamento, F45, HTML/CSS/Fallback independentes, versões antigas e F44 com amostras reais envelhecidas transacionalmente. Trigger sintético no registro principal produz HTTP 503 e invalida a linha de base sem inventar observação Core.

`tests/scoped-gateway.test.ts` executa o mesmo cenário operacional em modo legado e distribuição v1: redirect, CTA sem decisão no clique, quatro classes, 0/50/100, atribuição permitida, drift isolado, revisão, F29/F30/F42, investigação #63, SMTP sintético e reinício. `tests/https-gateway.test.ts`, com `HTTPS_GATE_TEST=1`, carrega aliases por Nginx/TLS real e recusa papel incorreto. Comando completo: `HTTPS_GATE_TEST=1 npm test` no laboratório Linux com PostgreSQL/Chromium/Docker; lint/typecheck/build são gates adicionais. Evidências finais no STATUS/PR; não concluir proteção de produção.

Revisão independente consolidada `/root/distribution_review`, somente leitura: favorável, sem P0/P1/P2 remanescentes. SHA-256 dos 17 arquivos de código/runtime/infra/testes revisados: `dfa7a863043ae7b0e509b5080881055567e4eb188b2c7a425f7830fcc592f60d`. Algoritmo: caminhos ordenados, concatenar caminho + NUL + conteúdo UTF-8 normalizado LF + NUL. Achados resolvidos: retry legado Fallback, atividade F45, lacunas e inicialização F44, origem consistente na manutenção e prova HTTPS. Documentação operacional conferida na mesma sessão.

Prova local final: regressão Linux/PostgreSQL/Chromium/HTTPS 104 PASS, zero falhas/skips (270360 ms), seguida do complemento TLS final 2/2 PASS (17064 ms). Lint/typecheck/build e nove testes Python PASS. Logs laboratoriais `/tmp/anticlone-distribution-suite-final.log` e `/tmp/anticlone-distribution-tls-final.log` no WSL; imagem `anticlone-pilot:test` reconstruída do código final. A CI do SHA final permanece gate do PR.

## Preservação

Nenhuma alteração das regras comerciais, aprovações, drift, F29/F30/F42, investigação #63, alertas, lifecycle ou auditoria é autorizada implicitamente pela distribuição. Testes antigos continuam gates. Coleta, correlação e risco permanecem nos módulos existentes; sem novas características pessoais ou inferência de operador. Homologação é sintética; sem DNS/deploy/migration de produção ou ativação real. Múltiplos hosts requerem configuração explícita de proxy/TLS autorizado no futuro, mantendo o consumidor v1.

## Correção do PR #64 — operacional e distribuição v2

Este complemento supera as restrições exclusivamente laboratoriais acima somente nos caminhos indicados. Consolidação PARCIAL; diagnóstico controlado BLOCKED; sem homologação de produção.

GATEWAY_MODE=OPERATIONAL recusa fixtures SCOPED_LAB/LAB_CONTROLLED e mantém decisões globais legadas em observação. Somente decisões scoped usam page_operational_authorizations (052). Nenhuma LP existente é habilitada pela configuração/migration. /admin/ui/operational e o formulário usam sessão/MFA/CSRF existentes: consultar, autorizar e suspender. Mudanças exigem revisão esperada e auditoria imutável. Autorizar exige reconhecimento do limite de confiança, contexto HTTPS exato, lifecycle ativo, aprovação e gerações atuais. Republicação/reaprovação exige autorização atualizada. Destinos continuam sujeitos a snapshots e allowlists exatas.

Contexto autorizado é origem/pathname escolhida pelo administrador, não prova de cópia ou identidade. Origin, Referer, alias, UUID, sessão, UTM, IP e fingerprint não autenticam visitantes. Pedidos forjados podem obter decisões públicas; isso não concede acesso administrativo. O servidor recusa origens oficiais cadastradas; Bootstrap confere origem/pathname reais contra o contexto retornado. Alterar/remover o JavaScript permanece fora da capacidade de proteção. O avaliador operacional usa UNCERTAIN, sem HIGH/LOW fabricados; D05 v2 e semântica legada permanecem.

Suspensão serializa com admissões por locks de projeto/LP/autorização. Após commit, novas admissões ficam em observação; decisões admitidas podem terminar. Snapshots CTA entregues mantêm D09 (até 120 s desde o início), sem rede no clique. PILOT_OBSERVE ignora autorizações persistidas. Entrada mantém 150 ms e fail-open.

Migration 053 emite /r/v2/:alias/:recurso, com recursos neutros a.js, b.js, c.js, e, f, g, h, j, k, m.gif, n.gif, p.js. Mapa por revisão entregue aos consumidores; sem imitar terceiros ou prometer invisibilidade. V1 permanece em /d/v1/; /runtime.js e /i/:installation/... permanecem. Gateway/Nginx recusam recursos/papéis incorretos. Um hostname atende os três papéis por padrão.

Rotacionar aliases cria revisão explícita atomicamente sob lock da LP, mesmo sem trocar origens. Publicar permanece idempotente; consultar retorna bases ativas e até 100 revisões com horário/motivo, sem criar IDs. Histórico completo permanece no banco, imutável. Duas rotações concorrentes explícitas criam duas revisões serializadas; publicação concorrente mantém uma revisão. Rotação não desliga aliases antigos.

Canários não gravam presença individual da LP: runtime_alias_activity registra chegada pelo alias, horário do servidor, retenção sete dias. Referer de origem autorizada contribui somente como alegacao ao agregado projeto/origem F45, nunca a uma LP individual. Origem/raiz nao distingue pathnames e pathname completo tambem e forjavel. F44 permanece agregado laboratorial projeto/origem, com lacunas de reinício/perda/saturação, nunca prova de remoção ou autoridade comercial. Fallback/canários permanecem observacionais.

Diagnóstico separa publicação, sinais alegados, chegada por alias, verificação e capacidades. controlledVerification=NOT_VERIFIED, razão ISOLATED_VERIFIER_UNAVAILABLE; observação/mitigação verificadas ficam UNKNOWN. Nenhum sinal produz FULL/PARTIAL/UNSUPPORTED. Não existe navegador/fetch de URL indicada ao diagnóstico: ação verify/campos URL são recusados. BLOCKED: falta isolamento de execução com egress deny-by-default comprovado no SO/container, resolução fixada e bloqueio de rede privada/rebinding/UDP/WebRTC. Interceptação Playwright não substitui essa fronteira. Alternativa segura: laboratório sintético invocado pelo operador; resultado de teste não certifica uma LP cadastrada.

Provas: operational-authorization.test.ts (PostgreSQL/Chromium; com HTTPS_GATE_TEST=1, Nginx/TLS real), dois projetos/três LPs, sem fixtures, UNCERTAIN, original, CTA antes do clique, suspensão/reautorização, concorrência, lifecycle, geração, instalação inválida e destino alterado. runtime-distribution.test.ts: rotação na mesma origem, v1/v2, histórico, camadas, múltiplas LPs por hostname, headers ausentes/forjados e recusa de verificação arbitrária. Não equivale a DNS/TLS público ou produção.
O fluxo administrativo aceita importacao manual de candidatos revisados em origem HTTPS, usando as validacoes, selecao humana, mapeamento, revisao e aprovacao existentes; nao faz fetch/navegacao. Capture os dados em pagina propria por meios controlados e revise o JSON. A captura automatica por iframe/postMessage continua exclusivamente loopback. A prova operacional usa importInventory/approveDestination/mapPoint reais, sem criar mapeamentos por SQL. Healthz anuncia OPERATIONAL/SCOPED_AUTHORIZATION_REQUIRED; o smoke observacional continua recusando esse modo. ROUTE_OBSERVED separa HTML e CSS por (alias,source), sem afirmar execucao.
Validacao corretiva final local do codigo 4691f4cc620c79b22b9621bbc0548ada5c3626e0: HTTPS_GATE_TEST=1 npm test, PostgreSQL/Chromium/Nginx reais, 105 PASS / 0 FAIL / 0 SKIP, 300496.943959 ms; lint/typecheck/build PASS e nove testes Python PASS. Log WSL /tmp/anticlone-pr64-corrective-suite-final.log; imagem local reconstruida em /tmp/anticlone-pr64-corrective-image-final.log. Revisao independente consolidada /root/pr64_corrective_review favoravel, sem P0/P1/P2 remanescentes; fingerprint SHA-256 dos 24 arquivos de codigo/runtime/infra/testes: bc3f656710ac908a1f82dd2843d78f6d4e1387b635b7cd0977f59296a05bc7ed (caminhos ordenados, caminho UTF8 + NUL + conteudo CRLF normalizado LF + NUL). O commit seguinte altera somente evidencias documentais; CI no SHA final permanece gate do mesmo PR #64. F08 BLOCKED impede declarar consolidacao integral.
Bloqueio externo da CI em 2026-11-10: run 42829199298, SHA 53a42bee7693f47c2df31768550271f229b6079e, job validate-repo encerrou em 2 s sem steps/logs. Anotacao GitHub: The job was not started because recent account payments have failed or your spending limit needs to be increased. Reproduzir com gh run view 42829199298 --json jobs e gh api repos/oleoceo/anticlone-personal/check-runs/129874451747/annotations. Nao e falha de teste do codigo e nao existe CI verde para esta correcao. Intervencao de faturamento/limite depende do proprietario; nao alterar custos nem contornar o gate. Provas locais nao substituem a CI exigida. O PR permanece draft; consultar checks do SHA final apos normalizacao da conta.
Decisao posterior do proprietario para o fechamento do PR #64: executar integralmente CI local gratuita no WSL/Linux como gate escolhido nesta revisao, mantendo Actions BLOCKED e PR Draft. O HEAD48a9541 passou105/0/0 em Node22 com workflow completo. Teste operacional ampliado une v2, painel MFA/CSRF, rotacao/autorizacao/suspensao, PAGE/CTA reais sem reescrita e falhas; apps/runtime/infra nao mudaram. Runner, resultado integral do novo HEAD e evidencias acessiveis descritos em LOCAL-CI.md. F08 permanece BLOCKED; nenhum status remoto verde e alegado.

## Pool de origens de telemetria (067–068, procedimento anterior à 075)

Em Configurações → Integrações → Endpoints de telemetria, cadastre a origem
HTTPS completa de cada domínio próprio. O cadastro usa `telemetry_origins` e
começa pendente. Inclua na lista privada `RUNTIME_TELEMETRY_POOL_ORIGINS` do
admin só origens que já tenham ingresso provisionado, separadas por vírgulas.
O hostname administrativo e portas públicas alternativas ficam fora da seleção.

Use **Verificar endpoint** para consultar DNS público, validar TLS para o
hostname e conferir `GET /healthz` do gateway em modo `OPERATIONAL`. O admin
reutiliza o transporte HTTPS limitado do verificador. Ele fixa um IP público
resolvido, valida o certificado para o hostname e recusa redirecionamento.
O cadastro e a consulta da lista são locais. A data exibida é a da última
verificação executada. Revalide após mudanças de DNS, TLS ou ingresso.

Na instalação da LP, selecione um endpoint operacional e publique uma revisão.
A seleção explícita usa o domínio para os scripts, sinais e canários, inclusive
no HTML para o `index.html`. Manter a revisão atual conserva a distribuição
por papel, incluindo instalações anteriores à migração 068. Desativar impede
novas publicações com o endpoint. A lista mostra LPs com revisões atuais ou
anteriores naquele domínio. Uma revisão antiga pode continuar instalada no
site, mesmo após publicar outra. Mantenha o ingresso enquanto houver trechos
em uso.

No Dev, `https://protect.leoceo.online` depende da homologação do Proxy Host 13
no `NPM_TRAFFIC_GATE`. Para cada domínio adicional, provisione o seu hostname
e certificado público no NPM e aplique os mesmos limites e rotas de distribuição.
Cada vhost valida o seu Host externo e usa o mesmo upstream mTLS privado,
com `proxy_ssl_name` e `Host` upstream fixos no hostname canônico
`PUBLIC_GATEWAY_HOST` da instância. O certificado interno, os pins, a instância
e o PostgreSQL Dev são compartilhados pelo fluxo. A conclusão do gate e o
teste no hostname real continuam necessários para cada ingresso.

## Aliases compactos e cadastro de domínios (075–077)

Para a mesma função de Bootstrap, os formatos públicos são:

| Revisão | Exemplo |
|---|---|
| v1 histórica | `https://assets.example.com/d/v1/8ce06c96-03bb-46ed-a9a9-916006c36bdd/runtime.js` |
| v2 histórica | `https://assets.example.com/r/v2/8ce06c96-03bb-46ed-a9a9-916006c36bdd/a.js` |
| Compacta anterior | `https://assets.example.com/assets/I2Fz7aURhvkqwkSqBywnXQ/a.js` |
| Compacta nomeada | `https://assets.example.com/assets/I2Fz7aURhvkqwkSqBywnXQ/app.js` |
| Compacta atual | `https://signals-pool.owner.test/assets/js/app.4e25b80ce6409714d13e.js` |

A 075 é aditiva. Cada papel recebe 128 bits aleatórios do gerador criptográfico
do Node, codificados em 22 caracteres base64url. O índice único cobre todos os
tokens públicos e uma colisão é tentada novamente dentro da transação de
publicação. O UUID segue como chave interna de recibos e atividade. As três
rotas de cada revisão continuam vinculadas à LP, aos papéis e às origens
persistidas. O token é um identificador público. A 076 fixa o novo mapa nos registros do contrato 3. Revisões v1, v2 e compactas
anteriores conservam os nomes originais. A 077 fixa o contrato 4 e move o
token para o nome de cada recurso. Escolhemos 80 bits em vez de 64 para
reduzir a chance de colisão por um fator de 65.536. São dez bytes do gerador
criptográfico, codificados em vinte caracteres hexadecimais. O sufixo tem
aparência de hash de asset e é um identificador aleatório da revisão por
papel. O índice único e a emissão transacional com até três tentativas
preservam a unicidade. O zero é reservado ao probe. As validações de papel,
instalação e autorização continuam no Gateway.

Após habilitar `RUNTIME_COMPACT_ALIASES=true` no ambiente privado do admin,
novas revisões usam os nomes do formato compacto, após aplicar a 077. A primeira publicação e alterações
de origem geram a revisão automaticamente. Para trocar os caminhos de uma LP
com a mesma origem, use **Publicar nova revisão** no histórico da instalação.
Consultar e republicar sem mudança de origem preservam a revisão atual.
O conteúdo executável e a sequência de carregamento preservam o contrato.
O formato de arquivo repete os tokens nos nomes do mapa injetado. O ensaio
Chromium compara os pedidos e o evento de carga da mesma LP sintética com
os dois mapas compactos e mede o tamanho do Bootstrap servido.

A migração limpa os resultados antigos de verificação. O painel passa a testar
DNS, certificado HTTPS e prontidão operacional pela mesma regra de ingresso
do Bootstrap compacto, com o caminho reservado
`/assets/js/app.00000000000000000000.js`. O probe confirma que a rota chega a
um Gateway operacional com a 077. A conferência privada do upstream efetivo
e o smoke dos três papéis confirmam a instância e a distribuição da LP. A
verificação é pontual. Revalide após alterações de ingresso, DNS ou TLS.

A seleção de um domínio adicional exige cadastro, autorização privada,
habilitação e verificação operacional; a API confere esses requisitos na
transação. Cadastre adicionais pelo pool, inclusive quando planejar usá-los
como padrão em configuração privada. Os padrões existentes continuam sob
responsabilidade do operador, que comprova seu ingresso antes de habilitar o
formato compacto. Desativar um endpoint impede novas publicações nele e
preserva as revisões anteriores. Veja o [procedimento NPM](NPM-VPS-RUNBOOK.md#11-adicionar-um-domínio-de-distribuição).


### Recursos da revisão compacta atual

| Papel | Nomes e função |
|---|---|
| Scripts | `app.js` inicializa a instalação, `common.js` carrega o núcleo e `events.js` registra a observação de fallback. A extensão `.js` reflete o formato servido. |
| Sinais e decisão | `collect` recebe observações, `report` recebe o fallback, `config` entrega a decisão inicial, `refresh` atualiza CTA, `session` e `activity` recebem a sessão e a ação observadas. |
| Recursos estáticos | `pixel.gif` é o sinal HTML, `style.gif` é o sinal CSS e `inventory.js` serve o inventário de laboratório existente. |

Scripts usam `/assets/js/<nome>.<token>.js`, imagens usam
`/assets/img/<nome>.<token>.gif` e os endpoints usam
`/assets/api/<nome>.<token>`. Cada papel usa um token independente.

Exemplo gerado pelo painel para a LP do laboratório Chromium. Use os trechos
gerados para a sua LP para obter os endereços da revisão correspondente.

**HEAD**

```html
<link rel="preconnect" href="https://signals-pool.owner.test" crossorigin>
<script async src="https://signals-pool.owner.test/assets/js/app.4e25b80ce6409714d13e.js"></script>
<script async src="https://signals-pool.owner.test/assets/js/events.4e25b80ce6409714d13e.js"></script>
```

**BODY**

```html
<img src="https://signals-pool.owner.test/assets/img/pixel.96d3f6f9bf0a459fab4a.gif" width="1" height="1" alt="" referrerpolicy="strict-origin-when-cross-origin">
```

**CSS**. Aplique `anticlone-canary` a um elemento existente.

```css
.anticlone-canary {
  background-image: url("https://signals-pool.owner.test/assets/img/style.96d3f6f9bf0a459fab4a.gif");
}
```

- **HTML**. Insira os trechos no `head`, no `body` e na folha de estilos da página.
- **WordPress**. Insira o HEAD pelo mecanismo do tema ou plugin da LP, o BODY num bloco HTML personalizado e a regra no CSS adicional.
- **React/Vite**. Insira HEAD e BODY no `index.html`, importe o CSS existente e aplique a classe com `className`. O Bootstrap continua como script clássico, carregado fora do bundle e da montagem React.

O Core é carregado pelo Bootstrap, por exemplo em
`https://signals-pool.owner.test/assets/js/common.4e25b80ce6409714d13e.js`.
