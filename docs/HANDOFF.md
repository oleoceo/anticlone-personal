# Handoff — AntiClone Personal

- Projeto privado, single-owner e self-hosted; seguir AGENTS.md e docs/AGENT-WORKFLOW.md.
- Base: origin/main 188c88d, PR #16 integrado; branch de trabalho feat/f22-dynamic-cta.
- F21: substituição de links estáticos mapeados em laboratório; consultar STATUS.md e matriz para limites.
- F22 em andamento: âncoras tardias e pop-up, SPA no pathname autorizado; GS07/GS10 integrais pendentes.
- Preservar fail-open, decisão pronta sem rede no clique, marcadores únicos e destinos aprovados.
- Escopo inclui links/formulários apenas conforme compatibilidade comprovada; não marcar F22 V sem GS07/GS10.
- Crossagents: rota persistente review → codex; teste 93684f3bc762 concluído, leitura de docs/AGENT-WORKFLOW.md.
- Bloqueio: provedor codex anuncia somente full-access; instrução de leitura não impõe sandbox read-only.
- REVISÃO PENDENTE: viabilizar sessão Codex independente com sandbox de somente leitura verificável.
- Rodar testes relevantes, lint, typecheck, build e CI; registrar revisão e evidências, abrir PR sem merge/deploy.
- GitHub CLI autenticado em C:\Program Files\GitHub CLI\gh.exe; acompanhar CI do PR.
