# Decisões técnicas locais — curtas e rastreáveis

F29/F31 multiprovedor (base #74): [contrato e limites](F29-F31-MULTIPROVIDER.md).
Conforme pedido do proprietário, catálogo global, conexão de conta e vínculo por
projeto são separados; modelos aprovados são imutáveis e conexões só avançam de versão pelo fluxo revisado/testado da revisão PR75, preservando os formatos anteriores. Painel atual preservado por D16. Nenhuma atribuição comercial é inferida de
referência recebida ou exclusividade do checkout. F29/F31 integrais mantêm suas
lacunas enquanto não houver instrumento/cadeia verificável. HMAC legado não é
importado/somado automaticamente: falta identidade de conta confiável para deduplicação.

| ID | Decisão | Motivo / evidência | Status |
|---|---|---|---|
| D01 | `AGENTS.md` é o guia único; `CLAUDE.md` importa com `@AGENTS.md`. | Evita duplicidade Codex/Claude no Windows. | APROVADA PARA INÍCIO |
| D02 | Personal single-owner e monólito modular; sem arquitetura comercial SaaS. | Objetivo e Blueprint. | APROVADA PARA INÍCIO |
| D03 | Fila/outbox durável, Postgres + Redis, como no Core Validation. | Eventos e alertas precisam resistir a falhas/reinícios. | PROPOSTA A VALIDAR NO PRIMEIRO SLICE |
| D04 | Cópias somente em ambientes autorizados no teste; stealth/risk probabilísticos. | Evidência de navegador não identifica pessoa com certeza. | APROVADA PARA INÍCIO |
| D05 | Stealth opcional e independente por política publicada: OFF ignora LOW/HIGH/UNCERTAIN; ON suprime evidência forte verificável de possível operador; UNCERTAIN não suprime por padrão. Segurança e autorização sempre prevalecem. | Decisão atualizada do proprietário, 2026-11-09; contrato e migração em OPTIONAL-STEALTH.md. | APROVADA PELO PROPRIETÁRIO; ENTREGA SOMENTE LABORATORIAL |
| D06 | Ausência de atribuição é DIRECT_UNKNOWN, sem presumir operador; percentuais são seleção estável, não promessa de resultado exato por amostra. | 20-POLICY-ENGINE §§5, 10–11; esclarece o exemplo histórico em 00- O anticlone. | APROVADA PARA INÍCIO |

| D07 | Suspender interceptação de formulários no runtime; manter mapeamentos armazenados sem ativá-los no browser. | PR #18: Chromium reproduziu navegação antes de cancelamento por listener de window registrado durante submit. Redução de escopo autorizada após correções anteriores preserva envio nativo e evita redirecionar dados não aprovados; F22 formulários permanece pendente. | ESCOPO REDUZIDO; tests/form-cancellation.test.ts |

Não adicionar decisões para preferências triviais; registrar somente trade-offs com efeito de contrato, custo, operação ou segurança. Documentos SaaS não reabrem decisão sem evidência.

| D08 | Separar o prazo de entrada PAGE_REDIRECT (150 ms, fail-open) da preparacao assincrona REPLACE_CONVERSION, sem prazo global de 150 ms para CTA. | Contrato confirmado pelo proprietario no PR #36: CTA valido pode ficar pronto antes do clique; tempo nao altera risco nem percentual. Interacao precoce cancela apenas PAGE_REDIRECT e nao a preparacao pendente de CTA; abandono ou mudanca de pathname/query invalida definitivamente a decisao da navegacao. Hash no mesmo contexto continua permitido. | APROVADA PELO PROPRIETARIO; evidencias do HEAD final no PR #36 |

| D09 | Revogacao eventual de CTA: resposta aceita em ate 5 s desde o inicio; validade maxima de 120 s desde esse inicio e renovacao prevista a cada 60 s. Falha, expiracao ou mudanca de contexto preserva o original. Versoes CTA conhecidas nao retrocedem. | Decisao do proprietario para F43/GS19: respostas anteriores a revogacao podem ser aceitas antes de o navegador conhecer estado mais recente; abas suspensas podem atrasar a renovacao. Sem consulta no clique ou promessa de revogacao imediata. | APROVADA PELO PROPRIETARIO |

| D10 | Ativacao PAGE_REDIRECT scoped pelo vinculo projeto/Page ID; ponteiro global reservado ao gateway legado. Aprovar pagina nao altera versoes historicas nem outras paginas. URLs duplas continuam OBSERVE_ONLY ate remocao da antiga e nova aprovacao. | Contrato multiprojeto solicitado pelo proprietario no PR #59; transicao e limites em MULTIPROJECT-TRANSITION.md. | IMPLEMENTACAO LABORATORIAL; evidencias e revisao no SHA final do PR #59 |

| D11 | Project pause suspends operational maintenance and new notification admissions. Resume holds pre-transition backlog as REVIEW_REQUIRED, with no automatic replay or silent discard. | Owner-requested completion of pause integration; additive 044 transition audit and queue views. Prior committed admissions may finish; SMTP runs without database locks. No per-item replay endpoint added. See PROJECT-PAUSE-NOTIFICATIONS.md. | IMPLEMENTED; focused PostgreSQL/SMTP proof in tests/project-pause-delivery.test.ts; independent review recorded in STATUS.md |

| D12 | A vencida de lease CTA nao comprova encerramento do transporte. PROCESSING preserva token e tentativa ate callback; queda do worker exige revisao, sem retomada automatica. | Correcao solicitada na revisao independente: evitar envio concorrente duplicado mesmo com callback ainda vivo. Nao existe acao administrativa de resolucao; backlog anterior a pausa continua REVIEW_REQUIRED sem replay. DNS so adquire locks de persistencia depois das consultas externas. | IMPLEMENTADO; tests/pause-review-races.test.ts com PostgreSQL/SMTP reais |

| D13 | Exclusao de projeto nesta entrega e logica reversivel: exige ARCHIVED, versao, justificativa e ID:nome; restaurar retorna PAUSED. Nao ha purga fisica nem resolucao de backlog. | Continuacao solicitada pelo proprietario sem executar exclusoes reais; modo conservador explicitado antes do codigo. Auditoria transacional preserva IDs e dados dentro das retencoes existentes; sem ampliacao de coleta. | IMPLEMENTADO em laboratorio; docs/PROJECT-ARCHIVE-RESTORE.md e tests/project-lifecycle-admin.test.ts |
| D16 | Fechamento operacional preserva o painel/stack atuais; migracao estetica ou escolha de stack nao e gate desta fatia. Nao declarar UI React/Vite implementada. | Ordem explicita do proprietario nesta estabilizacao: testar todos os fluxos em desktop/mobile, sem reescrita estetica ou escolha de stack. Contrato funcional permanece; D07 e #69 preservados, sem veto novo. | Prova em operational-journey e OPERATIONAL-CORE-CLOSURE.md; nenhuma alteracao de stack. |

| D14 | LP excluida encerra URLs/vinculos/sinais exclusivamente seus; ancora inativa e evidencias imutaveis sao preservadas. Purga fisica de projeto permanece BLOCKED com catalogo de dependencias e bloqueadores reais. | Pedido exige isolamento, historico e FKs/triggers preservados. Projetos excluidos recusam escritas admin sob lock transacional; nao existe politica aprovada para apagar/desvincular auditorias, versoes publicadas e ledger financeiro. Backup nao e apagado por exclusao no banco ativo. | Implementacao/provas em SAFE-DELETION.md; fisica nao concluida |

| D15 | Drift operacional de ponto (review_required/review_after_observation ou suspension comercial) nao invalida a aprovacao inteira da pagina. A decisao filtra os pontos suspensos; snapshot aprovado continua imutavel e destino/oferta/marcador/mapeamento/referencia/versao/politica alterados continuam invalidando a configuracao. | Conclusao solicitada pelo proprietario: GS08 integrado scoped demonstrou o bloqueio global anterior. Migration aditiva 049 e snapshot runtime normalizam exclusivamente flags operacionais; publicacao/aprovacao administrativa continua recusando ponto pendente. tests/scoped-gateway.test.ts exercita tres CTAs, drift isolado, revisao e invalidacao por destino alterado. | IMPLEMENTADO EM LAB; revisao consolidada e regressao final pendentes |

## Distribuição do runtime v1 — decisão do proprietário em 2026-11-10

Um hostname público operacional inicial atende SCRIPT, TELEMETRY e STATIC_ASSETS; admin privado separado. Distribuição, instalação e aliases são versionados e persistidos por LP, sem rotação em consultas. Evolução para origens próprias por papel mantém revisões/rotas antigas até migração explícita. Não reconstruir módulos funcionais nem converter canários em mitigação. Contrato e mapa do código após PR #63 em [RUNTIME-DISTRIBUTION-CONTRACT.md](RUNTIME-DISTRIBUTION-CONTRACT.md); implementação aditiva 051 e testes de compatibilidade. Sem mudança de D05, ativação operacional, DNS, merge ou deploy.

## Histórico de D05

### Evolução investigativa F13/F14 — decisão do proprietário em 2026-11-11

Inteligência e investigação continuam com Stealth ON/OFF; o interruptor controla somente uso de avaliação suficientemente confiável como veto adicional. Visitas sem confiança suficiente seguem políticas comerciais, classes e percentuais normais. Separar hipótese de atividade do grupo de provável operador da sessão; IP, UTM, fingerprint, proximidade e primeira visita não comprovam identidade. A entrega atual é shadow, conforme [F13-F14-SHADOW.md](F13-F14-SHADOW.md): proposta interna v3 opt-in para aprovação posterior, sem alterar/publicar versões v2 ou legadas, snapshots e aprovações. Sem fonte operacional validável nem calibração de campo, não ativar veto nem concluir F13/F14. Não autoriza coleta invasiva, IDs permanentes entre sites/dispositivos ou geolocalização precisa.

A redação inicial aprovada para início era: “Stealth com risco alto ou explicitamente incerto prevalece sobre mitigação visível; sinais não provam identidade.” Foi superada para novas versões explícitas pela decisão do proprietário em 2026-11-09. Versões publicadas legadas conservam esse comportamento; nenhuma fonte histórica SaaS foi modificada.

## Correção operacional do PR #64

Opt-in comercial persistido por projeto/LP, contexto HTTPS explícito, revisão concorrente e vínculo à aprovação/gerações (052). Configurar OPERATIONAL não ativa LP. Origem declarada não comprova cópia: servidor exclui origens oficiais cadastradas e Bootstrap confere contexto real. Suspensão impede novas admissões após commit, preservando D09 para snapshots entregues. D05–D15 preservados.

Rotação na mesma origem cria revisão explícita auditável (053); recursos neutros v2 preservam v1. Canários registram chegada por alias separada da presença alegada da LP; Referer raiz não distingue LPs. Verificador navegável BLOCKED por falta de isolamento de rede demonstrado; URLs arbitrárias são recusadas, sem estados positivos. Esta pendência impede declarar consolidação integral.
PR #64, decisao expressa posterior do proprietario: opcao A de validacao integral local WSL/Linux como gate desta revisao, sem minutos pagos do GitHub Actions. Reproduzir workflow real, manter Actions BLOCKED e PR Draft ate autorizacao expressa. Nao alterar workflow, cobranca ou fabricar status remoto. Evidencias em LOCAL-CI.md; F08 e os demais limites nao mudam.
