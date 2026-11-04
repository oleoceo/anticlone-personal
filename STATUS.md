# STATUS — AntiClone Personal
- **Qualidade do processo:** gate documental verifica codificação e declarações explícitas de situação; testes no workflow existente. Revisão independente e CI final registradas no PR.
- **PR #23, ajuste do gate:** detecta interrogações repetidas entre letras em prosa; testes isolam substituição Unicode, mojibake, interrogações e UTF-8 inválido, preservando perguntas e código Markdown. Revisão do delta e CI do novo HEAD registradas no PR; sem merge/deploy.
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
