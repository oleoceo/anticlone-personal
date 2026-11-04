# STATUS — AntiClone Personal
- **PR #30 — fechamento documental:** expiração F26/F27 de 24 horas em `tests/notification-expiry.test.ts`; 35 testes passaram na execução consultada de `d169dba`, revisado independentemente. HANDOFF exige parada dos processos antigos, migrações 019 → 020 e reinício somente das versões novas. Conclusão formal da CI, gates do novo HEAD e revisão independente do delta documental serão conferidos no PR antes de retirar Draft. F26/F27/GS13 permanecem incompletos; sem merge/deploy/envio externo.
- **PR #29 safety delta:** exhausted SMTP_LOCAL leases are swept at most once per minute per pool even during budget backoff; missing singleton fails closed for F26/F27 without recreation. PostgreSQL regressions: `tests/notification-budget-safety.test.ts`; local lint/typecheck/build passed. Independent isolated review and final HEAD CI are recorded in PR #29; Draft until both gates pass. No merge/deploy.
- **GS13 partial - shared budget in development:** F26/F27 share a PostgreSQL limit of 10 reservations per 60 minutes and three attempts per alert. The flows can compete for capacity; uncertain acceptance can cause duplicates. No exactly-once guarantee; F26/F27 backlog expires after 24 hours (PR #30). PostgreSQL tests, independent review and CI are tracked in the PR; GS13 remains incomplete.
- **PR #28, edição pendente:** habilitação bloqueada até salvar os seis campos; orientação visível, edição e desativação preservadas. Regressão Chromium em `tests/admin-notification-ui.test.ts`; lint/typecheck/build locais aprovados. Teste local depende de `TEST_DATABASE_URL` ausente; execução PostgreSQL/Chromium, SHA final, revisão independente e worktree serão registrados no PR. Sem alteração de envio, autenticação ou contrato PostgreSQL; sem merge/deploy.
- **Interface local de notificações:** configuração global e preferência sem envio real; testes em `tests/admin-notification-ui.test.ts`. CI PostgreSQL/Chromium passou em 2f7d3e6; revisão independente e CI do HEAD final constam no PR. F26, F27 e GS13 permanecem inalterados.
- **PR #27 delta:** repeated disable is a transactional no-op; regression checks response, persisted state/version/timestamp and complete audit. Local lint/typecheck/build passed; PostgreSQL execution, independent isolated review and final HEAD CI evidence are recorded in PR #27. No worker or delivery changes.
- **Global notification settings - laboratory:** authenticated, versioned API with atomic audit and explicit preference; no credentials or delivery integration. Test: `tests/notification-settings.test.ts`; independent review and final CI will be recorded in the PR. F26 planned, F27 partial, GS08/GS13 pending; D03 remains proposed.
- **Qualidade do processo:** gate documental verifica codificação e declarações explícitas de situação; testes no workflow existente. Revisão independente e CI final registradas no PR.
- **PR #23, ajuste do gate:** detecta interrogações repetidas entre letras em prosa; testes isolam substituição Unicode, mojibake, interrogações e UTF-8 inválido, preservando perguntas e código Markdown. Revisão do delta e CI do novo HEAD registradas no PR; sem merge/deploy.
- **F27 PARCIAL — laboratório:** SMTP exclusivamente em loopback e desabilitado por padrão; histórico simulado preservado, aceitação local distinta de entrega final. Testes: `tests/cta-delivery.test.ts` e `tests/cta-local-smtp.test.ts`; entrega externa e GS08/GS13 integrais pendentes.
- **F27 consulta:** GET autenticado `/admin/projects/:id/cta/alerts`, até 100 alertas por projeto, mais recentes primeiro (desempate por ID); envio e retry pendentes.
- **F27 PARCIAL — PR #21:** alerta persistente por transição de CTA mapeado a revisão, deduplicado até reaprovação; retenção de 30 dias. Envio e retry pendentes; GS08/GS13 integrais pendentes. Evidências: tests/cta-inventory.test.ts e CI 41752363089 (4c6a848); revisão final e CI do novo HEAD publicadas no PR #21.
- **F25 parcial — PR #20:** reaprovação manual autenticada de âncora em revisão, com confirmação da observação e auditoria transacional; revisão Codex independente sem P0/P1/P2 remanescentes (evidência em `docs/PR20-REVIEW.md`). CI aprovada no código `6c56b70`, run 41750058855; resultado do HEAD documental final publicado no PR. GS08 integral e alertas pendentes; sem merge/deploy.
- **F25 anterior:** comparação de URL observada em âncora mapeada, revisão somente do ponto; GS08 integral pendente.

- **F22 formulários suspensos (D07):** P2 residual reproduzido em Chromium; interceptação removida, envio nativo preservado. Regressão Chromium, lint, typecheck e build passaram; revisão Codex read-only sem P0/P1/P2. CI final registrada no PR #18; GS07/GS10 completos pendentes.
- **D07 decisão ativa:** somente âncoras contam no limite de 100; formulários continuam armazenados. Regressão PostgreSQL em `tests/cta-decision.test.ts`; revisão do delta e CI final no PR #18.

- **F22 parcial em PR:** âncoras tardias, pop-up e SPA no pathname autorizado em laboratório; GS07/GS10 integrais e formulários pendentes. Chromium/PostgreSQL em `tests/f21.test.ts`; revisão Codex independente sem P0/P1/P2 após correções; CI final pendente.

- **Estado:** GS02 e GS06 demonstrados em laboratório; detecção experimental.
- **F01/F34 parciais:** projetos locais e autenticação com TOTP testados; faltam requisitos de produção e auditoria.
- **F04/F05/F06/F09 parciais:** Core, fallback e canários testados em laboratório; compatibilidade e GS09 completo pendentes.
- **F17/F18 parciais:** GS06 comprovou destino aprovado e LOW local; espera limitada e fail-open testados, sem gate visual completo.
- **F43 parcial:** publicação autenticada, versões imutáveis e ativação transacional testadas em laboratório; motor geral de precedência, fases de interação, demais cenários de GS19 e classificador pendentes. Políticas legadas exigem republicação.
- **F15/F16 parciais:** classificação declarada em laboratório, com fonte e incerteza; presença diária, sem corroboração nem GS04 completo.
- **F23/F24 parciais:** PAGE_REDIRECT e sessao efemera testados em laboratorio; GS04 completo e outras acoes pendentes.
- **Retenção:** observações 7 dias; incidentes inativos e alertas 30 dias.
- **Revisão e CI:** revisão independente sem bloqueio para laboratório; CI 41719646208 aprovado no commit 258fa28.

- **F13/F14 em desenvolvimento:** avaliador conservador de laboratório e OBSERVE_ONLY; GS05 integral e classificador operacional pendentes.

- **F19/F20/F41 parciais:** inventario e mapeamento manual em laboratorio; testes de navegador e PostgreSQL na CI 41726344521 (13c051e); revisao independente sem P0/P1 remanescente. GS03/GS17 integrais e descoberta dinamica pendentes.

- **F21 parcial:** ancoras estaticas aprovadas em laboratorio; PostgreSQL e Chromium na CI 41730953550 (b79f29b), GS03 integral e F22 pendentes. Revisao independente do codigo em /root/f21_review; parecer condicionado a CI final.
