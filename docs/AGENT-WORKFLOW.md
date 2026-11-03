# Protocolo de trabalho autônomo, com limites de repetição

## A. Primeira sessão (auditoria sem looping)

1. Confirmar que `AGENTS.md`, Blueprint, matriz e referências estão acessíveis.
2. Conferir a matriz com a documentação temática (somente partes operacionais) e produzir **diff pequeno** + decisões conflitantes. Esta auditoria é única, não se repete a cada item.
3. Validar escopo: nenhum requisito SaaS comercial adicionado; nenhuma função operacional apagada.
4. Encerrar e relatar a auditoria. A infraestrutura da primeira entrega é atividade posterior, iniciada quando solicitada; não começar UI completa antes do primeiro cenário E2E.

## B. Uma fatia = um resultado comprovável

1. **Escolher:** menor Fxx ainda planejada que desbloqueia o próximo GS. Declarar até 6 linhas de escopo, critério, arquivos, teste e risco.
2. **Isolar:** `git switch main; git pull --ff-only` (se existir remote); criar `feat/<capacidade-curta>`; no Poracode, um worktree por agente que escreve.
3. **Implementar:** código + migração + testes + diagnóstico de falha. Não criar endpoints/menus placebo nem mudar escopo por conveniência.
4. **Auto-checagem:** testes focados, lint, typecheck, build e verificação de diff/segredos. Se falhar, corrigir até **duas** rodadas justificadas por logs.
5. **Revisão independente:** outra sessão Codex ou Claude Code revisa o diff, contrato, riscos, regressões e testes, sem escrever na worktree do autor. Se a delegação automática não estiver disponível ou verificada, usar duas threads Codex separadas e transferir o contexto e os achados manualmente; não presumir seleção de perfis ou orquestração operacional.
6. **Se reprovar:** devolver ao autor correções com bugs reproduzíveis, respeitando o máximo de **duas** rodadas de correção. Se persistir, pedir **um diagnóstico independente** de outro agente, com logs e hipótese; sem solução demonstrada, registrar `BLOCKED` e parar aquele tema.
7. **GitHub:** push da branch; PR contendo propósito, diffs, testes, riscos, rollback se relevante; CI verde. Não fazer merge se gate falhar. Respeitar proteção de branch e limites de risco abaixo.
8. **Fechar:** atualizar Fxx para `V` **somente com cenário relevante efetivamente testado**, atualizar `STATUS.md` em poucas linhas, escolher próxima fatia independente.

## C. Decisão de avanço

```text
IMPLEMENTAR -> TESTAR
  ├── PASSOU -> PR -> REVISÃO INDEPENDENTE + CI -> ACEITE -> PRÓXIMA FATIA
  └── FALHOU -> 2 CORREÇÕES NO MÁXIMO
                 ├── PASSOU -> REVISÃO
                 └── FALHOU -> OUTRO AGENTE DIAGNOSTICA UMA VEZ
                               ├── SOLUÇÃO DEMONSTRADA -> VALIDAR RESULTADO
                               └── SEM SOLUÇÃO -> BLOCKED (não repetir)
```

## D. Política Git/GitHub

- Recomendação: `main` protegida por PR/CI; `feat/*` e `fix/*` para trabalho; `docs/*` para documentação.
- Agentes podem autonomamente criar branches, commit, push nessas branches, PRs, revisar checks, corrigir e atualizar branch.
- Merge de código de produção só depois de revisão independente, testes e checks exigidos, com política de aprovação definida pelo proprietário. Se não houver autoridade, deixar PR pronto e seguir tarefa independente; não fingir que merge ocorreu.
- Alteração em `runtime/`, políticas, identidade/sessão, webhooks e retenção sempre demanda revisão de segurança independente. Alterar infra, DNS, segredos, deploy e migração destrutiva requer humano.
- Nunca `git push --force`, `git reset --hard`, rebase destrutivo em branch compartilhada, apagar repositório ou remover controles de branch para passar CI.

## E. Custos, contexto e escalonamento

- Uma tarefa ativa por vez; dois agentes simultâneos apenas se trabalham em worktrees isoladas ou um é revisor read-only.
- Não reprocessar o RAR completo a cada tarefa; citar referência específica. Não fazer relatórios longos quando um teste e 5 linhas bastam.
- Não alternar agentes por gosto; trocar somente após erro repetido, risco elevado ou incapacidade concreta.
- Usar modelos mais caros para revisão de segurança, incidentes difíceis ou arquitetura ambígua, não para scaffolding rotineiro.
- Se CI falhar por ambiente/credencial, distinguir de falha do código; não fazer dezenas de commits tentando adivinhar.
- Solicitar ajuda humana apenas para decisões de produto, custos, credenciais/permissões, deploy e operações irreversíveis, ou bloqueio real persistente.
