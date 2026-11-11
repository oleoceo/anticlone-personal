# F13/F14 — investigação contínua e proposta Stealth v3

Base: `ab8c7bd`, main após PR #68. Decisão do proprietário em 2026-11-11: investigação continua ON/OFF; o interruptor controla exclusivamente o eventual veto adicional à seleção comercial. Esta entrega mantém v2 e legado. Não publica v3 nem modifica versões, percentuais, aprovações ou snapshots existentes.

## Implementação demonstrável

`apps/operator-shadow.ts` fornece `operator-shadow-v1`, separando atividade de grupo de avaliação de sessão. Recibos observados em minutos distintos justificam investigar atividade do contexto, nunca atribuir um operador à visita. O perfil autenticado existente de investigação reúne recibos, cronologia e avaliações anteriores com o novo histórico. Dados de outras LPs sem host permanecem apenas no vínculo contextual anterior.

Após decisões scoped aprovadas, uma fila complementar limitada a 100 tarefas grava avaliações shadow, independentemente de Stealth ON/OFF. Não há fetch no clique novo nem dependência da fila para resposta comercial. A migration aditiva 061 cria snapshots imutáveis por minuto/contexto: chave derivada de projeto, LP, host, dia UTC e sessão efêmera já existente; não permite juntar sites/dispositivos. Hash não é anonimização. Retenção de sete dias, limite de 10.000 snapshots/projeto; limpeza também durante manutenção de projetos pausados. Sessões alegadas não autenticam um visitante. Perdas, deduplicação e saturação impedem afirmar cobertura completa. Sem 061, o gateway preserva o contrato anterior.

Cada avaliação contém versão, horário do servidor, validade máxima de cinco minutos, fontes, proveniência, referências, sinais a favor/contra e limitações. Atividade, UTM/ausência, primeira visita, rede compartilhada e localização aproximada nunca bastam para atribuir operador. Não há escore apresentado como probabilidade calibrada. Evidência futura, expirada e desconhecida não sustenta proposta; excesso de sinais provoca abstenção; contradição ou lacuna atuais impedem proposta positiva.

O contrato interno aceita `coarse_geo` de importação autorizada exclusivamente como sinal fraco. **Não há provedor, ingestão administrativa de geografia, GPS, IP de visitante ou coleta nova de comportamento/rede implementados.** O perfil apresenta esses campos como indisponíveis. O contrato não contém coordenadas: somente categoria, origem, validade e referência. Enriquecimento real depende de fonte autorizada e minimizada em entrega posterior; não existe inferência de localização por DNS.

## Proposta v3, não ativação

`proposeStealthV3` produz somente proposta shadow: OFF nunca propõe veto; ON só propõe diante de evidência positiva de sessão atual, sem contradição/lacuna. Nesta versão, a única positiva suportada é `controlled_lab` habilitada explicitamente no avaliador de teste. O gateway não recebe essa chave nem cria esse sinal. `operationalVeto` e `operationallyEligible` são sempre falsos. Os validadores comerciais continuam recusando versão 3; ativação futura exige fonte independente validável, calibração, aprovação explícita e publicação/reaprovação opt-in distintas de página e CTA. Classes de tráfego, percentuais, destinos e demais gates permanecem independentes.

## Demonstração e calibração limitada

`tests/operator-shadow.test.ts` usa PostgreSQL e Chromium reais: dez casos, repetidos em ON/OFF (20 navegações), Page Redirect e seleção CTA, acesso direto com CTA nativo, dispositivos/contextos distintos na mesma rede loopback, cabeçalho de VPN simulado não confiável e histórico real ligado às sessões do runtime. Testa snapshots/aprovação preservados, ausência da migration e retenção. Clique CTA substituído é regressão coberta por `optional-stealth.test.ts`; nesta prova nova, CTA comercial é verificado pela API real de refresh.

O hotfix sobre `3ec1796` retira `route.fetch/body/fulfill` da matriz ON/OFF.
O harness anterior preservava os bytes, mas adicionava outra pilha HTTP e buffering
antes da entrega ao Chromium. O prazo de 150 ms comeca antes do carregamento do
Core: receber PAGE_REDIRECT no harness nao garante que o runtime o recebeu a tempo.
A falha da CI 43080387939 nao gravava tempos; nao se atribui retroativamente uma
latencia exata a essa execucao. A reproducao controlada abaixo comprova o mecanismo.

