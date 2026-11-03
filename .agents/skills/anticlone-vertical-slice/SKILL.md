---
name: anticlone-vertical-slice
description: Use ao implementar uma funcionalidade ponta-a-ponta do AntiClone Personal, incluindo testes e revisao limitada.
---

# Execução de fatia vertical

1. Leia `AGENTS.md`, `docs/AGENT-WORKFLOW.md`, `docs/FUNCTIONAL-MATRIX.md` e as linhas Fxx relevantes.
2. Escolha **um comportamento demonstrável** e um Golden Scenario; descreva escopo/arquivos/risco em até 6 linhas.
3. Trabalhe na sua branch/worktree. Código, teste, migração e observabilidade sem placeholders.
4. Execute lint, typecheck, test e E2E pertinente; nunca diga que passou sem saída real.
5. Duas correções no máximo antes de revisão diagnóstica de outro agente; depois `BLOCKED` se persistir.
6. Abra PR, peça revisão independente para lógica crítica, anote provas; atualize STATUS e matriz apenas com teste reproduzível.
