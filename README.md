# AntiClone Personal

Projeto **privado, single-owner**, para proteger sites próprios. Em construção; não presumir capacidades implementadas.

## Começo rápido

1. Já existente: `ANTICLONE-PERSONAL-BLUEPRINT.md` na raiz. Este kit é **complementar** e não o substitui.
2. Fonte única de orientações: `AGENTS.md`. `CLAUDE.md` importa `@AGENTS.md`.
3. Matriz inicial: `docs/FUNCTIONAL-MATRIX.md`. Cenários: `docs/TEST-SCENARIOS.md`.
4. Fluxo: `docs/AGENT-WORKFLOW.md` e `docs/SECURITY-BOUNDARIES.md`.
5. Inicialização do Git/GitHub: `docs/WINDOWS-GITHUB.md` ou `scripts/setup-github.ps1`.
6. Kickoff do Poracode: prompt em `docs/START-PROMPT.md`.
7. A cada entrega, atualizar `STATUS.md` e anexar evidências testadas.

## Referências originais

Ficam em `C:\projetos\anticlone-saas-referencias` (pasta irmã **fora** do repositório). Para a auditoria inicial, descompactar o RAR dentro dessa pasta, em `projetosaas-anticlone/`, e conceder acesso somente de leitura se o ambiente do agente permitir. Não copiar o arquivo compactado para o GitHub.

## Estado deste kit

A CI inicial verifica **documentos e estrutura de instruções**. Ela não testa a aplicação até os módulos Node/TypeScript serem criados. Qualquer alegação de funcionalidade operacional exige os cenários Golden executados.