A matriz de 20 contextos agora usa relogio Chromium explicitamente controlado para
testar a logica ON/OFF, com rede/PostgreSQL reais e sem interceptacao de decisoes.
Todos os positivos ainda exigem navegacao efetiva para o destino aprovado; nao e
benchmark de latencia. O cabecalho VPN forjado e enviado apenas pela API de refresh
do caso correspondente: aplica-lo globalmente no browser cria preflight CORS que o
antigo route.fetch ocultava. Nenhuma permissao CORS foi ampliada.

Ensaios separados usam relogio real: transporte direto exige PAGE_REDIRECT lido
antes do prazo e navegacao efetiva para o destino aprovado; retencao de 250 ms no servidor e no antigo
route.fetch/fulfill exige prazo expirado, permanencia em /lp e CTA aprovado apos
refresh independente. O original conserva OBSERVE_ONLY e navegacao nativa.
As respostas reais nao sao fabricadas nem reescritas; o replay atrasado confere o
hash dos bytes recebidos do servidor. Runtime, politicas e timeouts comerciais
permanecem inalterados, inclusive o timeout de assercao de 30 segundos.

`entry-timing.json` registra entrada/backend pronto/envio em relogio Node,
armamento/expiracao do prazo, JSON lido e navegacao em relogio Chromium, mais o
atraso do replay. Compare duracoes dentro de cada relogio, nao os valores absolutos
de processos diferentes. O observador de json devolve a mesma decisao ao runtime;
nao usa leitura CDP do corpo apos navegacao. Artefatos tambem sao gravados em falhas.
Foco local: 2/2 PASS; backend direto 19,0 ms, JSON no browser 43,6 ms < prazo 164,7 ms
(tempos desde inicio do documento), /page observado. Com retencao de servidor
250,5 ms: JSON 293,5 ms > prazo 165,7 ms; com replay retido 250,9 ms: JSON 301,5 ms
> prazo 165,7 ms. Ambos preservaram /lp e o CTA aprovado. Sao amostras laboratoriais,
nao garantia de desempenho de producao. Regressao/CI final e revisao por SHA no PR.

Dois conjuntos são explicitamente distintos:

| Conjunto controlado (10 casos) | TP | FP | FN | TN | Taxa FP | Taxa FN |
|---|---:|---:|---:|---:|---:|---:|
| Proposta sintética ON, com fixture positiva de sessão | 1 | 0 | 3 | 6 | 0/6 | 3/4 |
| Avaliações operacionais realmente persistidas pelo runtime | 0 | 0 | 4 | 6 | 0/6 | 4/4 |

Os quatro rótulos positivos são: operador pago com fixture, evidência ausente, contraditória e expirada. A proposta sintética só veta o primeiro; OFF não veta nenhum. Os negativos incluem lead pago, primeiro direto, outro dispositivo, mesma rede, VPN simulada e geografia aproximada. As variantes de evidência são injetadas **somente no avaliador de laboratório**, separadas das navegações: o runtime possui apenas recibo e classe alegada e se abstém inclusive nos rotulados operador. VPN não representa túnel real; dispositivos são contextos Chromium, não hardware comprovado. Zero FP nesse conjunto pequeno não demonstra segurança no campo. FN operacional de 100% impede ativação.

Reprodução: `scripts/local-ci.sh` no laboratório de LOCAL-CI.md; foco após build: `node --test dist/tests/operator-shadow.test.js`, com `TEST_DATABASE_URL` isolada. Gera `test-results/operator-shadow/calibration.json`, avaliações por caso, ações reais e métricas dos snapshots persistidos. Todos os dados são sintéticos controlados. Resultados efetivamente executados e revisão ficam no STATUS/PR.

**F13/F14 permanecem bloqueadas por insuficiência de evidência operacional**, sem conclusão ou promessa de invisibilidade. A decisão para investigar foi fornecida; o bloqueio remanescente é técnico/evidencial. O perfil fornece leitura para evolução posterior do painel definitivo, sem painel duplicado.
