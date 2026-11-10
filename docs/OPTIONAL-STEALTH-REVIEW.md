# Revisão e evidências — Stealth opcional v2

Base: main após PR #61, c4ba5ad09ce78804e3ccfe7c7b03e4f25d2d3cd3. Código final revisado: ef909f851516546fb1cab7686e6f20c8e4bf4e4b. Entrega exclusivamente laboratorial; sem deploy, migração de produção, merge ou ativação real.

## Validação do implementador

- lint, typecheck e build passaram.
- Bateria integral local em b957378: 100 testes, 99 aprovados, nenhuma falha e um skip explícito do cenário HTTPS Nginx/Linux obrigatório na CI. PostgreSQL 16 real no laboratório WSL, Chromium e ferramentas reais de recovery via RECOVERY_TEST_CONTAINER; nenhum mock substituiu a suíte.
- No delta corretivo: optional-stealth (2), multiple-cta-surfaces (1) e scoped-gateway (1) passaram; o ajuste posterior da expectativa do teste para PageConflict e a orientação textual passaram novamente em optional-stealth. Não se repetiu a bateria integral local: a CI executa o conjunto final incluindo HTTPS.
- Validador documental e nove testes Python passaram; não contam como prova do sistema.
- git diff --check e revisão dos arquivos staged sem credenciais/dados pessoais antes do fechamento. O diretório scripts/__pycache__ preexistente não integra a entrega.

O cenário novo demonstra PAID 100% e DIRECT_UNKNOWN 0%, LOW/HIGH/UNCERTAIN/ERROR, ON forte sintético/incerto, aprovação/migração explícitas, políticas de entrada e CTA independentes, duas LPs/projetos, original preservado, clique local, backend indisponível e lifecycle. A integral inclui atribuição F42, métricas/estimativas F29/F30, drift, refresh e demais regressões existentes. Estado e URL da CI no SHA final ficam registrados no PR consolidado; Ready depende do check verde.

## Revisão independente e correção

Sessão Codex independente /root/stealth_review, worktree C:/Projetos/anticlone-stealth-review, detached, sem escrita na worktree do implementador. Primeira revisão: origin/main..b957378; build e quatro testes focados passaram.

Achado P2 reproduzido com PostgreSQL: superfície legada e superfície v2 OFF na mesma LP compartilhavam o requisito de persistência investigativa do envelope. LOW selecionava ambas e podia cancelar OFF diante de falha/espera; HIGH/UNCERTAIN selecionavam apenas OFF. Não houve P0/P1 ou outro P2 reproduzível.

Correção em b957378..ef909f8: rejeitar contratos CTA mistos antes do risco, tanto na aprovação quanto na decisão; exigir migração/reaprovação explícitas das superfícies CTA da LP. A mesma configuração inválida fica OBSERVE_ONLY para LOW/HIGH/UNCERTAIN. Após migrar, ambos mappings OFF funcionam mesmo com investigação falsa ou pendente. Não há mistura prévia legada afetada; modos ON/OFF entre v2 e fase de página continuam independentes. Contrato e interface explicam a migração.

Reavaliação independente limitada ao delta: build, três testes focados (optional-stealth + multiple-cta-surfaces) e diff --check passaram. Parecer final favorável em ef909f851516546fb1cab7686e6f20c8e4bf4e4b, sem P0/P1/P2 remanescente identificado; condicionado à CI verde no SHA final. Evidência forte continua sintética loopback, sem alegação de classificador operacional. Os commits posteriores de evidência documental não mudam esse código; seus deltas devem ser conferidos antes de Ready.
