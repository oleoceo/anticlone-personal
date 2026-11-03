# Decisões técnicas locais — curtas e rastreáveis

| ID | Decisão | Motivo / evidência | Status |
|---|---|---|---|
| D01 | `AGENTS.md` é o guia único; `CLAUDE.md` importa com `@AGENTS.md`. | Evita duplicidade Codex/Claude no Windows. | APROVADA PARA INÍCIO |
| D02 | Personal single-owner e monólito modular; sem arquitetura comercial SaaS. | Objetivo e Blueprint. | APROVADA PARA INÍCIO |
| D03 | Fila/outbox durável, Postgres + Redis, como no Core Validation. | Eventos e alertas precisam resistir a falhas/reinícios. | PROPOSTA A VALIDAR NO PRIMEIRO SLICE |
| D04 | Cópias somente em ambientes autorizados no teste; stealth/risk probabilísticos. | Evidência de navegador não identifica pessoa com certeza. | APROVADA PARA INÍCIO |

Não adicionar decisões para preferências triviais; registrar somente trade-offs com efeito de contrato, custo, operação ou segurança. Documentos SaaS não reabrem decisão sem evidência.
