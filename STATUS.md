# STATUS — AntiClone Personal

## Segurança e estabilização do Dev
- PR #97 preserva o aceite FlowMembers, aliases e fail-open de 150 ms.
- S1 parcial: MFA, worker SMTP e consolidação testados com permissões restritas. Admin integral, Gateways e manutenção geral continuam bloqueadores.
- S2 e fronteira operacional S6/S7 aguardam a verificação de leoceo. S4 confirmado; atualizar recibo somente em publicação aprovada.
- S5 contém a pressão em capacidade comum e reserva lugares para contextos já aprovados. Cópias novas sem aprovação continuam expostas ao teto.
- D2 consolida eventos diários no PostgreSQL. D1 e DNS seguem sem ampliação de coleta. [Roteiro e evidências](docs/ESTABILIZACAO-SEGURANCA-DEV.md).

## F17/F20 — disponibilidade das regras por cópia no Dev
- A revisão 2 da FlowMembers publica telemetria em `static-layer.com`. O Admin em `6d00d0c` exigia o host de controle `protect.leoceo.online` nas duas confirmações e retornava `TELEMETRY_MISMATCH`.
- As confirmações usam a telemetria publicada e validam o contrato operacional. Endpoints alternativos exigem pool autorizada e revalidação transacional. O painel mostra o impedimento junto ao botão.
- O E2E histórico usava o mesmo host em ambos os lados. O DNS do Node falha localmente para o host sintético anterior. A fixture usa agora um endereço HTTPS resolvível pelos dois processos.
- A checagem do FlowMembers real é de leitura. As confirmações, o checkout sintético, a persistência e o prazo de 150 ms são cobertos pela jornada isolada em Chromium.

## F07 — seleção de endpoints por função na Instalação
- Base PR #93 `0e3e1967`, sucessora documental da release Dev `50e290c2`.
- A Instalação publica um domínio para os três papéis ou um mapa por papel; a pool operacional é revalidada na transação.
- O campo legado segue aceito. Omissão preserva as origens vigentes; novas revisões mantêm os aliases históricos acessíveis.
- A prova em `tests/runtime-distribution.test.ts` usa PostgreSQL e Chromium com HTTPS/mTLS sintético para um, dois e três domínios, elegibilidade, isolamento administrativo, contratos históricos e tempos de carga e decisão.
- Revisão independente `/root/revisao_f07` favorável ao delta após os ajustes de rótulos, padrões e cobertura. Evidências de execução e checks vinculados ao PR de implementação.

