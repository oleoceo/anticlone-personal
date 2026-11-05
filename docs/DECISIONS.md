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
