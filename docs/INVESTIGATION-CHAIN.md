# Evidências integradas pré-VPS

Contrato opcional 054, sem retropreenchimento. Reutiliza incidentes, investigação,
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
a provedores. Sem log importado, acesso original fica NOT_OBSERVABLE. Horário do
servidor é o da importação; horário do acesso original é UNKNOWN. Não importar
headers, URLs, IPs, cookies, credenciais ou conteúdo de formulário. O contrato
recusa campos extras, inclusive timestamps; não promete reconstruir logs antigos.

Recursos e contatos recebidos pelo gateway preservam LP/instalação resolvidas no
servidor, recurso, fonte, alias efetivamente roteado quando disponível e hostname
alegado quando fornecido. Host IP literal é omitido. UUIDs públicos não autenticam
o solicitante. Entrega de script não prova execução; Referer/Origin não verificam
hostname. Core/Fallback continuam responsáveis pelos incidentes existentes;
recibos e canários passivos não criam incidentes nem mitigam. Rotas legadas sem
LP demonstrável conservam os agregados anteriores, sem inventar vínculo.

Registros têm retenção de sete dias e teto de 10 mil por projeto. Recibos runtime
deduplicam por minuto/contexto/fonte/recurso/alias/host; primeiro horário retido
é o do bucket observado, sem contagem ou identidade de visitante. Persistência
complementar limitada a 100 tarefas pendentes não bloqueia navegação; falha,
saturação, reinício, retenção e ausência deixam cobertura incompleta. Manutenção
existente limpa mesmo sem tráfego. Exclusão lógica conserva âncoras históricas;
a FK impede apagar fisicamente LP/projeto com evidência retida.

Painel existente apresenta os eventos no histórico do incidente. Contexto comum
de LP é uma relação explícita, não uma relação entre visitantes: registros sem
hostname aparecem como contexto da instalação. Não são atribuídos como acesso
da cópia. DNS mantém proveniência e tempo, não IP do visitante; ASN/hosting sem
fonte continuam indisponíveis. CTA e tráfego mantêm os históricos já existentes,
sem converter proximidade temporal em causalidade.

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
runtime-distribution.test.ts (aliases reais e quatro fontes com 054), e regressão
existente de D05, tempos, fail-open, DNS, F44/F45 e autorização. Resultados e SHA
efetivamente executados ficam no PR; implementação não equivale a teste aprovado.

Antes da VPS ainda faltam F08 isolado, fonte operacional forte de operador,
provedores/logs externos autorizados, compatibilidade além do laboratório e as
capacidades integrais ainda PARCIAL/P na matriz (incluindo formulários D07,
checkout comercial externo e cobertura de perdas anteriores ao gateway).
