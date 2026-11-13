# Hotfix do harness após PR #76

Escopo F17/F18: distinguir autorização comercial e entrega dentro do prazo, sem alterar runtime, D05, F13/F14, políticas, dependências ou infraestrutura. O prazo comercial continua 150 ms; nenhum timeout foi aumentado, nenhum teste virou skip.

## Diagnóstico e comparação

- CI aprovada [43325630912](https://github.com/oleoceo/anticlone-personal/actions/runs/43325630912), SHA `f6abdd2f1043030e967f48f726cfd44991d4c4e3`: 130 Node PASS, zero FAIL/SKIP, 10 Python PASS.
- CI pós-merge [43327926902](https://github.com/oleoceo/anticlone-personal/actions/runs/43327926902), SHA `1c43a9f1f45f7f03816e81c73f8c6034e933dd86`: 128 Node PASS, dois FAIL. As árvores dos dois SHAs são **idênticas**, `d5bf01c17bd79ad27ac2539816cc9b13b782978e`; não houve delta funcional no merge.
- Ambos usaram Node 22.23.4, PostgreSQL 16.16 e Chromium 156.0.8078.4. No shadow direto, backend agregado passou de 25,8 para 161,1 ms; parse no navegador passou de 46,1 ms (deadline 162,8) para 186,7 ms (deadline 163,2). A expiração foi observada e a URL permaneceu na cópia: fail-open correto. O assert antigo exigia throughput pontual do runner, confundindo atraso com defeito de navegação.
- O tempo agregado do backend inclui agendamento, pool e consultas PostgreSQL; os logs não isolam qual componente sofreu atraso. O prazo começa antes de carregar/inicializar Core e de enviar entry-decision; portanto latência de script/Chromium também consome orçamento. Não há evidência suficiente para atribuir o atraso exclusivamente ao PostgreSQL ou à CPU.
- Em optional-stealth, o log histórico só contém timeout de `/beta-page`; não contém decisão ou timestamps. **A causa histórica específica permanece inconclusiva.** O harness anterior pressupunha que toda decisão autorizada chegaria no prazo. O novo negativo reproduz esse modo de falha com bytes genuínos atrasados; demonstra uma vulnerabilidade do teste, sem provar retroativamente a causa daquela execução.

## Provas e mudança mínima

`entry-probe.ts` extrai a instrumentação existente do shadow e observa decisão, sessão, prazo/expiração, navegação, refresh CTA e tempos de runtime/Core. Não altera timers, resposta ou política. O timestamp de parse antecede o consumidor por uma microtask; é uma observação do transporte, não instrumentação interna da aceitação do runtime. Asserções de navegação continuam obrigatórias no ramo pontual.

Shadow direto agora exige PAGE_REDIRECT e classifica entrega pontual/tardia: pontual deve navegar; tardia deve expirar, preservar a cópia e permitir CTA aprovado após refresh observado. As provas reais anteriores com retenção de servidor e replay de 250 ms, hash dos bytes, original e matriz ON/OFF permanecem.

Optional beta exige ação **e destino** corretos antes de classificar tempo. Usa passagem direta com relógio real; negativo com 250 ms de retenção da resposta genuína; positivo PostgreSQL com relógio controlado; e origem autorizada com OBSERVE_ONLY e link nativo. O negativo também atrasa o refresh CTA em 250 ms para verificar sincronização pela resposta processada. Erro de política ou destino falha mesmo quando a resposta é tardia. O teste `page-redirect-browser.test.ts` permanece intacto e exige redirecionamento positivo em HTTP/Chromium com relógio real, além de observação, erro e atraso com fail-open. Testes F18 de tempo real permanecem intactos.

Baseline local no merge: dois arquivos originais, 4/4 PASS, sem falha espontânea. Windows Node 24.17.0, PostgreSQL 16 descartável em loopback e Chromium 156.0.8078.4; esse resultado não substitui a CI Linux/Node22. Primeiro foco do hotfix: 5/5 PASS incluindo page-redirect-browser. Beta direto parse 49,9 ms < prazo 166,2 e `/beta-page`; atraso parse 313,9 >= prazo 168,3 com expiração/cópia e CTA independente; controlado parse 2 < prazo 152; original OBSERVE_ONLY com link nativo. Logs locais não versionados: `test-results/hotfix76-baseline.log`, `hotfix76-focused.log` e `hotfix76-regression.log`.

## Revisão e gate

Regressão local final: 7/7 PASS, zero FAIL/SKIP, incluindo os dois arquivos corrigidos, page-redirect-browser, f18-timing e f18-gate-browser (desktop/mobile, backend, receipt, paint e navegação efetiva). Lint, typecheck, build, validação documental e 10 testes Python PASS. A suíte integral Linux/Node22 será a execução oficial do PR no SHA final.

Sessão independente read-only `/root/diagnosis`: confirmou árvores/versões/logs e revisou o delta. Encontrou corrida no novo clique CTA após espera fixa de 100 ms; corrigida aguardando parse real de REPLACE_CONVERSION. Parecer final, SHA revisado e CI oficial final são registrados no PR. Nenhuma aprovação de merge/deploy está implícita neste hotfix.
