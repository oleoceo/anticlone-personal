# Investigação cronológica de cópias — laboratório pré-VPS

Base: main após PR #62, `994b549db973aec17a5d28b31d53a5feed300692`.
F11/F12 permanecem PARCIAIS: a seção Incidentes agora apresenta uma projeção
legível dos registros retidos por projeto e hostname alegado. Não há novo coletor,
migration, serviço, vínculo automático com LP, identidade ou classificação operacional.

O resumo separa contatos Core/Fallback do incidente e primeiro/último recebimento
disponível associado ao hostname, incluindo canários com Referer atribuível. Tráfego
expõe o primeiro registro disponível DIRECT_UNKNOWN e PAID_ATTRIBUTED e sua evolução,
sem assumir operador ou campanha real. As combinações diárias de tráfego preservam
o primeiro recebimento; avaliações de risco diárias podem ser atualizadas. Presença
diária de fonte não recebe horário inventado. A ordenação dentro de um mesmo dia
sem horário não estabelece sequência causal.

A cronologia distingue Observado, Não verificado, Inferência e Confirmado
administrativamente. Registros complementares da timeline podem representar o
mesmo fato das projeções primárias: não são fontes independentes. DNS compara a
mesma fonte e tipo, sinaliza lacunas e não confirma validade atual ou hospedagem.
Alertas mostram estado e tentativas; aceitação SMTP não comprova caixa postal.
Classificação manual e detalhes técnicos continuam acessíveis.

Coleta incompleta é explícita: fontes/tráfego/canários/risco têm sete dias; timeline
tem até 100 eventos por host na consulta, 10.000 por projeto na persistência e 30
dias de retenção; DNS mantém os limites existentes. Registros anteriores podem
ter expirado, sido deduplicados ou perdido capacidade. Lacunas de coleta do projeto
são exibidas separadamente, sem atribuição ao hostname. Alertas de instalação e
LP não são associados automaticamente ao caso. Ausência de dados não comprova
ausência de atividade, remoção ou contradição resolvida.

`file://` não fornece um hostname HTTP atribuível. GS02 abre um arquivo real no
Chromium sem desabilitar restrições de rede: no laboratório houve uma resposta de
canário, persistida com hostname vazio, sem incidente. Isso não demonstra download
nem visibilidade de cópia offline. O mesmo cenário cobre canários HTML/CSS isolados,
recursos bloqueados, Core/Fallback removidos e falha do gateway. Canários isolados
e Referer continuam não autenticados.

## Reprodução

Com o laboratório PostgreSQL/Chromium configurado conforme LOCAL-LAB-ENV.md:

```sh
npm run build
node --test --test-concurrency=1 dist/tests/investigation.test.js dist/tests/incident-triage.test.js dist/tests/infrastructure-dns.test.js dist/tests/scoped-gateway.test.js dist/tests/gs02.test.js dist/tests/optional-stealth.test.js
```

O fluxo scoped usa gateway real, original/cópia loopback, dois projetos e múltiplas
LPs, SMTP local, consulta autenticada no painel, respostas DNS simuladas e reinício.
A investigação não distribui agregados do hostname entre as LPs. Os testes de
investigação cobrem DIRECT_UNKNOWN antes de PAID_ATTRIBUTED, deduplicação, retenção,
datas diárias e lacuna de projeto sem atribuição. A regressão optional-stealth
preserva OFF independente de LOW/HIGH/UNCERTAIN e a política ON do PR #62, inclusive
falhas investigativas. Nenhum caminho de decisão importa a projeção administrativa.

Sem merge, deploy, migrations de produção ou ativação em domínios reais.
Revisão independente read-only `/root/copy_investigation_review` aprovada sobre
`dce0dc81a17302c8792f6462d44c37c7ae62921c`, sem P0/P1/P2 remanescentes. O único
achado concreto foi corrigido: estado do alerta respeita pausa e backlog para
revisão da migration 044. `tests/copy-notification-state.test.ts` reproduz
PENDING → SUSPENDED → REVIEW_REQUIRED e a prioridade de EXPIRED/ACCEPTED_BY_TRANSPORT,
com isolamento entre projetos e sem alterar tentativas. Revisor executou esse
teste independentemente: 1 PASS, 0 FAIL.
Delta de teste `e1e0be6297e3f076b9d372549eb4636f02a530b2` também aprovado pelo
mesmo revisor: seletor SMTP aponta para o resumo visível, sem ambiguidade com o JSON.

Gates finais no código `e1e0be6`: lint, typecheck, build, validação documental e
9 testes Python PASS. Suíte Linux Node 24.20.0/PostgreSQL 16.15/Chromium 156/Nginx
HTTPS: **101 PASS, 0 FAIL, 0 SKIP**, saída 0, 253918.830337 ms. Comando:
`HTTPS_GATE_TEST=1 GIT_DIR=/gitroot/.git npm test`; o histórico Git é montado somente
para o teste existente de rollback. Log local WSL:
`/tmp/anticlone-investigation-suite.log`, SHA-256
`fd87bbd0c0c698a8065002aa2f087df2ef1fcf37ab285c36ef473ec2e976b30c`.
A execução anterior teve 100 PASS e uma ambiguidade de seletor SMTP corrigida;
a bateria integral foi repetida. CI remota Node 22 do SHA final constará no PR.
