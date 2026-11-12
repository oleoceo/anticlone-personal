# F29/F31 — catálogo e Custom Webhook em laboratório

Base: `fdcc453153e5d8c49481d8fa106ba7f6f7ce9cb1` (#74). Uma frente,
uma branch `feat/f29-f31-multiprovider`; sem merge, deploy, conta externa ou
migration de produção. O painel/stack D16 e o runtime são preservados.

## Revisão do PR #75 após `2bf9a04`

Correções solicitadas pelo proprietário permanecem na mesma branch/PR. Migration
**064** é aditiva; 063 não foi reescrita. Não há operação em produção.

**Moeda e precisão.** Um modelo de expoente 2 recusa JPY, inclusive em `MINOR`;
não se usa arredondamento nem uma suposição de duas casas para moedas desconhecidas.
O subconjunto explícito validado na [List One da SIX, agência ISO 4217](https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml)
em 2026-11-12 é: BRL/USD/EUR/GBP/CAD/AUD/CHF = 2, JPY = 0,
KWD/BHD/OMR/TND/JOD = 3. Outras moedas são recusadas, não inferidas. Um único
modelo com expoente fixo pode receber somente moedas compatíveis. Acrescentar outra
moeda exige alteração de código/revisão da tabela, não um expoente arbitrário no painel.
Montantes históricos nunca são retroconvertidos. Pedidos legados incompatíveis recebem
`UNVERIFIED_HISTORICAL_CONTRACT`; montantes agregados da moeda ficam `null` até
reconciliação com fonte autorizada. A contagem/evento e o valor original são preservados.

**Migração da conta.** `migration-prepare` recebe conexão, revisão esperada, versão
global superior do mesmo modelo, revisão explícita e duas amostras sintéticas do mesmo
evento (atual/nova). Os resultados canônicos precisam coincidir. Caminhos de
evento/pedido/produto/oferta/checkout/moeda permanecem iguais; renomear identidade
ou alterar namespaces requer adaptador com contrato autorizado, não heurística.
Pode mudar caminhos de valor/status/horário, unidade monetária ou algoritmo suportado.
Uma preparação pendente por conta; não se cria outra conta nem se remove a unicidade.

Preparar não ativa o formato. O remetente próprio envia teste **explicitamente
marcado**, autenticado com a chave existente. Testes não gravam venda ou recibo
financeiro, nem mudam um pedido real. Pedido real no formato pendente recebe 409
retryable. `migration-commit` exige revisão atual, confirmação explícita e teste
autenticado dessa versão nas últimas 24 horas; `migration-cancel` elimina apenas a
preparação e a amostra candidata, preservando a auditoria. Ambos incrementam a revisão
da conta, como preparação, rotação e mudança de estado. Edições/commits concorrentes
são serializados e versões obsoletas recebem 409.

A conexão conserva ID, conta, chave e ledger. O ponteiro do modelo avança; formatos
aceitos anteriores continuam registrados. **Sem cabeçalho de versão, usa-se sempre a
versão original da conexão**, não a versão mais recente. Não se tenta reconhecer o
formato por conteúdo. Para formato explícito:

- `x-checkout-model-version`: inteiro decimal positivo da versão global já preparada/aceita.
- `x-checkout-test: 1`: somente para teste explícito; exige cabeçalho de versão.
- HMAC cobre `timestamp + "." + version + "." + intent + "." + bytes`, onde
  `intent` é `test` com o cabeçalho acima, e `event` sem ele.
- Sem versão, o contrato antigo `timestamp + "." + bytes` continua intacto.

Versão e intenção não podem ser adicionadas/trocadas/removidas sem invalidar a
assinatura. Ambos os algoritmos usam timestamp em segundos, tolerância absoluta de
300 s, corpo JSON até 2048 bytes e chave hex decodificada. SHA256 recebe assinatura
hex minúscula de 64 caracteres; SHA512, 128. Nenhum cabeçalho/algoritmo/expressão
arbitrária é executado. Chaves continuam apenas no servidor.

Eventos/pedidos continuam únicos por conexão, independentemente do formato. Pedido
guarda a versão em que surgiu; recibo guarda a versão processada. Recibos novos têm
digest canônico além do digest bruto: a mesma identidade/evento comercial normalizado
em formatos distintos é duplicata, não outra venda. Divergência canônica recebe 409.
Recibos legados não ganham digest canônico inventado: repetição byte a byte continua
aceita; apresentação com bytes diferentes sem prova canônica é recusada, sem inflar
receita. Estornos antigos e eventos concorrentes antigos/novos mantêm o mesmo pedido.

**Painel e amostras.** Modelos/versões, contas, projetos, LPs, vínculos, ofertas,
checkouts e histórico existentes podem ser escolhidos em seletores; IDs não precisam
ser transcritos. Produtos/ofertas/checkouts já cadastrados também aparecem como
sugestões na criação de vínculo. Editor guiado monta caminhos, unidade, expoente,
autenticação e estados; JSON avançado continua disponível. Aliases de status são
listas explícitas separadas por vírgula e sobrevivem a alterações de outros campos.
Criar conta, ativar ou migrar continuam ações explícitas.

Inspeção de amostra sintética e amostra recebida mostram tipos e caminhos de um
vocabulário fixo (por exemplo `data.payment.amount`, `event_id`, `currency`). Valores
nunca aparecem; nomes de chave desconhecidos são omitidos, pois também podem conter
segredos/dados pessoais. Campos particulares fora desse vocabulário precisam ser
informados a partir do contrato/sintético autorizado. Não há payload bruto em banco
ou logs. Amostras de cada formato ficam em `commerce_version_samples` por 24 h de
consulta, com limpeza no próximo recebimento. A tabela legada é preservada para
compatibilidade; remoção de amostra legada invalida os testes de sua conexão, podendo
exigir reteste. Rotação invalida testes de ambas as tabelas.

**PAID → CANCELLED.** Cancelamento não demonstra refund, chargeback ou retenção.
Sem estorno posterior, `net_amount_minor` fica `null`, e o montante incerto é mostrado
separadamente. `reported_balance_minor` é apenas pagamentos reportados menos estornos
reportados. `financial_basis=REPORTED_EVENTS_NOT_SETTLEMENT` e `settled_revenue=null`
impedem apresentá-lo como liquidação bancária. Um refund posterior resolve o saldo
aritmético reportado, mas não comprova transferência bancária ou recuperação.
F30 continua rotulada e separada, sem alteração de fórmula.

**Autenticação e provedores.** Em `2bf9a04`, somente SHA256/timestamp era suportado.
A menor extensão implementada/testada nesta revisão é SHA512/timestamp, com contrato
fechado e a mesma proteção de replay. Isso não equivale a suporte real a empresas.
Hotmart, Kiwify, Lowify, Cakto, Lemon Squeezy e checkout particular do proprietário
continuam **não homologados**. Se o contrato real não coincidir exatamente com esses
headers/bytes/identidades, exige adaptação específica autorizada. Bearer estático,
assinatura sem timestamp, OAuth, desafios de assinatura, JWS/certificados, verificação
por API e autenticação arbitrária não foram habilitados. Não criamos adaptadores por
marca sem contrato/ambiente autorizado. Atribuição e chegada continuam sem suporte.

**Rollback e recuperação.** O schema conserva a tabela/PK de amostras legada e
triggers de compatibilidade para conexões, pedidos e recibos. O teste compila o
executável exato `2bf9a04` e exercita criação de conta, teste, ativação, recebimento e
duplicata sobre 064 **antes** de migrar o formato da conta. Após a migração, o binário
antigo não conhece assinatura versionada/algoritmo novo; inserts financeiros sem versão
são bloqueados, inclusive quando a transação já tentou atualizar um pedido. Não há
rollback comercial transparente nessa situação: manter receptor compatível ou
restaurar código + backup isolado anterior de forma coordenada com o remetente e
reenvio dos eventos posteriores. Não apagar/down-migrar o ledger para retroceder.
O ensaio geral de backup/restore/rollback e os probes temporais continuam separados.

**Prova da revisão.** Foco ampliado `commerce`: 5/5 PASS, sem falhas/skips, PostgreSQL
e Chromium reais. Inclui backfill064 com montante legado incompatível, executável
`2bf9a04`, recebimento/duplicata antes da migração, bloqueio transacional depois dela,
ambos os HMACs, dinheiro persistido para BRL/USD/JPY/KWD/BHD, transição concorrente,
teste expirado, eventos antigos, seletor e cancelamento no painel, aliases e bloqueio
de salvar/testar JSON antigo quando controles estão inválidos. Revisão independente
read-only `/root/pr75_revision_review`: foco próprio 5/5 PASS, parecer favorável sem
P0/P1/P2 pendente. SHA256 revisados: núcleo `B5607D5AC64BBF7F35481987C19A66503AABB23D581BC6D82085421CB11B78B3`,
UI `869B7323C379F28DB4AD95566E05431B191503A27777B34C48107B2CBCD37CF6`,
064 `CDA7D55222253A8DD639883BF8BA9B3845BFB1BC1B830514023512E9978F7123`,
teste `C53A477894B1B82B097DD609D11AF287F9730B5D4248AFDFF52E705D237AF1B0`.
Lint/typecheck/build passaram. Regressão integral e CI oficial do novo SHA devem ser
conferidas no PR75; o gate anterior de 127 testes não valida estas alterações.

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
conexão existente. Não há atualização automática de conexão: a migração controlada exige revisão, teste autenticado e confirmação; ver a revisão do PR75 abaixo.

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

Autenticação efetivamente suportada: `HMAC_SHA256_TIMESTAMP` e `HMAC_SHA512_TIMESTAMP`, JSON UTF-8, POST,
`Content-Type: application/json`, até 2048 bytes. Cabeçalhos:

- `x-checkout-timestamp`: Unix segundos, dez dígitos, desvio máximo absoluto 300 s.
- `x-checkout-signature`: HMAC-SHA256 ou HMAC-SHA512 conforme modelo, em hex minúsculo sobre
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
timestamp. Eventos novos deduplicam também pela interpretação canônica; recibos legados sem digest canônico exigem os mesmos bytes e recusam conflito com 409. Não reutilize ID de evento para outro estado.

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

Persistência de amostra: tipos, posições genéricas e caminhos do vocabulário fixo,
sem valores ou chaves arbitrárias, uma por conexão/formato e janela consultável de 24 h; limpeza no próximo webhook.
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
| Rotação da chave mestra | Não suportada; chave do remetente tem rotação funcional e conexão tem migração revisada entre versões |

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
Revisão final documental e dos testes também favorável na sessão independente
`/root/commerce_review`, sem achados pendentes. Prova do CLI Linux é do implementador;
o revisor executou novamente o foco Windows 2/2 PASS e verificou recusa de provisão.
Código entregue no [PR #75](https://github.com/oleoceo/anticlone-personal/pull/75).
Resultados da regressão integral e CI oficial são registrados no PR pelo SHA final;
gates em execução não são aprovação. O snapshot local inicial ainda tinha expectativa
fixa 062 no teste de upgrade; a correção 063/064 passou no foco Linux final acima.

CI oficial inicial `43265992161` em `847ac4f`: 126 PASS / 1 FAIL / zero skips.
Única falha: jornada mobile aguardando PAGE_REDIRECT selecionado, sem medição
do deadline nessa falha. A matriz confundia seleção lógica com garantia de navegar
em 150 ms; expiração é hipótese consistente, não causa medida. O harness agora
congela o relógio somente nessa matriz PAGE selecionada, sem interceptar HTTP nem
alterar runtime. F18/GS06/shadow mantêm tempo real e casos de fail-open atrasado.
As demais asserts e destinos continuam obrigatórios; não se lê body de resposta
depois que a navegação selecionada já descartou o contexto do navegador.
Foco Linux da correção: 5/5 PASS, zero falhas/skips em 66,7 s: jornada 1440/390,
F18 visual, F18 transporte/paint/navegação em tempo real e GS06. Revisão independente
favorável de `/root/commerce_review`, SHA256 do harness
`094DE429895B10073E6C89DEC5ED3BFB72C3E181E32209E8BAB7694136C80D9C`;
nenhuma mudança de código funcional após a revisão anterior.
