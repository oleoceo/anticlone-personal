# F29/F31 — catálogo e Custom Webhook em laboratório

Base: `fdcc453153e5d8c49481d8fa106ba7f6f7ce9cb1` (#74). Uma frente,
uma branch `feat/f29-f31-multiprovider`; sem merge, deploy, conta externa ou
migration de produção. O painel/stack D16 e o runtime são preservados.

## Contrato implementado

`063_checkout_integrations.sql` acrescenta modelos globais imutáveis por
`(id,version)`, conexões por conta presas à versão aprovada e vínculos comerciais
versionados por projeto/LP. Nenhuma tabela depende de marca. Uma conexão atende
vários projetos; um projeto usa várias contas/plataformas simultaneamente.
O par modelo/conta não pode ser cadastrado duas vezes. IDs de conta devem ser
identificações comerciais não pessoais. Não há descoberta de contas equivalentes
criadas sob modelos diferentes: o operador não deve cadastrar a mesma fonte duas vezes.

No painel existente, após login com MFA: **Integrações globais de checkout**.
O editor JSON configura os caminhos e estados; **Testar interpretação sem salvar**
mostra a normalização comercial, sem gravar a amostra. Salvar exige marcar a revisão
explícita e envia novamente uma amostra válida. O modelo novo nunca modifica uma
conexão existente. Não existe atualização automática/in-place de conexão para outra
versão: requer homologação de compatibilidade, especialmente dos eventos atrasados.

Criar conexão gera endpoint relativo `/commerce-webhook/<uuid>` e chave aleatória
no servidor, criptografada com AES-256-GCM, IV aleatório e ID da conexão como AAD.
Configure `COMMERCE_ENCRYPTION_KEY` com 32 bytes hexadecimais no ambiente privado
do servidor de laboratório. A aplicação não gera, registra ou publica a chave mestra.
Sem chave válida, criação/provisão/recebimento falham fechados; módulos antigos
continuam independentes. Preserve a chave em backup privado para recuperar as conexões.

O navegador nunca recebe credenciais de checkout, mesmo na criação/rotação.
Para provisionar o remetente próprio, no **servidor Linux/WSL**, em diretório privado:

```sh
node dist/apps/commerce-provision.js CONNECTION_UUID /private/new-sender-key
```

O comando usa `DATABASE_URL` e `COMMERCE_ENCRYPTION_KEY` do ambiente do servidor,
cria arquivo novo exclusivamente (`wx`, `0600`) e nunca imprime a chave. Recusa
Windows, onde esse modo não comprova ACL. Transfira ao remetente somente por canal
privado autorizado; não use diretório compartilhado, argumento de linha de comando,
Git, logs ou formulário do painel. Rotação usa versão esperada, invalida a chave
anterior imediatamente e remove o teste de conexão anterior. Não oferece sobreposição
de chaves; o remetente deve poder reenviar eventos após a rotação coordenada.
Rotação da chave mestra exige procedimento de recriptografia ainda não implementado;
não troque simplesmente a variável de ambiente.

Conexão nasce `TEST`: envio autenticado válido grava somente estrutura sanitizada,
sem criar venda. Após esse teste, o operador escolhe `ACTIVE` explicitamente.
`INACTIVE` e `ARCHIVED` recusam novos pedidos, preservando pedidos/eventos anteriores.
Pedidos existentes continuam recebendo estornos, cancelamentos e eventos atrasados
inclusive em `TEST`. Não há exclusão física de histórico financeiro.

Os vínculos exigem pelo menos um identificador configurado de produto/oferta/checkout.
Campos comerciais sem caminho configurado usam identidade vazia, nunca wildcard.
A tupla inteira deve coincidir. Identidade comercial é permanente: preço, URL e estado
ganham revisão; mudar projeto/LP/identificadores exige outro vínculo. A mesma tupla
na mesma conta não pode apontar a dois vínculos, mesmo após arquivamento. Isso evita
reatribuir silenciosamente pedidos atrasados. Pedido guarda a revisão original.
Eventos sem vínculo inequívoco são mantidos como origem comercial desconhecida e
nunca são retroatribuídos automaticamente. Preço cadastrado não substitui valor pago
autenticado: descontos são possíveis; a moeda do vínculo deve coincidir.

Esses vínculos são contabilidade observada, não autorização de proteção. Criar ou
editar URL/preço não muda `cta_destinations`, mappings, snapshots ou aprovações.
Para efetivar destino protegido, continuam obrigatórias F20/F25/D15 pelo fluxo existente.

## Checkout próprio de referência (sintético)

Autenticação efetivamente suportada: `HMAC_SHA256_TIMESTAMP`, JSON UTF-8, POST,
`Content-Type: application/json`, até 2048 bytes. Cabeçalhos:

- `x-checkout-timestamp`: Unix segundos, dez dígitos, desvio máximo absoluto 300 s.
- `x-checkout-signature`: HMAC-SHA256 em hex minúsculo sobre
  `timestamp + "." + bytes_exatos_do_corpo`, chave decodificada de hexadecimal.

Exemplo de configuração e payload executáveis em `tests/commerce.test.ts` e
preenchidos no formulário Custom:

```json
{
  "auth": "HMAC_SHA256_TIMESTAMP",
  "fields": {"event":"event","order":"order","amount":"amount","currency":"currency","status":"status","occurred":"occurred","product":"product","offer":"offer","checkout":"checkout"},
  "statuses": {"paid":"PAID","pending":"PENDING","cancelled":"CANCELLED","refunded":"REFUNDED","chargeback":"CHARGEBACK"},
  "money": {"unit":"DECIMAL","exponent":2}
}
```

```json
{"event":"evt_1","order":"order_1","amount":"19.99","currency":"BRL","status":"paid","occurred":"2026-11-12T00:00:00.000Z","product":"product_a","offer":"offer_a","checkout":"checkout_a"}
```

Caminhos: propriedades próprias separadas por ponto, profundidade até 8,
comprimento até 160; sem arrays, JSONPath, JavaScript, protótipos ou expressões.
IDs de evento/pedido/produto/oferta/checkout: até 128 caracteres alfanuméricos,
`_` e `-`. Ao menos um dos três caminhos comerciais é obrigatório; os demais podem
ser omitidos no modelo. `reference` é caminho opcional: sua ausência não invalida
uma compra normal. Presença de referência não autentica atribuição.

`MINOR` exige inteiro seguro; `DECIMAL` exige string decimal, sem arredondamento
binário e com precisão máxima igual ao expoente configurado (0–3). Limite 10^12
unidades mínimas; moeda de três letras maiúsculas. O expoente é explícito por modelo,
não inferido de texto ou locale. Timestamp comercial ISO UTC canônico com milissegundos,
até cinco minutos no futuro; eventos antigos autenticados são permitidos.

200 confirma processamento persistido, duplicata ou teste (campo `mode:TEST`);
400 payload/mapeamento inválido; 401 autenticação; 409 conflito de identidade/versão
ou conexão inativa para pedido novo; 413 tamanho; 429 orçamento; 503 indisponibilidade.
Remetentes devem reenviar com os mesmos IDs após falha transitória, assinando novo
timestamp. JSON semanticamente igual com bytes diferentes no mesmo evento gera 409:
o remetente deve preservar bytes. Não reutilize ID de evento para outro estado.

Deduplicação por `(connection_id,event_id)` e identidade de pedido por
`(connection_id,order_id)`. Montante/moeda/identificadores do pedido são imutáveis.
Transações e lock serializam recebimento/configuração; versões esperadas recusam
edições concorrentes. Status usa precedência monotônica PENDING < PAID < CANCELLED
< REFUNDED < CHARGEBACK: PAID atrasado não ressuscita pedido ajustado.
PAID reportado tem data própria; ajuste terminal e estorno financeiro têm datas
próprias, tomando a primeira ocorrência autenticada de cada categoria. Um estorno
integral é debitado uma vez, mesmo com refund seguido de chargeback. CANCELLED
nunca é interpretado automaticamente como devolução de dinheiro.

O processador tem orçamento global de 120 requisições/minuto, oito admissões
simultâneas, corpo limitado e timeout de leitura de cinco segundos; a borda HTTPS
mantém seus controles anteriores e permite apenas a rota UUID nova. Nenhuma consulta
externa é executada: não existe superfície de SSRF de verificação por API nesta versão.

## Observação, retenção e relatórios

Persistência de amostra: somente tipos e posições genéricas, sem valores **ou chaves
originais**, uma por conexão e janela consultável de 24 h; limpeza no próximo webhook.
Não equivale a apagamento físico exato em 24 h durante ociosidade. Não há payload bruto
persistido/logado. Configuração revisada mostra seus próprios caminhos no catálogo.
Ledger financeiro conserva IDs comerciais, valores, timestamps e digest para
idempotência durável; sua purga/anonimização não está autorizada nem implementada.
Auditoria de configuração guarda entidade/operação/versão, sem credenciais ou payload.

Relatório novo: todos os projetos ou projeto/LP/oferta/checkout/modelo/período;
moedas permanecem em grupos separados. Exibe vendas reportadas brutas, ajustes,
estornos, líquido reportado, estados atuais e origens comerciais desconhecidas.
Vendas usam data de PAID; estornos usam data de REFUNDED/CHARGEBACK, podendo haver
líquido negativo num período de devoluções sem novos pagamentos. Não é receita
recuperada. Contagens de estado são snapshot atual dos pedidos que participam do período,
não uma reconstrução histórica do estado naquele dia.

Sessões, decisões, cliques, redirects e handoffs mantêm suas fontes e evidências.
Observações/decisões têm cobertura máxima de sete dias; pedido de período maior não
reconstrói dados expirados. Preparação não vira clique nem chegada.
F30 consolida a fórmula existente em numeradores inteiros por moeda, com premissa
mais recente de cada projeto e denominador 10000; exibe `ESTIMATE` separadamente.
Filtros de tráfego/proteção não classificam vendas sem cadeia verificável (`currencies:null`).
Filtros comerciais não inventam segmentação de observações (`observations:null`).
O relatório HMAC legado permanece disponível separadamente; não some fontes legadas e
novas quando representam os mesmos pedidos. Não há importação/migração automática
do ledger legado, pois falta identidade de conta confiável para deduplicá-lo.

## Matriz de entrega e limites

| Capacidade | Estado |
|---|---|
| Catálogo global, revisão/teste Custom e versões presas | Implementado; prova PostgreSQL/Chromium em commerce |
| Várias contas, plataformas, projetos e checkouts; reativação/histórico | Implementado; commerce |
| HMAC, replay temporal, concorrência, dedup e conflitos | Implementado; commerce + checkout-webhook legado |
| Cancelamento, refund/chargeback integrais e eventos fora de ordem | Implementado; commerce, inclusive modo TEST e datas independentes |
| Relatórios consolidados e estimativa F30 por moeda | Implementado; commerce; regressões existentes preservadas |
| Provedor/checkout particular real | Pendente de contrato, credenciais e laboratório autorizado; nenhuma marca homologada |
| Chegada autenticada por destino instrumentado | Não suportada pelo Custom atual; `null`, nunca inferida de clique |
| Atribuição verificável REPLACE_CONVERSION/PAGE_REDIRECT | Não suportada pelo Custom atual; todas as vendas `UNVERIFIED` |
| Entrada temporária no domínio original | Estudada: exigiria recibo limitado, contexto aprovado e instrumento confiável; não implementada sem cadeia ponta a ponta |
| Verificação autorizada por API | Não suportada; requer adaptador restrito e testes de SSRF antes de habilitar |
| OAuth, assinaturas específicas, arrays e campos calculados | Não suportados; adaptador pequeno somente com contrato autorizado |
| Estornos parciais, mudanças de moeda/valor no mesmo pedido, múltiplas capturas | Não suportados; não aproximados como refund integral |
| Rotação da chave mestra/revisão in-place da conexão | Não suportada; chave do remetente tem rotação funcional |

Não há parâmetro novo em URL, fetch em clique, redirecionador obrigatório ou alteração
de F18/F20/F21/F23/F24/F25/F42. D05/D07/D08/D09/D15/D16 permanecem. Checkout exclusivo
não é prova de recuperação. O laboratório sintético não comprova integração com o
checkout particular do proprietário. F29/F31 integrais continuam com lacunas de
instrumentação/atribuição explicitamente visíveis; não são declaradas integralmente
concluídas apenas pelo catálogo e pelo ledger multiprovedor.

## Provas

Foco Windows, PostgreSQL16 descartável e Chromium reais: `commerce` 2/2 PASS;
foco combinado `commerce/checkout-webhook/observed-metrics/attribution/allocation/gs06/gs08`
10/10 PASS, zero falhas/skips. Suíte ampliada inclui datas separadas de eventos,
estorno em TEST, cancelamento sem débito, referência ausente e edição concorrente.
Comandos: `npm run build`, `node --test --test-concurrency=1 dist/tests/commerce.test.js`
com `TEST_DATABASE_URL` exclusivamente de laboratório. Lint/typecheck/build passaram.
Foco Linux final `commerce` + `front3-upgrade`: 3/3 PASS, sem skips, incluindo
provisão em arquivo `0600` com recusa de sobrescrita, upgrade 001–063, falha atômica
064, restore PostgreSQL e rollback do executável. A expectativa fixa do teste de
upgrade foi estendida de 062 a 063 para acompanhar a migration aditiva.
Revisão independente read-only `/root/commerce_review`: favorável ao delta funcional,
sem P0/P1/P2 pendente. SHA256 revisados: `commerce.ts` `5A07A08B0753642F412F98BEFA620649FDEE9FEFEBB281B70674994EDAFE381E`,
mapping `0A4CE2FD1CB5E75F60EFE56612C2DF5A013850BBFCD317930346E0571CB7D42D`,
migration `9E287D1628F97E3D3F96684274EDD3693EE6300AD054565D813C8BC0FE3C0CBA`.
Achados corrigidos e reensaiados: datas por categoria, estornos em TEST, chaves de
amostra, referência ausente, provisão POSIX e cancelamento sem débito financeiro.
Regressão Linux, revisão independente final e CI oficial: registrar resultado real
no PR e STATUS; gates em execução não são aprovação.
