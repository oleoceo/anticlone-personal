# Fechamento F25/F18 em laboratório

Base: PR #73, `e8dd1c60bcad9303967ecd77cad1145aa2dea5a7`.
Branch única `feat/f25-f18-closure`; sem merge, deploy, DNS, provedores ou
migrations de produção. Código revisado/testado `863be6d`; delta posterior de testes
e documentação, sem alterações adicionais em apps/runtime.

## F25: snapshot comercial explícito por ponto

O fluxo anterior já separava ofertas/destinos por chaves estrangeiras, mantinha
marcadores por superfície e capturas vigentes, suspendia drift de URL/valor/moeda,
revisava URL separadamente e revalidava aprovações de página conforme D15.
A lacuna era comparar condições além de valor/moeda.

A migration **062** é aditiva: `commercial_terms` nas observações, referências e
auditoria, mais termos aprovados/observados na evidência do alerta. Não preenche
o passado por inferência. Código anterior mantém rollback sobre schema aditivo;
instalações sem 062 conservam o contrato anterior de preço/moeda. Importar termos
novos exige 062 no laboratório; não se simula persistência quando ela falta.

O objeto estruturado contém `offer`, `previousAmount`, `discountBps` (0–10000)
e `installments: {count, amount}`. Todos os campos são obrigatórios no objeto;
**null significa UNKNOWN**, inclusive após aprovação administrativa. Valores
monetários são inteiros em unidades mínimas da moeda explícita; não se infere
total, juros, desconto ou identidade de oferta por aritmética ou texto.

No inventário local, os atributos opcionais são `data-anticlone-offer`,
`data-anticlone-previous-minor`, `data-anticlone-discount-bps`,
`data-anticlone-installments` e `data-anticlone-installment-minor`, além do par
preço/moeda já existente. Ausência/invalidade preserva UNKNOWN. Texto visual
continua contexto humano, nunca chave de oferta, preço autorizado ou identidade.
O interpretador textual isolado não foi integrado à proteção.

Captura estruturada é **declaração não autenticada da página**, não prova de preço
no checkout. A confiança resulta da revisão administrativa da captura exata e do
mapeamento aprovado. Oferta declarada conhecida deve coincidir com a oferta do
mapeamento; a API recusa aprovação cruzada. Marcador público não prova autoridade.

Mudança conhecida é CHANGED; perda de evidência antes conhecida é UNCERTAIN;
ausência de ponto/captura também suspende a referência. Novos termos numa
referência antiga de preço/moeda exigem revisão. Ambas suspendem apenas o CTA
afetado, sem autorrecuperação quando o conteúdo retorna. A interface existente
mostra termos observados/aprovados/alerta e exige confirmação; aprovação concorrente
ou desatualizada é recusada. Reaprovação comercial é auditada, não supera revisão
de URL e muda a configuração aprovada: a página exige nova aprovação. Suspensão
operacional isolada conserva a aprovação e os demais pontos conforme D15.

Provas: `cta-commercial` (parcelas alteradas com total igual, UNKNOWN, ausência,
conflito de oferta, legado, deduplicação, concorrência, captura expirada),
`cta-selection-ui` (MFA/interface/confirmação/auditoria), `scoped-gateway`
(D15 com aprovação real e browser), `multiple-cta-surfaces` (popup, sticky,
dinâmico, WhatsApp sintético, ofertas distintas e candidato incerto).

## F18: gate visual opt-in no prazo existente

Antes: havia limite comercial de 150 ms desde execução do Bootstrap, mas nenhum
gate visual. As medidas reais demonstraram conteúdo renderizado antes de receber
a decisão. Não foi identificado gargalo de backend que justificasse refatorar
detecção/Core/seleção. A dependência existente do carregamento do Core permanece.

O proprietário pode marcar um **contêiner já presente antes do Bootstrap**:

```html
<section data-anticlone-render-gate="https://origem-propria.example">
  <!-- conteúdo escolhido explicitamente pelo proprietário -->
</section>
```

