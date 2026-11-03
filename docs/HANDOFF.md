# Handoff — AntiClone Personal

- Projeto privado, single-owner e self-hosted; seguir AGENTS.md e docs/AGENT-WORKFLOW.md.
- Base: origin/main 188c88d, PR #16 integrado; branch de trabalho feat/f22-dynamic-cta.
- F21: substituição de links estáticos mapeados em laboratório; consultar STATUS.md e matriz para limites.
- F22 em andamento: âncoras tardias e pop-up, SPA no pathname autorizado; GS07/GS10 integrais pendentes.
- Preservar fail-open, decisão pronta sem rede no clique, marcadores únicos e destinos aprovados.
- Escopo inclui links/formulários apenas conforme compatibilidade comprovada; não marcar F22 V sem GS07/GS10.
- Crossagents: rota persistente review → codex; teste 93684f3bc762 concluído, leitura de docs/AGENT-WORKFLOW.md.
- Crossagents anuncia somente full-access; fallback: sessão Codex separada com sandbox read-only e pacote de revisão externo à worktree.
- Revisão do PR #17: sessão 01a1a3b0-701a-7891-aaba-8c247eb5fe88; dois P2 corrigidos e reavaliados, sem P0/P1/P2 restantes no recorte.
- Rodar testes relevantes, lint, typecheck, build e CI; registrar revisão e evidências, abrir PR sem merge/deploy.
- GitHub CLI autenticado em C:\Program Files\GitHub CLI\gh.exe; acompanhar CI do PR.
