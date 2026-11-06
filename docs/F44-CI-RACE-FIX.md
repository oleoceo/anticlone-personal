# F44: barreira de persistencia no teste temporal

Base: 7688bf52a095f970c4dd90958b2aec8ebfadf2b3 (PR #46).
Falha: https://github.com/oleoceo/anticlone-personal/actions/runs/42203029154

A assercao em dist/tests/canary-degradation.test.js:83 era a primeira
POSSIBLE_DEGRADATION, apos baseline Core em dois buckets (20/15 minutos)
e duas visitas sem Core (3 minutos/atual). Recebeu UNKNOWN, 64/65 testes.

O HTTP 204 de /observe nao confirma a escrita em degradation_events.
server.ts agenda recordDegradationClaim + degradationState na degradationTask;
o helper antigo aguardava apenas os canarios e reutilizava a contagem HTML
como referencia CSS. age() podia executar antes do commit Core.

Diagnostico local: dez execucoes sem instrumentacao passaram. Retendo o INSERT
Core por advisory lock/trigger no schema isolado e liberando /observe somente
apos ambos os canarios, a barreira antiga retornou com HTML=1, CSS=1, Core=0.
Apos age(20) e liberacao do lock, os canarios tinham 1200 segundos e Core zero
segundos. A mesma assercao final recebeu UNKNOWN: faltava o segundo bucket do
baseline Core. Esta e uma reproducao controlada da janela observada na CI;
a execucao original nao tinha trace temporal para provar sua ordem exata.

A correcao espera o incremento individual de todas as fontes esperadas,
por projeto/host/origem, antes de manipular horarios. A regressao mantem Core
bloqueado no PostgreSQL, confirma HTTP 204, Core ausente e visit() pendente;
libera o lock em finally e exige persistencia Core antes de continuar.
Usa polling de condicoes existentes, sem adicionar sleeps arbitrarios.
As assercoes UNKNOWN/POSSIBLE_DEGRADATION originais foram preservadas.

Estabilidade: 20 execucoes focadas consecutivas passaram, mais tres do revisor.
Mutacao temporaria apenas em dist, retirando Core da barreira: 3/3 execucoes
falharam em "visit must wait for Core persistence after HTTP 204". Dist foi
restaurado; mutacao nao integra o PR. Lint/typecheck/build e nove testes Python
passaram. Resultado da regressao completa e CI HTTPS no PR do SHA final.

Revisao independente read-only: /root/f44_fix_review, favoravel, sem P0/P1/P2;
base acima e blob do teste a4068e0d19a4600e503614dd020f0da73804280a.
Inspecao de server.ts/degradation.ts: fila serializa claim/diagnostico e o lock
por projeto protege transacoes. Nao foi demonstrada corrida de producao;
nenhum arquivo de producao, migration, politica ou workflow foi alterado.
HTTP continua assincrono; nao promete persistencia. UNKNOWN permanece correto
com evidencia insuficiente. F44 PARCIAL, F08 BLOCKED, NOT_VERIFIED e OBSERVE_ONLY.
Sem merge automatico ou deploy. Reverter este PR afeta somente teste/documentacao.
