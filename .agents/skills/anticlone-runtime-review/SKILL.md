---
name: anticlone-runtime-review
description: Use ao revisar runtime SDK, mitigacao de CTA, redirect, fingerprints, evidencias, dados sensiveis ou seguranca de rede.
---

# Revisão independente de runtime e segurança

1. Leia `docs/SECURITY-BOUNDARIES.md`, `docs/TEST-SCENARIOS.md`, Blueprint seções 4-5/11 e diff da branch (não arquivo SaaS inteiro).
2. Revise origens autorizadas, entrada hostil, política versionada, fail-open, stealth probabilístico, vários CTAs, não-vazamento de dados, CSP e desempenho.
3. Dê achados priorizados P0/P1/P2 com arquivo/linha/risco/caso reproduzível. Não declare segurança absoluta.
4. Faça testes mínimos reproduzindo falhas quando possível. Se não reproduzir, marque hipótese e incerteza.
5. Não modifique a worktree do implementador. Evite sugerir refatoração ampla sem necessidade real.
