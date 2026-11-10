# Evidências integradas pré-VPS

Contrato opcional 054/055, sem retropreenchimento de horários. Reutiliza incidentes, investigação,
timeline visual, distribuição e handlers Core/Fallback/Canary; não cria motor ou
coletor de visitantes. Aplicar somente em laboratório autorizado nesta entrega.

`POST /admin/projects/:id/original-requests` usa o bearer administrativo existente,
obtido com senha/MFA, sem Origin de navegador. JSON estrito, máximo 2048 bytes:

```json
{"id":"00000000-0000-4000-8000-000000000001","page":"00000000-0000-4000-8000-000000000002","resource":"HTML","source":"owned_access_log","authorized":true}
```

O adaptador autorizado deve emitir um UUID estável por registro; repetição retorna
ALREADY_IMPORTED, conteúdo divergente é recusado. Classes HTML/SCRIPT/STYLE/IMAGE/OTHER;
fontes owned_access_log/authorized_provider_log. `authorized:true` é atestado do
administrador, não validação independente do provedor. Não há conexão automática
a provedores. Sem log importado, acesso original fica NOT_OBSERVABLE.
`accessed_at` opcional aceita somente UTC canônico `YYYY-MM-DDTHH:mm:ss.sssZ`,
data real e entre o relógio atual do banco e sete dias antes. Ausente/null significa
UNKNOWN; valor malformado, data impossível, futuro ou fora da janela retorna 400,
sem importar ou reter o valor bruto. A migration 055 é necessária para fornecer
esse campo. `accessed_at` é declaração do log autorizado, não verificada de forma
independente; a proveniência permanece explícita. `imported_at` é o horário do
servidor AntiClone (a coluna existente first_received_at), imutável no replay.
Repetir ID com horário diferente, inclusive null versus conhecido, é conflito.
Não importar headers, URLs, IPs, cookies, credenciais ou conteúdo de formulário.
O contrato recusa campos extras; horário nunca prova download completo, clonagem
ou identidade. Respostas de importação e replay preservam a proveniência.

Recursos e contatos recebidos pelo gateway preservam LP/instalação resolvidas no
servidor, recurso, fonte, alias efetivamente roteado quando disponível e hostname
alegado quando fornecido. Host IP literal é omitido. UUIDs públicos não autenticam
o solicitante. Entrega de script não prova execução; Referer/Origin não verificam
hostname. Core/Fallback continuam responsáveis pelos incidentes existentes;
recibos e canários passivos não criam incidentes nem mitigam. Rotas legadas sem
LP demonstrável conservam os agregados anteriores, sem inventar vínculo.

Registros têm retenção de sete dias e teto de 10 mil por projeto. Com accessed_at,
expiram na primeira das janelas de sete dias do acesso declarado e da importação;
importar log antigo não reinicia sua janela. Leituras ocultam expirados antes da
limpeza periódica. Idempotência dura enquanto o registro está retido. Recibos runtime
deduplicam por minuto/contexto/fonte/recurso/alias/host; primeiro horário retido
é o do bucket observado, sem contagem ou identidade de visitante. Persistência
complementar tem uma tarefa ativa por pool e até 100 pendentes, sem espera no
fornecimento de scripts; pool com menos de duas conexões não coleta esses recibos.
Replays do bucket consultam o índice antes da limpeza/contagem. Falha,
saturação, reinício, retenção e ausência deixam cobertura incompleta. Manutenção
existente limpa mesmo sem tráfego. Exclusão lógica conserva âncoras históricas;
a FK impede apagar fisicamente LP/projeto com evidência retida.

Painel existente apresenta os eventos no histórico do incidente. Contexto comum
de LP é uma relação explícita, não uma relação entre visitantes: registros sem
hostname aparecem como contexto da instalação. Não são atribuídos como acesso
da cópia. DNS mantém proveniência e tempo, não IP do visitante; ASN/hosting sem
fonte continuam indisponíveis. CTA e tráfego mantêm os históricos já existentes,
sem converter proximidade temporal em causalidade.

A investigação retorna no máximo 13 recibos por incidente: dez do hostname
alegado e três compartilhados pelas LPs vinculadas. Preserva o menor horário
disponível (acesso declarado quando conhecido) e os registros recentes, com total
e quantidade omitida explícitos. A avaliação contextual resume categorias, sem
duplicar milhares de fontes equivalentes nem mudar UNCERTAIN. A cronologia
separa acesso declarado e importação e avisa que a prévia é incompleta.
`GET /admin/projects/:id/investigation-receipts?after=<id>&page=<LP opcional>`
consulta todo o histórico retido em páginas de 100 registros, cursor ID crescente,
isolado por projeto e opcionalmente LP. Cursor é decimal estrito, sem OFFSET.
O painel oferece a mesma consulta com sessão/CSRF existente e substitui a página
exibida, sem acumular histórico no DOM. Ordem de ID não é ordem de acesso; retenção
e importações concorrentes podem alterar as próximas páginas. Legado 054 sem 055
continua legível, com accessed_at UNKNOWN; não há backfill inventado.

F13/F14 explicam apoio limitado (requisição recebida), objeções e requisitos para
hipótese de operador. Nenhuma fonte atual estabelece vínculo independente,
verificável e atual com a sessão/contexto: produção continua UNCERTAIN. Confirmação
administrativa da cópia não confirma sessões. Uma decisão forte futura exige
novo contrato de evidência verificável, validade/contexto explícitos e testes
adversariais; esta entrega não aceita alegação de independência pelo cliente.
D05 permanece intacta: OFF não veta por risco, ON conserva política em UNCERTAIN,
HIGH forte apenas fixture de laboratório; legado exige republicação/reaprovação.

F08 permanece BLOCKED: `docker inspect -f '{{.HostConfig.NetworkMode}}'
anticlone-investigation-lab` retorna `host`. Esse laboratório não demonstra egress
deny-by-default, isolamento UDP/WebRTC ou proteção contra DNS rebinding de um
navegador verificador. Não foi criado fetch/navegador de URLs arbitrárias. Os
negativos existentes recusam verify; Nginx/TLS sintético não resolve essa fronteira.

Provas: investigation-chain.test.ts (original controlado, cópia parcial Chromium,
idempotência, isolamento LP/projeto, minimização, retenção e falha de coleta),
runtime-distribution.test.ts (aliases reais e quatro fontes com 054).
investigation-volume.test.ts valida timestamps, paginação completa a 9.900 recibos/
100 incidentes e 100 persistências concorrentes, com tamanho, heap/RSS amostrados,
tempo de consulta/persistência e entrega real de script sob lock. Métricas são do
laboratório, não SLA nem medição de pico absoluto de memória. Preserva-se a regressão
existente de D05, tempos, fail-open, DNS, F44/F45 e autorização. Resultados e SHA
efetivamente executados ficam no PR; implementação não equivale a teste aprovado.

Antes da VPS ainda faltam F08 isolado, fonte operacional forte de operador,
provedores/logs externos autorizados, compatibilidade além do laboratório e as
capacidades integrais ainda PARCIAL/P na matriz (incluindo formulários D07,
checkout comercial externo e cobertura de perdas anteriores ao gateway).