A origem deve ser exata, HTTPS (HTTP só loopback). Na própria origem não há gate;
HTML/BODY e conjuntos com mais de 20 nós marcados são recusados. Sem marcação,
o comportamento anterior é conservado. O atributo não autoriza redirecionamento,
não substitui aprovação de política e não autentica a página.

O gate usa opacity 0 apenas no escopo escolhido; preserva layout e hit testing.
Não cria overlay nem bloqueia links/eventos. Prazo é o **mesmo deadline monotônico
de 150 ms**, compartilhado com PAGE_REDIRECT, sem reiniciar ao carregar o Core.
Timeout, interação precoce, erro de Core/decisão, mudança de rota e decisão
OBSERVE_ONLY/REPLACE_CONVERSION liberam o escopo. CTA continua independente e
decide localmente quando pronto. Opacidade/prioridade e transition-property
originais são restauradas; um flush de estilo antes de restaurar a transição
impede que CSS do proprietário prolongue o efeito por segundos.

O prazo limita o timer e a admissão do redirect, **não garante navegação concluída
em 150 ms**. Timers e frames dependem do escalonamento do navegador. Scripts
bloqueados não ativam gate. Conteúdo pode aparecer antes do Bootstrap executar;
scripts async tardios, DOM dinâmico, CSS/animadores concorrentes e páginas reais
precisam de homologação. Não se promete ausência de flash ou redirect instantâneo.

`f18-timing` usa PostgreSQL e gateway reais, Chromium desktop e Pixel 7 emulado,
sem relógio virtual: mede upstream (proxy local até corpo completo), recebimento
de headers, JSON, recursos, frames/opacidade, paint por URL/timeOrigin e commit
de navegação. O tempo upstream inclui loopback/HTTP, não é tempo SQL puro.
Compara Bootstrap da base via `git show` com o atual e documento sem runtime;
três tentativas por viewport, com pelo menos uma navegação efetiva exigida,
não constituem benchmark estatístico.
Atrasos de 250 ms são aplicados ao transporte depois de obter respostas reais,
sem fabricar decisão comercial. Inclui interação precoce, indisponibilidade,
OBSERVE e CTA. Screenshots early/late acompanham os logs. `f18-gate-browser`
verifica isoladamente compatibilidade CSS/Core indisponível/limites/opt-out;
seu servidor de fixture não substitui a integração real do teste de tempos.

## Gates, resultados e limites

Reprodução focada: `wsl -d Ubuntu -- bash scripts/f25-f18-lab.sh`.
Regressão integral: mesmo comando com argumento `full` (Node 22,
PostgreSQL 16 descartável, Chromium real, lint/typecheck/build, Docker/Compose).
Artefatos locais em `test-results/f25-f18/`, fora do Git; cada wrapper registra
exportação e exit code, pipeline integral inclui manifestos/logs/hashes.

O run antigo **43098539403**, evento push de main no SHA base, estava queued na
consulta. Não foi cancelado nem alterado código para simular seu sucesso. O novo
PR usa o grupo pull_request já existente, distinto do grupo de main; workflow
oficial permanece íntegro. A CI oficial e o estado pronto serão conferidos no SHA
final do PR; queued/in_progress não são PASS e a validação local não os substitui.

Homologação externa continua necessária: LPs/destinos/WhatsApp reais do
proprietário, checkout efetivo, popup/sticky/CSS específicos, redes/dispositivos
físicos e confirmação externa de alerta. UNKNOWN não é falha a resolver por
adivinhação. Não se interceptam formulários (D07), não há venda comprovada por
clique/handoff, nem reconhecimento seguro de oferta em página hostil sem evidência.
F13/F14, SMTP, quatro classes e percentuais não foram reimplementados.

## Evidência focada e revisão

Foco do delta funcional de `863be6d2f21cc670527a2a4b8640b759238cc044`:
**6 PASS, 0 FAIL, 0 SKIP, exit 0**, em
`test-results/f25-f18/20261112T121604Z/f25-f18/focused.log`.
Node 22.23.4, PostgreSQL 16 e Chromium 156.0.8078.4 reais.