## F33 — query strings nas rotas de distribuição (PR #93)
- Gateway e probes reservados comparam o caminho até o primeiro `?`, preservando os caracteres originais do caminho.
- A regressão em `tests/runtime-distribution.test.ts` verifica recursos, métodos HTTP, rejeições e probes com e sem query, além dos contratos anteriores.
- **PR93_ALIASES_OPERATIONAL** no Dev. SHA homologado `50e290c2a9ebc62c13c57a5ee97e4a1b803df89f`, [CI oficial 45652589598](https://github.com/oleoceo/anticlone-personal/actions/runs/45652589598) com 159 testes aprovados, zero falhas e zero skips. O PR #93 segue aberto, sem merge. O commit posterior de documentação registra esse aceite.
- Suíte local completa: 142 aprovados, 6 falhas e 7 skips. Cinco falhas ambientais comprovadas: `cta-history` e `cta-observed-browser` por `libcups.so.2` indisponível (ambos passaram no reteste com as bibliotecas locais), `front3-upgrade` e `recovery` por `pg_dump` indisponível e `operational-authorization` por `ENOTFOUND gateway.test`.
- A falha de `page-redirect-journey` permanece com causa indeterminada. O clique em **CONFIRMO REDIRECIONAMENTO** expirou com o botão desabilitado. Faltam trace do painel, respostas administrativas e estado do formulário no momento da falha.

## F30 — apresentação da Visão Geral
- Quatro indicadores, origens em linhas, cliques por CTA e detalhes operacionais recolhíveis. A configuração mostra os fatores e o resultado da estimativa versionada.
- [Capturas comparativas em Chromium desktop e mobile](docs/evidencias/visao-geral/README.md) com a mesma fixture nos dois builds.
- Lint, typecheck, build e quatro jornadas do painel passaram com Chromium e PostgreSQL 16 em desktop e mobile.
- Revisão independente da interface favorável. [PR #92 e CI](https://github.com/oleoceo/anticlone-personal/pull/92), baseado no PR #91.

## F29/F30 — métricas observadas de CTA
- Dev de referência: 108 recibos CTA emitidos e zero fatos de clique. Falha histórica localizada entre emissão e persistência.
- Visão Geral com contagens, sessões distintas com clique, aliases por CTA e filtros independentes de diagnóstico.
- Chromium e PostgreSQL 16: três cliques em dois CTAs, uma sessão com clique, replay idempotente e estimativa de R$ 15,00. Nova premissa persistiu e produziu R$ 60,00.
- Migração aditiva 074 para sessões por cópia. Estimativas por projeto seguem premissas versionadas. [Contrato e rollback](docs/OBSERVED-CTA-METRICS.md).

## F21 — CTA após retorno pelo histórico
- O Bootstrap solicita decisão nova ao restaurar do BFCache, sem o cooldown de cinco segundos de uma visita bem-sucedida. Mantém backoff em falhas e destino nativo até validar a política e o digest.
- Prova em Chromium desktop e Pixel 7 emulado com BFCache ligado/desligado, três retornos, edição, suspensão, divergência de digest e falha de rede. Ver `tests/cta-history.test.ts`.
- No laboratório, o SHA base levou 4,21–4,82 s após restaurar do BFCache. O arquivo congelado reproduziu clique nativo e levou 4,01–4,64 s. A correção levou 149–190 ms na execução de referência.
- Revisão independente `/root/review` sem achados no delta do runtime. CI e SHA no [PR #90](https://github.com/oleoceo/anticlone-personal/pull/90).
- Cópias com Bootstrap remoto recebem a correção ao carregar o script atualizado. A cópia com `/js/a.js` local precisa receber um novo Bootstrap.

## PR #88 — consolidação operacional
- Redirecionamento por URL observada, destino HTTPS normalizado, percentuais por classe e confirmação direta auditada. Uma regra por cópia prevalece sobre a política antiga no mesmo contexto.
- CTA por link identificado na cópia, com edição e suspensão. A migração 072 acrescenta inventário limitado e regras versionadas.
- Jornada isolada Chromium desktop/mobile: início de navegação em 88–128 ms, atraso fail-open, edição sem reinício e restauração dos dois links nativos.
- Worker isolado: um SMTP aceito em uma tentativa para incidente novo, zero tentativas no anterior e nenhuma duplicata após recargas.
- **BLOCKED** na suíte local completa: topologia Docker rootless/portas do host. Publicação e CI oficial pendentes de login GitHub. Homologação pública pendente. [Provas e procedimento](docs/ACEITACAO-PR88.md).

## Redirecionamento e alertas na homologação Dev
- Público OPERATIONAL via mTLS e privado PILOT_OBSERVE. A LP oficial permaneceu em sua URL no Chromium.
- Política v2 autoriza só a cópia HTTPS em `/`, com direto/desconhecido em 100%. A cópia recebe HTTP 200/PAGE_REDIRECT em 275–337 ms e mantém fail-open.
- Worker Dev ativo e restrito ao projeto da LP. Brevo aceitou o teste nº 6. Preferência v6 só para eventos novos, sem tentativas nos itens anteriores.
- Admin Dev com ativação versionada e sondas. Homologação externa bloqueada pelo acesso de deploy para publicar `/js/a.js` no Vercel e repetir a navegação real.
- [Evidências e configuração](docs/HOMOLOGACAO-REDIRECT-SMTP-DEV.md).

## Sincronização do Dev com o GitHub
- O [PR #84](https://github.com/oleoceo/anticlone-personal/pull/84) integra a conciliação `71f9993` e o histórico do SHA implantado `04ea124846be851a2e8396754f765a1fe318d1e2`.
- A primeira CI passou em 148 de 149 testes. O ajuste de recuperação cobre as migrações 059–068 e conserva a prova de rollback com a fixture 069.
- A segunda CI passou no teste de recuperação e encontrou uma ambiguidade no seletor da confirmação de suspensão. O teste agora aguarda o aviso de status.
- A revisão independente `/root/review` foi favorável à integração condicionada à CI. O PR registra o resultado final dos checks.

## Homologação pública Dev — instalação e detecção
- F07/F08 e GS01/GS02/GS09. Chromium real, duas LPs de loopback e HTTPS público com PostgreSQL Dev. 18 recibos públicos e 5 fatos de sessão, com IDs e timestamps conciliados. A troca para o endpoint público preservou 7 recibos anteriores.
- Cópia controlada com Core bloqueado registrou Fallback, um incidente não verificado e uma intenção de alerta. Core e canários conservaram evidências distintas. Autorizações operacionais habilitadas: 0.
- O diagnóstico do Bootstrap passa a reconhecer a entrega recente da revisão atual. Revisão independente `/root/revisao_bootstrap` favorável ao delta funcional `b6f0c0a8ba8571266585374d112acfe4db5153ef013594cbe2a256922da87077`.
- Regressão focada 20/20 em PostgreSQL e Chromium, mais lint, typecheck, build e 10 testes documentais.
- Evidências locais em `test-results/homologacao-publica-dev/`. A navegação autenticada no Admin Dev depende da sessão MFA do proprietário. Somente um domínio público de telemetria foi disponibilizado.


## Gateway público de teste — Dev (F33)
- Unidade Dev independente em `127.0.0.1:13003`, OPERATIONAL/NPM_MTLS, mesmo PostgreSQL do admin. Smoke mTLS/Host/pins/admin passou; zero autorizações operacionais habilitadas no ensaio.
- Lint, typecheck, build, npm-boundary, dois cenários scoped Chromium/PostgreSQL e prova sintética Nginx do gate passaram. E2E operational-authorization direto parou no timeout de navegação; fixture NPM host-network indisponível no Docker Rootless.
- **BLOCKED — NPM_TRAFFIC_GATE** para o NPM instalado. O socket do Docker compartilhado recusou acesso ao usuário Dev. Clone real, bind na bridge e publicação dependem do procedimento de leoceo.
- Ajuste sobre `06f3bc9` com rollback independente e repetível, manifesto de oito arquivos e validação da unidade efetiva. `bash infra/npm/dev/test-stage.sh` PASS com falhas simuladas.
- Revisão independente `/root/gateway_review` do ajuste. E2E HTTPS direto precisa passar após a integração. [Procedimento e rollback](docs/DEV-PUBLIC-GATEWAY.md)

## Pool de telemetria
- `protect.leoceo.online` é o primeiro endpoint persistido no PostgreSQL Dev, com migração 068 aplicada. DNS e TLS respondem; `/healthz` retorna 502. Status pendente de autorização e ingresso.
- O cadastro existente verifica DNS/HTTPS/gateway sob autorização privada. Seleção explícita usa o domínio nos três papéis. Desativação preserva revisões e indica LPs atuais e históricas.
- E2E Chromium/PostgreSQL real com dois domínios sintéticos e um upstream mTLS passou. Lint, typecheck, build e broker focado passaram. Evidências em `test-results/endpoints-demo/`.
- Revisão independente `/root/gateway_review` sobre `740a0c5`. O build está no checkout de trabalho. Admin ativo e NPM foram preservados.
- Ajuste Dev sobre `4c36b00`. Seletor na instalação exibe endpoints pendentes desabilitados. Chromium com trecho da UI, uma cópia deduplicada e um alerta SMTP local aceito. Provas em `test-results/instalacao-email/`.
- SMTP configurado no Dev aceitou um e-mail de teste separado. Preferência de alertas permaneceu desativada. Publicação NPM continua pendente. Revisão independente `/root/gateway_review`.

## Hierarquia do painel V2.2
- Ajustes compartilhados de largura, cabeçalhos, formulários e navegação.
- Visão Geral com atividade e instalações lado a lado. Oferta com páginas e gestão separadas. Notificações com SMTP e logs lado a lado.
- Revisão independente `review_panel`. Provas em `test-results/painel-v22/`.

## UX V2.2 — instalação da LP
- URL oficial e contexto ficam no início da instalação. Os trechos publicados têm orientação para HTML, React/Vite e WordPress.
- O atalho por teclado leva ao diagnóstico. A revisão e a rotação continuam no painel técnico.
- Revisão independente `ux_review` aprovada. Prova no Chromium com PostgreSQL em `test-results/ux-installation-v22/`.

## Logs de e-mail pelo React — Dev
- Histórico de testes SMTP e alertas de cópia, CTA e saúde, com filtros por resultado e até 100 tentativas dos últimos 30 dias.
- SMTP manual reserva uma linha antes do envio e registra o resultado sem chaves, corpos ou respostas brutas.
- Revisão independente `logs_review` aprovada no delta de código `f1c2c6632790d5eea5f1ab02d1d737b2d140b775ba4bcc01b35427bcd9cf580e`.
- Provas em `test-results/smtp-logs/`; documentação em [Transporte de alertas](docs/CLONE-SMTP.md).

## Credenciais SMTP pelo React — Dev
- Login e chave cifrada no painel; teste de conexão autenticada e envio de teste confirmado separadamente.
- Gateway e worker usam a revisão salva e respeitam a preferência de alertas. O endpoint é autorizado no ambiente privado.
- Chromium/PostgreSQL e receptor TLS controlado cobrem cadastro, conexão, envio, worker e retry. Evidências em `test-results/smtp-painel/`.
- Brevo respondeu via STARTTLS e recusou a chave de teste com SMTP 525. Alertas permanecem desativados.


## Homologação operacional Dev — alerta de cópia F26
- Em 20/11/2026, o gateway público persistiu os sinais da LP C e da cópia controlada no PostgreSQL Dev. Incidente 10, outbox 10, uma tentativa aceita pelo Brevo.
- A mensagem entregue ao transporte descreve a suspeita e o host. A correção inclui o ID do incidente e o projeto no alerta, preservando o Message-ID vinculado ao outbox.
- A regressão com PostgreSQL, Chromium e SMTP TLS exercita resposta 451, retentativa, destinatário e uma única mensagem capturada. O recebimento externo depende da conferência da caixa autorizada.
- Revisão independente `revisao_alerta` favorável ao delta funcional `ac475666c3a4`. A correção segue em branch de trabalho para CI e futura aplicação no Dev.

## Auditoria V2.2 no Dev — PR #82
- Visão Geral com gráfico e tabela sobre a mesma série UTC, origem declarada e estimativa detalhada por projeto.
- Configurações testa TLS e autenticação SMTP; Saúde identifica o perfil retornado pelo gateway.
- Revisão independente `revisao` aprovou o delta funcional após exigir erro `EAUTH` na prova sem AUTH.
- Resultados, evidências e limites de homologação em [Auditoria operacional V2.2](docs/AUDITORIA-V22-DEV.md).

## Sessão do admin privado Dev
- O painel da porta 3002 usa sessão de navegador sem prazo fixo. Senha e TOTP continuam exigidos na entrada.
- Logout, novo login e reinício revogam a sessão. O prazo padrão e o token bearer mantêm 15 minutos.
- Quatro testes de autenticação passaram, incluindo Chromium com oito horas simuladas. Revisão independente `revisao_sessao_dev` favorável ao delta funcional.

## Recuperação integrada Dev — PR #82
- React V2.2 no admin privado com proteção por LP, captura de CTA local, evidência autorizada, atividade diária, migração de checkout e vínculos por projeto.
- Jornadas em PostgreSQL 16/Chromium, gateway privado com LP original e cópia, worker SMTP TLS sintético e backup/restore isolado. Evidências em test-results/recuperacao-integrada/.
- O estado das 45 capacidades e o contrato de Stealth seguem a matriz. Homologação externa e recuperação privada em [Recuperação integrada](docs/RECUPERACAO-INTEGRADA-DEV.md).
- Revisão independente `revisao_integrada` favorável ao delta final identificado no relatório.
- CI remota verde na base 58383ae do PR #82. A publicação do delta local depende de autenticação no GitHub.

## Recuperação operacional Dev — publicação e diagnóstico da primeira LP
- F07/F08 e GS01. Prontidão e bloqueadores por LP, revisão persistida, snippets e diagnóstico com prova por camada e sinais separados.
- React V2.2 preserva navegação e integra a configuração e o histórico de saúde à sessão privada. Gateway local usa sonda HTTP opt-in.
- Os cenários usam PostgreSQL e Chromium reais. A prova controlada usa Docker sem rede, mediação TLS, origens controladas e o mesmo contrato de diagnóstico.
- DNS, TLS público, SMTP e worker externo dependem de configuração e autorização próprias. F07/F08 e a matriz mantêm os estados de homologação externa.
- Revisão independente em sessão separada. Commit e CI registrados na branch e no PR de trabalho.

## Frontend V2.2 — Entrega C
- Fechamento A+B+C no PR #81. Confirmações de URL e contagens corrigidas no frontend, com regressões integradas. Sequência de integração e checklist de homologação documentados.
- Base 64ad977, branch feat/admin-frontend-completion. Visão Geral usa relatórios existentes, com cliques, estimativas e vendas por moeda, projetos, incidentes e diagnóstico por LP.
- Configurações integra SMTP, preferência de envio, revisão de alertas, modelos, contas e webhooks. A gestão inclui URLs, pausa, reativação, arquivo, exclusão e restauração de projeto.
- Playwright desktop/mobile e regressões A+B+C com PostgreSQL isolado. Lint, typecheck e build. Revisão independente `/root/b_review` com correções de rascunho, cancelamento e interação mobile.
- Galeria local em `docs/design/frontend-entrega-c/`. Paridade parcial, lacunas e retorno ao painel anterior em [ADMIN-FRONTEND-C](docs/ADMIN-FRONTEND-C.md). Sem mudança de API, migrations ou VPS.

## Frontend V2.2 — Entrega B, operações a partir de incidentes
- Refinamento visual no PR #80: resultado financeiro no formulário, resumo de destinos de CTA e estado/escopo da proteção. Consultas existentes, sem mudança no servidor. Nove testes integrados passaram, com Chromium em desktop e mobile emulado. Revisão independente `/root/b_review` favorável ao delta.
- Base c35180e, branch feat/admin-frontend-protection. Incidentes, triagem, PAGE_REDIRECT, REPLACE_CONVERSION, inventário de CTAs, estimativas e vínculos usam APIs administrativas reais.
- Publicação, aprovação da LP e autorização são etapas distintas. Autorização React confere a aprovação esperada sob lock; clientes legados seguem compatíveis.
- E2E desktop/mobile com PostgreSQL e Chromium passou, incluindo aprovação concorrente HTTP 409 sem escrita, superfície de outra LP, premissas e isolamento comercial.
- Lint, typecheck e build passaram. Revisão independente `/root/b_review` favorável após correção dos achados no delta de proteção.
- 16 capturas reais na galeria local `docs/design/frontend-entrega-b/`; mobile emulado. Painel antigo disponível. Contrato e limites em [ADMIN-FRONTEND-PROTECTION](docs/ADMIN-FRONTEND-PROTECTION.md).

## Frontend V2.2 — Entrega A, base operacional — PR #79
- React/TypeScript/Vite em `/admin/ui/novo/`, sessão privada compartilhada com painel antigo, histórico, projetos e instalação por LP.
- Cadastro de projeto usa UUID por intenção, chave primária e auditoria transacional. Equivalentes retornam 200 com a mesma identidade. Divergências retornam 409. Clientes sem chave seguem suportados.
- Queda após commit e antes dos cabeçalhos: Chromium enviou dois POSTs e o servidor manteve um projeto e uma criação auditada. LP: 200 e 409, uma LP/URL e retomada na instalação.
- 20 testes com PostgreSQL/Chromium, incluindo 7 da nova interface. Lint, typecheck e build passaram.
- Revisão independente em `/root/review_entrega_a`, CI por SHA no PR em rascunho. Contrato e cobertura restante em [ADMIN-FRONTEND](docs/ADMIN-FRONTEND.md).

## PR #78 — P1: limites NPM obrigatórios
- Base revisada 07120c0; mesma branch/PR, somente fragmentos NPM, fixtures/testes e documentação; apps/runtime/SQL/HTTPS direto intactos.
- Zonas HTTP exclusivas com chave vazia fora do hostname; admissão no server AntiClone (inclui fallback): 2 req/s, burst20 nodelay, 10 ativas/IP,429 e dry-run off.
- Fixture NPM independente;429 não abre TCP/TLS nem envia HTTP upstream, inclusive no fallback;10 ativas/11a429 e outro host preservado.
- Foco6/6 PASS,0 skips; regressão direta e NPM/SSH/monitor PASS; lint/typecheck/build, documental e Python10/10 PASS.
- Gate NPM_TRAFFIC_GATE exige hook HTTP, diff completo, nginx -t/-T e prova no clone antes de publicar; sem suporte seguro, BLOCKED.
- Nova revisão /root/npm_p1_review favorável, sem P0/P1/P2; hashes/evidências em DECISIONS e runbook; CI final por SHA no PR #78.
- Node/Cloudflare complementares, sem substituir admissão pré-upstream. Sem VPS/CF/NPM reais, merge ou mudança de mitigação/150ms/autenticação.

## NPM/VPS — F33, administração privada e monitor — PR #78
- Base 4e7d5a8; Compose independente, gateway mTLS na proxy, PG privado, admin loopback/socket SCRAM e worker fora da proxy.
- Foco corrigido 5/5 PASS: perfis direto/NPM, CF simulado/DNS only, PAGE_REDIRECT 100/151 ms, SSH/MFA/CSRF/replay/cookie/logout e monitor.
- Restores com ferramentas PG16: 2/2 PASS, upgrade 001–064 e rollback; runtime/políticas/migrations intactos.
- Integral local c9d4ddf: 132 PASS/1 FAIL no harness; saturação da fixture Nginx corrigida em b1c57b2 sem alterar limites/150 ms.
- CI anterior: cliente PG18 incompatível com servidor16; wrapper CI-only fixa16. Lint/typecheck/build PASS; regressão oficial final por SHA no PR #78.
- Revisão independente /root/npm_review favorável ao código e deltas, sem P0/P1/P2; hashes/evidências em DECISIONS e NPM-VPS-RUNBOOK.
- Sem merge/deploy/VPS/DNS/NPM externo/SMTP real; homologação externa pendente. OPERATIONAL não autoriza LPs; runbook e rollback preparados.

## Hotfix CI pós-merge #76 — F17/F18
- Base 1c43a9f; branch única fix/ci-entry-deadline; somente harness e evidências em docs/CI-HOTFIX-PR76.md.
- Árvores aprovada/pós-merge idênticas; shadow tardio preservou página corretamente; causa histórica específica do optional segue inconclusiva.
- Classificação pontual/tardia exige decisão/destino e efeito correto; negativos reais, positivo real existente e prazo150ms preservados; sem skips/timeouts maiores.
- Foco PG/Chromium5/5 e regressão F18/redirect7/7 PASS; baseline original4/4 PASS; lint/typecheck/build, documental e Python10/10 PASS.
- Revisão independente read-only /root/diagnosis; corrida no novo clique CTA corrigida por sincronização com refresh processado.
- CI oficial verde no SHA final é gate obrigatório; sem merge/deploy/infra/Stealth ou políticas modificados.

## Preparação VPS real — base d306459 / PR #76
- Roteiro: docs/VPS-REAL-PREPARATION.md; modelos privados sem segredos em docs/vps-models; F03/F07/F38 sem reclassificar a matriz.
- OPERATIONAL multiprojeto, admin MFA/SSH, aliases por LP, SMTP/worker, sequência A–G e backup/rollback documentados; nenhum código funcional alterado.
- PostgreSQL16 descartável com initdb real: 63 SQL até064, 87 tabelas e oito sentinelas/coluna064 PASS; Compose config --quiet PASS.
- Lint/typecheck/build e validação documental PASS; sem nova auditoria/suíte extensa das 45 funções.
- Revisão read-only favorável à preparação; P2 do proprietário sobre chave mestra compartilhada admin/gateway/provisionamento documentado; CI final no PR #76, sem merge.
- VPS/DNS/TLS público/LP/SMTP/caixa/checkout NOT_VERIFIED; execução depende de autorização explícita e acessos privados do proprietário.

## PR75 — correções da revisão sobre 2bf9a04
- Mesma branch/PR; moeda/expoente validados por allowlist ISO, sem retroconverter históricos; saldos incompatíveis ficam indisponíveis.
- Migration064 aditiva: preparar/testar HMAC/confirmar migração da mesma conta; formatos legados preservados, versão/intenção assinadas e dedup canônica.
- Seletores e editor guiado com aliases preservados; amostras exibem caminhos de vocabulário seguro, sem payload bruto/valores/chaves privadas.
- SHA512/timestamp é a extensão fechada; PAID→CANCELLED sem estorno deixa líquido incerto. Sem homologação de marcas/API/atribuição/chegada.
- Foco PG/Chromium 5/5 PASS; dinheiro BRL/USD/JPY/KWD/BHD, concorrência, atraso, backfill, binário2bf9a04 sobre064 e formulário inválido. Regressão Linux integral e CI final por SHA no PR.
- Revisão independente /root/pr75_revision_review favorável, foco próprio5/5 PASS, sem P0/P1/P2 pendente; hashes/provas no contrato. Sem merge/deploy/credenciais reais/migrations de produção.

## F29/F31 — Custom multiprovedor — PR #75
- Base fdcc453 (#74); branch única feat/f29-f31-multiprovider; sem merge/deploy/contas externas ou migrations de produção.
- Catálogo global imutável, contas criptografadas, vínculos versionados, HMAC Custom, ledger/dedup/estornos e relatório F30 por moeda.
- Foco PG/Chromium10/10, Linux commerce/upgrade3/3 e jornada/F18/GS06 corrigido5/5 PASS; lint/typecheck/build PASS. CI inicial126/1; correção só no harness revisada; CI final por SHA no PR75.
- Revisão independente /root/commerce_review favorável ao delta funcional, sem P0/P1/P2 pendente; hashes/provas em docs/F29-F31-MULTIPROVIDER.md e PR.
- Chegada confirmada, atribuição verificável, API externa e estornos parciais não suportados; checkout real depende de contrato/credenciais autorizados.
- F29/F31 integrais não declaradas concluídas; limites/matriz em docs/F29-F31-MULTIPROVIDER.md. PR75 consolidado; sem autorização de merge.

## Hotfix CI shadow apos #72
- Base 3ec1796; branch fix/ci-shadow-entry-deadline; escopo exclusivo do harness, sem runtime/politica/migration/infra alterados.
- CI 43080387939 confundia PAGE_REDIRECT no replay com entrega dentro dos 150 ms; tempo inclui Core e buffering route.fetch/body/fulfill.
- Matriz ON/OFF com relogio controlado e sem interceptacao; transporte real direto e retencoes de 250 ms comprovam navegacao/fail-open/CTA/original.
- Foco PostgreSQL/Chromium 2/2 PASS; direto JSON43,6ms < prazo164,7ms; servidor/replay atrasados JSON293,5/301,5ms, sem page redirect tardio.
- Cabecalho forjado na API de refresh preserva teste de entrada nao confiavel sem preflight artificial ou ampliacao CORS. F13/F14 continuam shadow, sem veto novo.
- Revisao independente, regressao integral e CI oficial do SHA final registradas no PR do hotfix; nao tratar gates pendentes como PASS. Sem merge/deploy/operacoes externas.

## Nucleo operacional apos estabilizacao CI
- Base 8834bf3 + PR tecnico #71 verde em 29c2a06; branch consolidada fix/operational-core-closure, sem merge/deploy.
- Defeito comprovado: consulta/mapping CTA no painel recusava HTTPS; alinhada ao contrato existente. Importacao manual original preservada.
- Jornada continua desktop/mobile 2/2 PASS em laboratorio: projeto/LP, runtime, incidente, SMTP falha/retry/processos novos, destinos, 0/50/100/classes, suspensao/recuperacao.
- F37/F38: retencao configuravel plan/apply so em arquivos sinteticos; preserva latest/verificado, recibo de restore real; foco retention/recovery 2/2 PASS.
- Delta suplementar de canarios/CSS e viewport, regressao integral, revisao final e CI por SHA devem ser conferidos no PR consolidado; nenhum gate pendente e chamado PASS.
- Matriz: 23 laboratorio / 4 incompletas / 14 homologacao / 4 bloqueadas. F18/F25/F29/F31 permanecem; D07 e shadow #69 preservados.
- Limites/decisoes reais: LPs/destinos, SMTP, prazos/armazenamento/offsite e ambiente autorizado; docs/OPERATIONAL-CORE-CLOSURE.md. Nenhuma migration 062/conta externa/operacao de producao.

## Estabilizacao CI apos #69
- Base obrigatoria 8834bf3; PR tecnico #71; #70 fechado/Draft preservado, sem migration 062 ou ingestao experimental.
- Falha 43045087835: DNS Ubuntu durante apt antes dos testes; Chromium agora instala sem apt, com smoke real obrigatorio.
- Revisao independente /root/ci_review favoravel ao codigo 2c4ef1d, sem P0/P1/P2; diff-check e validacao documental PASS.
- CI oficial e SHA final devem ser conferidos no PR #71; nenhum merge/deploy/DNS/SMTP externo/migration de producao autorizado.


## F13/F14 — avaliador shadow e perfil investigativo
- Base ab8c7bd (main após #68), branch feat/f13-f14-shadow; investigação ON/OFF separada do veto, v2/legado preservados.
- Código: operator-shadow-v1, perfil autenticado grupo/sessão, snapshots imutáveis/limitados e migration aditiva 061 apenas laboratorial.
- Prova focada: 5/5 PASS, zero falhas/skips, PostgreSQL16/Chromium156; upgrade/restore, v2, snapshots, tempo e locks reais. Regressão integral e CI final por SHA no PR.
- V3 apenas proposta interna opt-in; sem publicação/ativação. Rede/comportamento/geografia indisponíveis, sem coleta nova invasiva.
- F13/F14 permanecem bloqueadas por ausência de fonte operacional de sessão e calibração de campo; contagens da matriz preservadas.
- Revisão independente /root/shadow_review favorável ao delta final, sem P0/P1/P2 pendente; módulo SHA256 AC84C436, teste 8DE3D894. Métricas reais FP 0/6 e FN 4/4; fixture separada FN 3/4.
- Sem merge/deploy/DNS/custos novos/migrations de produção; contrato, reprodução e limitações em docs/F13-F14-SHADOW.md.
- **Frente 1:** PR #66, SHA 3683e5d, revisão independente favorável e CI oficial verde (42899056739); sem merge/deploy.
- **Frente 2 F27/F45:** SMTP privado TLS para CTA/saúde, tentativas duráveis, revisão auditada do backlog e worker/monitor local independente; base 3683e5d, branch feat/pre-vps-front2.
- **Prova focada:** provider-notifications 2/2 PASS, 0 falhas/skips/exit0; PostgreSQL/Chromium/SMTP TLS, retry/reinício, recuperação do backend, MFA/CSRF, concorrência e SIGTERM. UNKNOWN preservado sem takeover.
- **Gates:** regressão Linux 114 Node + 10 Python PASS, 0 falhas/skips; lint/typecheck/build/Docker/Compose exit0. /root/front2_review favorável a 032d9a4 e delta documental af38a3f; sem P0/P1/P2. CI oficial e estado pronto por SHA no PR #67.
- **Matriz:** 13 laboratório / 16 incompletas / 12 homologação externa / 4 bloqueadas; 1 crítica, 21 altas, 10 médias. F27/F45 aguardam recebimento externo, não declaradas concluídas integralmente.
- **Limites:** aceite SMTP não prova caixa postal; monitor observa apenas backend loopback. D05 invisibilidade, D07 formulários, auditoria completa F34 e compatibilidade continuam pendentes.
- **Operação:** migrations 057/058 apenas em teste isolado; sem deploy/DNS/segredos externos/migrations de produção. Provas e configuração em docs/PRE-VPS-FRONT2.md.

## Frente 3 - fechamento funcional pre-VPS
- Base f95e9da; branch unica feat/front3-pre-vps; sem merge/deploy/DNS/segredos/migrations de producao.
- Cadastro auditado/atomico, metadados de alteracoes 059/060, retencao, filtros/navegacao/CSS CSP desktop/mobile e chave webhook impar recusada.
- Foco 5/5 PASS, zero falhas/skips: HTML/React-Vite/WordPress real, canais/CSP/sandbox/file/offline, duas ofertas/superficies, carga, upgrade/restore/rollback f95e9da.
- Matriz:22 laboratorio/6 incompletas/13 homologacao/4 bloqueadas; pendencias1 critica/16 altas/6 medias. F18/F25/F29/F31/F37/F40 incompletas, D05/D07 preservadas.
- Revisao independente /root/front3_review favoravel a687f11d e delta CSP, sem P0/P1/P2 pendente; parecer final/checks por SHA no PR68.
- Regressao local39b0b14:118 Node+10 Python PASS,0 falhas/skips; lint/typecheck/build/Docker/Compose exit0. CI oficial do SHA final conferida no PR68; provas/limites em docs/PRE-VPS-FRONT3.md.

## F25/F18 — fechamento laboratorial após PR #73
- Base e8dd1c6; branch feat/f25-f18-closure; código 863be6d; um PR consolidado, sem merge/deploy/produção.
- F25: termos estruturados revisados, UNKNOWN, drift/alerta por ponto, legado e reaprovação auditada D15; F18: gate opt-in, deadline 150 ms e medidas reais desktop/mobile.
- Foco 6/6 PASS; integral 125 Node + 10 Python PASS, zero falhas/skips; lint/typecheck/build/Docker/Compose/PostgreSQL16/Chromium/HTTPS/restore/rollback exit0.
- Revisão independente /root/f25_f18_review favorável a 863be6d, sem P0/P1/P2 pendente; delta posterior de testes/documentação, revisão/CI final por SHA no PR.
- F18/F25 concluídas em laboratório: matriz 25 laboratório/2 incompletas/14 homologação/4 bloqueadas; pendências 1 crítica/15 altas/4 médias; agregado histórico corrigido pelas linhas Fxx.
- Homologar LPs, CSS/dispositivos/redes, checkout/WhatsApp e alertas externos reais; sem inferir oferta/preço hostil, sem formulário D07, sem invisibilidade prometida.
- CI main 43098539403 intocada; PR74: run43218675626 124PASS/1FAIL na sonda literal150, corrigida sem mudar Stealth; foco ampliado8PASS, nova CI final exigida. Provas/limites: docs/F25-F18-CLOSURE.md.

## PR75 — P2 exclusao da amostra legada
- Base 784dcd5; limpeza em 064 restrita a legacy_model_version; rotacao connection-wide preservada.
- Teste PostgreSQL cobre legado expirado, v2 valida preservada, commit de migracao e rotacao invalidando tres versoes.
- Revisao independente /root/p2_review favoravel ao delta SQL/teste, sem P0/P1/P2; achado no preparo do teste corrigido.
- Regressao Linux e CI oficial do SHA final: resultados e links registrados no PR75; nao presumir sucesso antes dos checks.
- Sem merge/deploy/credenciais reais/migrations de producao; restante do PR preservado.


## F26 — alerta de cópia no PR #83
- O proprietário confirmou o recebimento do incidente 10 na caixa de entrada durante a homologação Dev. A mensagem anterior trazia apenas uma observação não verificada e o host.
- O provedor SMTP gera HTML e texto em português, com contexto do incidente e rota relativa do Admin Dev. LP depende de recibo recente que a associe ao projeto e host.
- Validação reproduzível em `tests/smtp-provider.test.ts`: conteúdo, escaping, triagem, isolamento, TLS, histórico e retry. Aplicação ao Dev e integração dependem de aprovação.

### Descoberta e substituição de CTA por cópia
- Branch feature/cta-discovery sobre 88dc70a. Cartões por CTA, alocação por classe e migração aditiva 073.
- Compatibilidade, implantação e rollback em [Descoberta e substituição de CTA](docs/COPY-CTA-DISCOVERY.md).
- Ensaios locais com Chromium e PostgreSQL. A LP pública foi exercitada com respostas isoladas no navegador e destinos de teste.
- O bootstrap congelado da cópia recebeu políticas compatíveis com seu código. Deploy e merge dependem de etapa posterior.

## F07 — domínios de distribuição e aliases compactos
- Base Dev PR #92, `d55fbb7`. Cadastro reaproveitado com diagnóstico na rota compacta, bloqueio de publicação e autorização privada.
- Migrações 075–077 e flag privada de emissão. Revisões novas usam sufixo aleatório de 80 bits no nome, com compatibilidade histórica.
- Chromium/PostgreSQL focal 3/3 em duas origens HTTPS sintéticas. Nginx, regressões e revisão do SHA final ficam registrados no PR.
- Aceite Dev controlado no SHA homologado da F33. Dois Gateways saudáveis na release imutável e **15 revisões v2 preservadas** (7 privadas e 8 públicas), verificadas com e sem query (`history.json`).
- Contrato 4 validado via Cloudflare na revisão sintética 1 da instalação `4bd1fd84-fac4-47d6-b5e3-f4a28c6592c6`. Probe, scripts, GIFs, telemetria, sessão e CTA passaram. O clique foi persistido e a LP original foi preservada (`synthetic.json`).
- `RUNTIME_COMPACT_ALIASES=false` durante a atualização e o aceite. Após a aprovação, `RUNTIME_COMPACT_ALIASES=true` confirmado no novo PID `1101004` do Admin Dev (`admin-activation.json`).
- Publicação e rollback em [NPM-VPS-RUNBOOK.md §11](docs/NPM-VPS-RUNBOOK.md#11-adicionar-um-domínio-de-distribuição). O aceite cobre somente o cenário sintético no Dev. A homologação do segundo endpoint permanece pendente.
