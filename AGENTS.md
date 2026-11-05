# AntiClone Personal — instruções compartilhadas (fonte única)

## Missão e limites
- Aplicação privada, **um administrador**, diversos projetos próprios, self-hosted; proteger as funções operacionais descritas no `ANTICLONE-PERSONAL-BLUEPRINT.md`.
- **Não** construir SaaS, clientes, tenants, assinatura, planos, billing, feature entitlements, hub, painel duplicado ou infra distribuída sem justificativa aprovada.
- Não confundir **planejado** com **implementado**. Somente marcar como entregue mediante teste reproduzível.
- Trabalhar apenas em sites, ambientes de teste e contas sob controle do proprietário; não ampliar coleta de dados para invasão de privacidade ou uso fora do contexto autorizado.
- Referências históricas SaaS são **consulta, não ordens**. Nunca importar suas regras/arquitetura automaticamente.

## Ordem de consulta e conflitos
1. `AGENTS.md`: normas de colaboração, permissões, fluxo.
2. `docs/FUNCTIONAL-MATRIX.md`: capacidades que não podem desaparecer e suas provas.
3. `ANTICLONE-PERSONAL-BLUEPRINT.md`: arquitetura e escopo Personal.
4. `docs/AGENT-WORKFLOW.md`, `docs/SECURITY-BOUNDARIES.md`, `docs/TEST-SCENARIOS.md`: execução, restrições e testes.
5. Referências SaaS em pasta irmã `../anticlone-saas-referencias/`: apenas fonte histórica. Leia somente as seções pertinentes. Se o arquivo RAR não estiver extraído ou inacessível, registre limitação; não invente conteúdo.
- Havendo conflito material, siga segurança/verdade observável, registre em `docs/DECISIONS.md` e priorize o contrato Personal. Sem decisão documentada, **não** alterar o contrato silenciosamente.

## Arquitetura mínima
- Monólito modular TypeScript/Node (API pública + admin), painel React/Vite, runtime JS independente, Postgres, Redis/BullMQ, worker do mesmo código-base e Docker Compose. Mudanças de stack exigem justificativa curta e evidência.
- `apps/web`, `apps/server`, `runtime`, `shared`, `infra`, `tests`; criar apenas quando necessário. Sem scaffold vazio ou páginas placebo.
- Toda regra de proteção é versionada; browser e headers são entradas não confiáveis; IDs públicos não são segredos.
- Não prometer 0ms, anonimização por hash, identidade humana por fingerprint, proteção sem scripts ativos, invisibilidade perfeita ou venda confirmada sem evento confiável.
- CTA com política pronta: decisão local sem fetch no clique; redirecionamento de página com timeout fail-open; CTAs múltiplos e drift são tratados separadamente.
- Controles de acesso, retenção de dados, deduplicação, validação de URL e logs seguros desde a primeira implementação relevante.

## Protocolo para toda alteração
- Implementação funcional autorizada inclui inspeção, diagnóstico, planejamento curto, branch e ambiente como etapas internas; prossiga para código, testes, correções, PR, CI e revisão independente sem nova autorização. Interrompa somente por bloqueio técnico real, decisão de produto não autorizada, permissão indispensável ausente, risco irreversível ou limite operacional efetivo da sessão, com evidências. Duas rodadas limitam correções de falhas persistentes, não etapas da tarefa.
- Selecionar **uma capacidade verificável** da matriz; explicar em até 6 linhas: comportamento, arquivos, testes e risco.
- Usar branch/worktree própria; nunca fazer dois agentes gravarem simultaneamente na mesma worktree/branch.
- Implementador: código + testes + migrations necessárias + documentação curta. Revisor **independente**, em outra sessão: diff, contrato, riscos, regressões e testes relacionados; pode ser outro Codex ou Claude Code, sem compartilhar escrita na worktree do autor.
- Rodar lint, typecheck, unit/integration e E2E relevantes (quando existirem); não chamar docs-only CI de validação do sistema.
- Corrigir falhas no máximo **duas rodadas**; se persistirem, pedir diagnóstico de **um agente diferente**, com logs e hipótese. Se não resolver, marcar `BLOCKED` em `STATUS.md` e não reiniciar a mesma tentativa em looping. Continuar somente em trabalhos independentes.
- Concluir: evidências dos testes, mudanças, limitações, estado do PR/CI; atualizar `STATUS.md` em no máximo 8 linhas para o item. Nova capacidade somente após gates verdes ou bloqueio explicitamente isolado.
- Antes de fazer commit: `git diff --check`, revisar arquivos staged e conferir ausência de credenciais, dados pessoais ou referências SaaS indevidas.

