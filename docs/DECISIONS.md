# Decisões técnicas locais — curtas e rastreáveis

| ID | Decisão | Motivo / evidência | Status |
|---|---|---|---|
| D01 | `AGENTS.md` é o guia único; `CLAUDE.md` importa com `@AGENTS.md`. | Evita duplicidade Codex/Claude no Windows. | APROVADA PARA INÍCIO |
| D02 | Personal single-owner e monólito modular; sem arquitetura comercial SaaS. | Objetivo e Blueprint. | APROVADA PARA INÍCIO |
| D03 | Fila/outbox durável, Postgres + Redis, como no Core Validation. | Eventos e alertas precisam resistir a falhas/reinícios. | PROPOSTA A VALIDAR NO PRIMEIRO SLICE |
| D04 | Cópias somente em ambientes autorizados no teste; stealth/risk probabilísticos. | Evidência de navegador não identifica pessoa com certeza. | APROVADA PARA INÍCIO |
| D05 | Stealth com risco alto ou explicitamente incerto prevalece sobre mitigação visível; sinais não provam identidade. | 20-POLICY-ENGINE §§8–9 e 25-INCIDENT-EVIDENCE-MODEL; sem promessa de invisibilidade perfeita. | APROVADA PARA INÍCIO |
| D06 | Ausência de atribuição é DIRECT_UNKNOWN, sem presumir operador; percentuais são seleção estável, não promessa de resultado exato por amostra. | 20-POLICY-ENGINE §§5, 10–11; esclarece o exemplo histórico em 00- O anticlone. | APROVADA PARA INÍCIO |

| D07 | Suspender interceptação de formulários no runtime; manter mapeamentos armazenados sem ativá-los no browser. | PR #18: Chromium reproduziu navegação antes de cancelamento por listener de window registrado durante submit. Redução de escopo autorizada após correções anteriores preserva envio nativo e evita redirecionar dados não aprovados; F22 formulários permanece pendente. | ESCOPO REDUZIDO; tests/form-cancellation.test.ts |

Não adicionar decisões para preferências triviais; registrar somente trade-offs com efeito de contrato, custo, operação ou segurança. Documentos SaaS não reabrem decisão sem evidência.

| D08 | Separar o prazo de entrada PAGE_REDIRECT (150 ms, fail-open) da preparacao assincrona REPLACE_CONVERSION, sem prazo global de 150 ms para CTA. | Contrato confirmado pelo proprietario no PR #36: CTA valido pode ficar pronto antes do clique; tempo nao altera risco nem percentual. Interacao precoce cancela apenas PAGE_REDIRECT e nao a preparacao pendente de CTA; abandono ou mudanca de pathname/query invalida definitivamente a decisao da navegacao. Hash no mesmo contexto continua permitido. | APROVADA PELO PROPRIETARIO; evidencias do HEAD final no PR #36 |

| D09 | Revogacao eventual de CTA: resposta aceita em ate 5 s desde o inicio; validade maxima de 120 s desde esse inicio e renovacao prevista a cada 60 s. Falha, expiracao ou mudanca de contexto preserva o original. Versoes CTA conhecidas nao retrocedem. | Decisao do proprietario para F43/GS19: respostas anteriores a revogacao podem ser aceitas antes de o navegador conhecer estado mais recente; abas suspensas podem atrasar a renovacao. Sem consulta no clique ou promessa de revogacao imediata. | APROVADA PELO PROPRIETARIO |

| D10 | Ativacao PAGE_REDIRECT scoped pelo vinculo projeto/Page ID; ponteiro global reservado ao gateway legado. Aprovar pagina nao altera versoes historicas nem outras paginas. URLs duplas continuam OBSERVE_ONLY ate remocao da antiga e nova aprovacao. | Contrato multiprojeto solicitado pelo proprietario no PR #59; transicao e limites em MULTIPROJECT-TRANSITION.md. | IMPLEMENTACAO LABORATORIAL; evidencias e revisao no SHA final do PR #59 |

| D11 | Project pause suspends operational maintenance and new notification admissions. Resume holds pre-transition backlog as REVIEW_REQUIRED, with no automatic replay or silent discard. | Owner-requested completion of pause integration; additive 044 transition audit and queue views. Prior committed admissions may finish; SMTP runs without database locks. No per-item replay endpoint added. See PROJECT-PAUSE-NOTIFICATIONS.md. | IMPLEMENTED; focused PostgreSQL/SMTP proof in tests/project-pause-delivery.test.ts; independent review recorded in STATUS.md |

| D12 | A vencida de lease CTA nao comprova encerramento do transporte. PROCESSING preserva token e tentativa ate callback; queda do worker exige revisao, sem retomada automatica. | Correcao solicitada na revisao independente: evitar envio concorrente duplicado mesmo com callback ainda vivo. Nao existe acao administrativa de resolucao; backlog anterior a pausa continua REVIEW_REQUIRED sem replay. DNS so adquire locks de persistencia depois das consultas externas. | IMPLEMENTADO; tests/pause-review-races.test.ts com PostgreSQL/SMTP reais |

| D13 | Exclusao de projeto nesta entrega e logica reversivel: exige ARCHIVED, versao, justificativa e ID:nome; restaurar retorna PAUSED. Nao ha purga fisica nem resolucao de backlog. | Continuacao solicitada pelo proprietario sem executar exclusoes reais; modo conservador explicitado antes do codigo. Auditoria transacional preserva IDs e dados dentro das retencoes existentes; sem ampliacao de coleta. | IMPLEMENTADO em laboratorio; docs/PROJECT-ARCHIVE-RESTORE.md e tests/project-lifecycle-admin.test.ts |

| D14 | LP excluida encerra URLs/vinculos/sinais exclusivamente seus; ancora inativa e evidencias imutaveis sao preservadas. Purga fisica de projeto permanece BLOCKED com catalogo de dependencias e bloqueadores reais. | Pedido exige isolamento, historico e FKs/triggers preservados. Projetos excluidos recusam escritas admin sob lock transacional; nao existe politica aprovada para apagar/desvincular auditorias, versoes publicadas e ledger financeiro. Backup nao e apagado por exclusao no banco ativo. | Implementacao/provas em SAFE-DELETION.md; fisica nao concluida |
