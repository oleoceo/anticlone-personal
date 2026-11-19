# Recuperação integrada do AntiClone Personal no Dev

O painel React está em `/admin/ui/novo/` na conexão administrativa privada. A integração parte de `58383ae`, commit inicial do PR #82 em `agent-dev`. O painel usa o mesmo acesso MFA, a mesma sessão e os mesmos controles CSRF. A recuperação integra as rotas administrativas existentes e reutiliza o domínio de evidências para a importação de metadados autorizados.

## Jornadas e evidências

| Área | Operação verificada no painel e resultado |
|---|---|
| Cadastro e instalação | Oferta e LP criadas pelo React. Publicação explícita persistiu revisão e aliases. A LP original e a cópia controladas carregaram o HTML e o CSS publicados por HTTPS privado. O gateway registrou sinais da LP oficial e deduplicou o incidente da cópia. O ensaio independente do verificador usou Docker sem rede e mediação TLS. Resultados completos, parciais e sem suporte foram persistidos conforme as condições e o React exibiu as provas por canal. |
| Incidentes, evidência e histórico | Investigação aberta pelo domínio observado, triagem auditada e importação de evidência original com autorização declarada. A atualização de recibos mostrou a proveniência administrativa. O importador recebe metadados de recurso, fonte e data, com identidade de importação estável para nova tentativa na mesma tela. |
| Políticas e CTAs | Publicar, aprovar na LP e autorizar contexto são operações distintas. A configuração pode começar na LP ou no incidente. A versão do gateway legado é selecionável na área de políticas. A cópia foi redirecionada para o destino aprovado. Após nova aprovação, dois CTAs navegavam para destinos próprios diferentes. Após suspender a autorização, a nova navegação usou o link nativo. O inventário aceita JSON e captura de loopback com revisão antes de importar. Drift comercial e nova aprovação foram exercitados no React com isolamento de pontos na suíte do gateway. |
| Alertas e saúde | Configuração SMTP, preferência e revisão de alertas pelo React. Sonda do gateway real e política de saúde persistida por projeto. O worker separado exerceu recusa TLS, falha, nova tentativa, aceite SMTP e recuperação com serviço sintético. O painel apresenta histórico e resultados da tentativa. |
| Comércio e métricas | Configuração Custom com campos ou JSON, análise de amostra, conta e webhook, vínculos por LP ou projeto, métricas HMAC legadas separadas, migração de formato com preparação, cancelamento e aceite após POST autenticado. A Visão Geral agrega sinais armazenados por dia UTC e classe declarada. Gráfico e tabela usam o mesmo resultado. Premissas do projeto e estimativas por moeda permanecem separadas das vendas reportadas. |
| Ciclo de vida e recuperação | Pausa, reativação, arquivamento, restauração e exclusão lógica exercitados com PostgreSQL. A prévia de purga lista os bloqueios do backend. O procedimento privado fica em Configurações → Saúde e operações. O ensaio executou `pg_dump` e `pg_restore` 16, comparou o manifesto e iniciou admin e gateway sobre o banco restaurado. O teste de retenção usou arquivos descartáveis. |

Os testes da jornada usam processos e schemas de teste no Dev, com Chromium real e PostgreSQL 16 rootless em loopback. A sonda de saúde mede o gateway e a conexão ao banco. Para comparar o comportamento de entrada sob pressão ou atraso, os cenários próprios de prazo mantêm a cobertura do fail-open. Na assertiva de navegação desta jornada, o relógio do Chromium fica controlado durante o redirecionamento.

O admin privado do Dev foi reiniciado e conferido em desktop e mobile. O gateway de longa duração do Dev respondeu em `PILOT_OBSERVE`. As ações de mitigação ocorreram no processo `OPERATIONAL` isolado da jornada. O gateway de longa duração recusou a rota do admin.

## Confronto visual com a V2.2

O confronto usou a referência em `/home/anticlone-dev/references/proposal-v2-2`. A galeria local em `test-results/recuperacao-integrada/final/index.html` associa as capturas reais às telas de referência. Foram verificadas entrada, lista e cadastro de ofertas, publicação e diagnóstico, investigação e ações de proteção, conversões, estimativa, alertas, configurações, contas e recuperação. As jornadas React exercitam 1440 px e 390 px, além de reflow do dashboard em 360, 768, 1024 e 1920 px. As capturas de mobile são emuladas no Chromium.

A distribuição mostra os snippets da revisão persistida e os separa da prova controlada. A navegação contextual liga a instalação a políticas, conversões e incidentes. A leitura de atividade usa barras diárias, com tabela para os mesmos registros. Os resultados por moeda e a trilha de versões mantêm os estados reais do servidor. Teclado móvel físico e leitores de tela ainda exigem homologação.

## Homologação externa e contratos

- A publicação privada do Dev usa loopback. DNS, certificado público, CSP da LP publicada, acesso externo e destinos reais dependem de homologação em origens do proprietário.
- Aceite no SMTP sintético comprova transporte. Recebimento em caixa postal real requer provedor autorizado e verificação externa. O checkout sintético prova a integração HMAC e a persistência. Provedor externo, credenciais, atribuição e confirmação de chegada continuam condicionados aos contratos existentes.
- Chaves, configuração de infraestrutura, backup, restauração e retenção de arquivos usam o terminal privado. A réplica externa de backup depende de armazenamento e política aprovados.
- Formulários seguem a decisão D07. Purga física segue D14. Os limites de identidade, ASN, operador e Stealth seguem a matriz funcional. O runtime e as migrações SQL permanecem iguais à base.

## Reproduzir

Com PostgreSQL 16 descartável em `TEST_DATABASE_URL` e Chromium disponível, execute `npm run build` e `node --test dist/tests/admin-frontend.test.js`. Para capturas, defina `TEST_FRONTEND_B_CAPTURES`, `TEST_FRONTEND_C_CAPTURES` e `TEST_FRONTEND_INTEGRATED_CAPTURES` para pastas locais. Os ensaios complementares estão em `installation-verifier.test.ts`, `provider-notifications.test.ts`, `multiple-cta-surfaces.test.ts`, `operational-journey.test.ts`, `commerce.test.ts`, `recovery.test.ts` e `artifact-retention.test.ts`. O verificador exige a imagem de teste e `HTTPS_GATE_TEST=1`. A restauração requer clientes PostgreSQL 16.

Os registros locais em `test-results/recuperacao-integrada/` incluem 12 casos React, 14 regressões de contratos, 7 casos de runtime e worker e 2 de recuperação e retenção. O Chrome dos ensaios foi Chromium 156.0.8078.4. O ensaio de rollback comercial usou o objeto Git histórico `2bf9a0417`, recuperado do GitHub após a primeira execução identificar a ausência local.

A sessão independente `revisao_integrada` verificou as fronteiras privadas, reproduziu defeitos no Chromium e aprovou as correções de comércio, evidências, restore e captura. O parecer final conferiu `git diff origin/main -- apps tests` com SHA-256 `473137bfc9594e34cc0727d39680e4e9058c169c0a8770251b68da97c5ed7caf` e encerrou a revisão local sem achados P0, P1 ou P2 pendentes.

A CI remota foi consultada no SHA publicado `58383ae1537019aedf5f12445777cd60163f215d`. O runtime Git desta sessão não oferece autenticação de escrita no GitHub. O PR #82 continua sendo a integração de referência e o delta local depende de publicação na mesma branch para rodar a CI remota. [CI publicada para a base do PR #82](https://github.com/oleoceo/anticlone-personal/actions/runs/44520797734/job/135548562722).