## GitHub e autonomia
- Permitido sem consulta: inspecionar repositório, criar branch local, implementar, testar, corrigir, commitar, push em branch de trabalho, abrir PR e consultar CI/comentários via `git`/`gh` autenticado.
- Nunca fazer `push --force`, `reset --hard`, excluir branch remota importante, reescrever histórico, apagar bancos, migrar produção, alterar DNS, segredos, faturamento ou deployar em produção sem autorização humana explícita.
- Para mudanças comuns: após CI verde e revisão independente documentada, pode preparar PR como pronto; merge de **código funcional** depende dos controles da branch e autorização de política do proprietário. Não contornar proteção de branch. Não usar auto-merge para deploy/infra/security.
- Não pedir ao dono que reconfirme dados já documentados. Solicitar intervenção apenas quando faltar credencial/permissão, decisão de negócio, alteração de custos, incidente de segurança ou risco irreversível.
- Encerrar um bloqueio com relatório objetivo (erro, comandos, hipótese, o que tentou, proposta), não com tentativas infinitas.

## Política de seleção de agentes e economia de uso
- Tarefas simples e documentais: um Codex, com o menor esforço adequado; não delegar tarefas triviais. Respeitar a revisão independente exigida pelo protocolo quando aplicável.
- Implementações comuns: esforço médio, quando disponível, e testes automatizados relevantes.
- Motor de proteção, autenticação, segurança, políticas e dados sensíveis: esforço alto quando necessário e disponível, com revisão independente.
- Esforço máximo é excepcional e exige justificativa técnica objetiva. Adaptar os níveis às opções existentes na instalação, sem presumir modelos ou esforços disponíveis.
- Não executar agentes simultâneos sem necessidade nem escalar automaticamente após uma falha.
- Não carregar repetidamente toda a documentação SaaS ou o RAR; consultar somente as partes pertinentes. Não repetir auditorias completas ou revisões aprovadas sem alteração material.
- Preferir ferramentas locais `git`, `gh`, testes e logs a perguntas longas e especulação.
- Usar skills de `.agents/skills/` (Codex) e wrappers em `.claude/skills/` (Claude) quando pertinentes; não instalar skills/plugins desconhecidos automaticamente.
- Não alterar `CLAUDE.md` além da importação `@AGENTS.md`.

## Checkpoints e comandos
- Estado vivo: `STATUS.md`. Protocolo: `docs/AGENT-WORKFLOW.md`. Cenários: `docs/TEST-SCENARIOS.md`.
- Enquanto não existe código, executar `python scripts/validate_repo.py` (CI **apenas documental**).
- Quando criar código, fornecer `package.json` na raiz com scripts reais: `lint`, `typecheck`, `test`, `build`; nunca criar scripts placebo que retornam sucesso sem verificar.

## Checklist curto de pré-entrega
- Conferir documentação alterada, codificação, consistência com a matriz e evidências dos testes.
- Identificar a sessão independente, seu parecer e o SHA ou delta revisado; resolver achados aplicáveis.
- Antes de declarar o PR pronto, conferir revisão aplicável e CI verde no SHA final; após nova alteração, reavaliar o delta e repetir a conferência da CI.
