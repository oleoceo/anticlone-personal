# Contrato genérico de checkout

F31/GS14 parcial. `POST /checkout-webhook` no gateway é desabilitado por padrão.
O administrador configura `CHECKOUT_WEBHOOK_SECRET` privado: 32–64 bytes aleatórios
codificados em hexadecimal minúsculo. O segredo pertence somente ao projeto do
processo (`PROJECT_ID`), nunca ao browser. Não há busca de URLs nem adaptador
externo implícito. Aplicar migration 035 em banco autorizado antes de habilitar.

Headers: `Content-Type: application/json`, `X-Checkout-Timestamp` (Unix segundos)
e `X-Checkout-Signature` (hex HMAC SHA-256). Assinar os bytes UTF-8 exatos de
`timestamp + '.' + corpo` com a chave decodificada do hexadecimal. Tolerância de
relógio: 300 segundos. Um retry posterior deve ser novamente assinado. Requisições
de browser são recusadas; máximo 2048 bytes e 120 tentativas/minuto por processo,
além dos limites HTTPS existentes.

Corpo estrito, sem campos de cliente:

```json
{"event_id":"evt_1","sale_id":"sale_1","amount_minor":1999,"currency":"BRL","occurred_at":"2026-11-06T00:00:00.000Z"}
```

IDs usam letras ASCII, números, `_` ou `-`, até 128 caracteres. Valor é inteiro
não negativo em unidades menores da moeda, até 10^12. Moeda tem três letras
maiúsculas; adaptadores autorizados devem normalizar a moeda e sua escala antes
de assinar. Data exige formato UTC com milissegundos, calendário válido.

Evento repetido com bytes diferentes retorna 409. Outro evento para a mesma venda
com valor, moeda ou data divergentes também retorna 409. Duplicatas equivalentes
retornam 200 com `duplicate:true`. Identidades são isoladas por projeto. Vendas e
recibos mínimos são preservados para idempotência durável; não há payload bruto,
PII ou segredo persistidos. Refunds, cancelamentos, retenção contábil configurável
e integração específica ainda exigem implementação; não enviar esses eventos
como se fossem novas vendas.

`GET /admin/projects/:id/checkout-metrics` exige a autenticação administrativa
existente. Agrupa vendas reportadas por moeda, sem somar moedas distintas. A
assinatura autentica o remetente configurado; a atribuição à proteção permanece
`UNVERIFIED`. Receita recuperada, estimativa, cliques e handoffs indisponíveis
são `null`, nunca zeros fabricados. Nenhuma venda externa real foi validada.
Trocar o projeto no painel invalida a consulta anterior e limpa seus resultados;
respostas ou erros tardios não substituem o resultado do projeto selecionado.

Teste focado: `npm run build` e `node --test dist/tests/checkout-webhook.test.js`
com `TEST_DATABASE_URL` de laboratório. Cobre PostgreSQL real, concorrência,
reinício, assinatura, expiração, conflitos, isolamento e consulta autenticada.
`tests/https-gateway.test.ts` também envia eventos sintéticos pelo Nginx HTTPS
na CI Linux obrigatória. Não habilitar provedor real sem autorização e teste.

Gateway multiprojeto: rotas autenticadas com segredos distintos e transicao do endpoint legado em [MULTIPROJECT-TRANSITION.md](MULTIPROJECT-TRANSITION.md).
