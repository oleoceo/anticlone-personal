# Handoff — AntiClone Personal

- Projeto privado, single-owner e self-hosted; seguir AGENTS.md e docs/AGENT-WORKFLOW.md.
- Base: main 6ab19d7, PR #17 integrado; trabalho em feat/f22-form-get.
- F22 parcial: âncoras dinâmicas e pop-up em laboratório; GS07/GS10 completos pendentes.
- PR #18 reduzido (D07): nenhum formulário é interceptado; mapeamentos permanecem armazenados.
- Decisão ativa inclui somente âncoras; formulários suspensos não consomem o limite de 100. Regressão PostgreSQL em `tests/cta-decision.test.ts`.
- P2 residual reproduzido em Chromium; envio nativo preserva cancelamento e campos tardios.
- Regressão em `tests/form-cancellation.test.ts` passou; revisão Codex read-only sem P0/P1/P2; resultado da CI final no PR #18.
- Manter política pronta, destino aprovado, unicidade, OBSERVE_ONLY e PAGE_REDIRECT.
- Fallback de revisão: sessão Codex separada com sandbox read-only e pacote fora da worktree.
- Rodar testes relevantes, lint, typecheck, build e CI; registrar revisão, abrir PR sem merge/deploy.
- GitHub CLI autenticado em C:\Program Files\GitHub CLI\gh.exe.
