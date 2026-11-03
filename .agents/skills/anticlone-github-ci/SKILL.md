---
name: anticlone-github-ci
description: Use para criar PR, resolver conflito Git, diagnosticar CI falhando ou preparar mudanca para merge sem arriscar main.
---

# GitHub e CI sem loops

1. Leia `docs/AGENT-WORKFLOW.md`, `docs/WINDOWS-GITHUB.md` e `docs/SECURITY-BOUNDARIES.md`.
2. Confirme `git status`, branch e `git remote -v`; jamais presumir acesso ou permissões.
3. Prefira `gh pr status`, `gh pr checks`, logs da execução falha e alteração mínima com evidência.
4. Não fazer push force, reset hard, deletar remote ou desativar branch protection.
5. Distinguir bug no código de infraestrutura/credencial. Após 2 rodadas e um diagnóstico independente, registrar BLOCKED.
6. Não fazer merge inseguro ou deploy em produção para contornar gate.
