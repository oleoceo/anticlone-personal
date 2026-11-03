# Prompt inicial para colar no Poracode (agente coordenador)

Você está no repositório `C:\projetos\anticlone-personal`. Leia `AGENTS.md` (fonte única), `ANTICLONE-PERSONAL-BLUEPRINT.md`, `docs/FUNCTIONAL-MATRIX.md`, `docs/TEST-SCENARIOS.md` e `docs/AGENT-WORKFLOW.md`.

**Missão:** construir um AntiClone Personal single-owner, sem arquitetura SaaS, mantendo todas as funções operacionais. Use a documentação histórica apenas como referência de detalhes, no diretório irmão `C:\projetos\anticlone-saas-referencias\projetosaas-anticlone` se existir e houver acesso. Não edite essa pasta nem inclua seu conteúdo no GitHub.

**Primeiro trabalho, delimitado:** uma única auditoria comparativa da matriz F01–F40 contra os documentos operacionais indicados em `docs/SOURCES.md`. Acrescente somente lacunas reais, anote conflitos em `docs/DECISIONS.md`, atualize `STATUS.md`. Não recrie milestones M00–M11 nem produza dezenas de documentos.

**Na mesma sessão, após a auditoria (se concluída):** inicie a Entrega A com o menor fluxo vertical executável: infraestrutura mínima, administração local segura, cadastro de um projeto, instalação de runtime em site original e cópia simulada controlada, recepção de observação, incidente persistente e e-mail deduplicado. Evite interface decorativa. Implemente com testes reais e CI progressiva. Se a infraestrutura existente não tiver credenciais, use `.env.example`, testes locais e indique bloqueio de integração real sem pedir segredo no chat.

**Fluxo contínuo:** por capacidade, Codex implementa em branch/worktree isolada; outra sessão Codex ou Claude Code faz revisão independente dos itens críticos. Sem delegação automática verificada, use duas threads separadas e transfira o contexto e os achados manualmente; agentes não escrevem simultaneamente na mesma worktree. Faça no máximo 2 rodadas de correção baseadas em logs; em falha persistente obtenha um diagnóstico de outro agente; se não houver solução demonstrada marque `BLOCKED`, não repita em looping e prossiga só com trabalhos independentes. GitHub: commits e PRs em branches de trabalho, CI e revisão antes do merge, sem operações destrutivas nem deploy sem autorização. Consulte `docs/AGENT-WORKFLOW.md`.

**Economia:** leia somente a documentação necessária a cada função, apresente resumo curto com prova, não recrie planejamento extenso. Nunca declare conclusão só porque o frontend aparece. Não me pergunte algo já documentado. Solicite aprovação apenas para custos, segredos, mudanças arriscadas ou acesso indispensável.

Primeira resposta: informe (1) fontes acessíveis, (2) lacunas reais da matriz se houver, (3) primeiro cenário de aceitação a implementar, (4) comandos de teste. Em seguida execute o que estiver autorizado.