| Contexto (3 tentativas atuais) | Upstream até corpo (ms) | Headers no browser (ms) | JSON lido (ms) | Commit do destino (ms) |
|---|---|---|---|---|
| Desktop 1440 | 11,7–16,3 | 38,6–52,7 | 39,2–53,3 | 54,4–65,4; 3/3 efetivas |
| Pixel 7 emulado | 10,7–14,9 | 38,2–41,3 | 38,8–41,8 | 50,7–53,2; 3/3 efetivas |

Tempos do browser são relativos ao início do documento; commit é medido no
processo controlador desde o início do `goto`, portanto não são fases a somar.
Uma amostra anterior por viewport renderizou o documento em 32/24 ms antes do
JSON em 86,1/49,7 ms. O gate atual reduz a exposição do escopo após executar,
mas frames iniciais anteriores ao Bootstrap continuam possíveis. Não se atribui
a diferença de latência observada a otimização do backend: há aquecimento,
variabilidade e poucas amostras. Com 250 ms extras no transporte, o redirect
não ocorreu e o link original funcionou. OBSERVE e CTA liberaram o gate;
CTA navegou ao destino aprovado sem esperar nova decisão no clique.

O teste de CSS mediu liberação em **148,4 ms** entre alterações observadas.
Revisão independente `/root/f25_f18_review`, read-only, favorável ao SHA acima,
sem P0/P1/P2 pendente. Reproduções independentes Chromium: transição CSS de
2 s liberada em 149,9 ms; longhands/prioridades preservados em 150,6 ms com
escalonamento. Achados corrigidos: termos ocultos na confirmação, entrada de
referência legada sem revisão, termos perdidos na evidência de alerta,
transição prolongada e perda de longhands. Nenhuma escrita do revisor na worktree.

Regressão integral local de `863be6d`: **125 Node + 10 Python PASS**, zero
falhas/skips, pipeline exit 0. Lint, typecheck, build, imagens Docker, Compose,
PostgreSQL 16, Chromium, HTTPS/Nginx, backup/restore/rollback reais incluídos.
Testes Node em 515706 ms. Artefatos completos:
`test-results/f25-f18/20261112T121725Z/full/`; `source.sha256`, `steps.tsv`,
`evidence.sha256`, `tests.log` e `result.txt` preservam versão, comandos e resultados.
Nenhuma alteração funcional foi feita após essa execução.

**F18 e F25 concluídas em laboratório no contrato delimitado acima.** O gate
é opt-in; a captura comercial é explícita e revisada, com UNKNOWN preservado.
Isso não conclui homologação externa, não garante invisibilidade nem substitui
aprovação das LPs/destinos reais. F13/F14 e D07 permanecem como estavam.

### Primeira CI oficial e correção da instrumentação

Run **43218675626**, HEAD `6ebc315`: **124 PASS / 1 FAIL / 0 SKIP**.
Todos os testes F25/F18 passaram. A falha foi `assert.ok(armed)` na sonda
de entrada de `operator-shadow.test.ts`, que reconhecia apenas o argumento
literal `setTimeout(...,150)`. O Bootstrap agenda o restante do mesmo deadline
monotônico (por exemplo 149,9 ms); o log oficial leu PAGE_REDIRECT em 54,9 ms,
mas a sonda não havia registrado esse timer. Não houve alteração Stealth.

A instrumentação agora reconhece o timer síncrono do script `/runtime.js`,
com atraso finito entre 0 e 150 ms, e registra o atraso recebido sem modificá-lo.
As asserções de antes/depois do deadline, expiração, navegação efetiva, bytes
e CTA independente permanecem. Reprodução independente Chromium encontrou seis
timers de 150 ms e dois de 149,9 ms em oito cargas. O relatório da fixture Front3
também explicita que ela não usa opt-in visual, em vez de alegar gate inexistente.

Novo foco real **8 PASS / 0 FAIL / 0 SKIP**, exit 0:
`test-results/f25-f18/20261112T124630Z/f25-f18/focused.log`, incluindo shadow
inalterado. Revisão independente favorável à correção da sonda; nova CI oficial
no SHA final exigida. A falha anterior é preservada, não reclassificada como PASS.
