# Fechamento F25/F18 em laboratório

Base: PR #73, `e8dd1c60bcad9303967ecd77cad1145aa2dea5a7`.
Branch única `feat/f25-f18-closure`; sem merge, deploy, DNS, provedores ou
migrations de produção. Gates e SHA final serão registrados nesta entrega.

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
oficial permanece íntegro. Resultados finais e revisão independente por SHA/delta
serão registrados após execução, sem tratar queued/in_progress como PASS.

Homologação externa continua necessária: LPs/destinos/WhatsApp reais do
proprietário, checkout efetivo, popup/sticky/CSS específicos, redes/dispositivos
físicos e confirmação externa de alerta. UNKNOWN não é falha a resolver por
adivinhação. Não se interceptam formulários (D07), não há venda comprovada por
clique/handoff, nem reconhecimento seguro de oferta em página hostil sem evidência.
F13/F14, SMTP, quatro classes e percentuais não foram reimplementados.
