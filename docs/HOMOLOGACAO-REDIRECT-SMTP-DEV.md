# Redirecionamento e alertas no Dev

## Redirecionamento

O hostname `protect.leoceo.online` é atendido pelo serviço
`anticlone-dev-public-gateway` em modo OPERATIONAL via NPM e mTLS. O serviço
`anticlone-dev-gateway` na porta privada 13002 responde em PILOT_OBSERVE.
A sonda com a credencial de monitor retornou a saúde do processo público.
O mesmo monitor recebeu HTTP 403 fora de `/healthz`, o TLS recusou a conexão
sem certificado de cliente e `/admin` no hostname público retornou HTTP 404.

| Verificação no Chromium em 21/11/2026 (UTC) | HTTP | Decisão | Duração da requisição | URL final |
| --- | --- | --- | --- | --- |
| Cópia antes da autorização | 200 | `OBSERVE_ONLY` | 143 ms | Cópia |
| Cópia às 20:38, após autorização | 200 | `PAGE_REDIRECT` v2 | 317 ms | Cópia |
| Cópia às 20:48 | 200 | `PAGE_REDIRECT` v2 | 337 ms | Cópia |
| Cópia às 20:53 | 200 | `PAGE_REDIRECT` v2 | 275 ms | Cópia |
| LP oficial às 20:53 | 200 | `OBSERVE_ONLY` | 241 ms | LP oficial |

A política v1 já estava aprovada e tinha `DIRECT_UNKNOWN=100%`. Faltava
a autorização operacional. A revisão de autorização 1 segue a aprovação 3
da política v2 e admite somente `https://lp-clone-tawny.vercel.app/` para
`https://lp.flowmembers.com.br/`. A classe direta/desconhecida está em 100%
e as três outras classes em 0%. A política respeita o fail-open de 150 ms.

O bootstrap corrigido dispara a decisão imediatamente e carrega o Core de
coleta em paralelo. O Chromium de laboratório chegou ao destino com o Core
retido por 500 ms e conservou a navegação nativa com a decisão tardia.
Na cópia real, o Vercel entrega um bootstrap local em `/js/a.js`, ainda com
a implementação anterior. A substituição foi preparada com a mesma
configuração pública de distribuição embutida. A prova de navegação real
continua pendente de acesso ao deploy do projeto Vercel ou à branch que o
alimenta. As durações registradas são da requisição de decisão. Depois da
publicação, a medição precisa confirmar se a resposta e seu processamento
cabem no prazo do bootstrap. O arquivo e a captura local ficam em
`test-results/redirect-smtp-live/` na workspace Dev.

## Alertas

O gateway público tem `GATEWAY_BACKGROUND_MAINTENANCE=off`. O gateway
privado mantém a manutenção e transfere o consumo de notificações com
`GATEWAY_NOTIFICATION_DELIVERY=off`. O novo serviço independente
`anticlone-dev-notification-worker` usa o banco e a configuração SMTP
privados do Dev. Durante a homologação, seu `PROJECT_ID` está restrito ao
projeto da LP oficial. A chave SMTP cifrada foi resolvida no worker, e
somente estado e revisão chegam à sonda do painel.

O teste manual SMTP nº 6, configuração v5, teve resultado `ACCEPTED` na
Brevo às 20:35:27 UTC. Às 20:51:05 UTC foi ativada a preferência v6 para
eventos posteriores ao corte. O worker sinalizou `READY` na v6. Os dois
itens anteriores do projeto mantiveram zero tentativas. Uma nova visita ao
mesmo host reutiliza o incidente e o item de outbox. A confirmação na caixa
postal cabe ao proprietário.

## Painel privado

O admin Dev usa `ADMIN_OPERATIONAL_GATEWAY_ORIGIN` e
`NOTIFICATION_WORKER_STATUS_PATH` no ambiente privado para distinguir a
saúde pública e o processo de envio. A tela de redirecionamento usa destino,
percentuais e escopo exato da cópia numa única revisão. A confirmação
publica a versão, aprova a LP e registra a autorização na mesma transação.
A migration 069 mantém a invalidação de vínculos de entrada restrita à LP
editada. O painel indica a configuração vinculada e o modo do gateway.
A execução dentro do prazo é verificada no navegador.
