# Handoff — AntiClone Personal

- Base: main `963da9e`, PRs #21, #22 e #23 integrados; F25/F27 permanecem PARCIAL na matriz e no STATUS.
- PR #21: alerta persistente por transição de CTA mapeado para revisão, deduplicado até reaprovação, com retenção de 30 dias; F25 preserva reaprovação auditada. Migration de laboratório: `infra/014_cta_drift_alerts.sql`, após as anteriores.
- PR #22: consulta autenticada `GET /admin/projects/:id/cta/alerts`, limitada a 100 alertas por projeto, mais recentes primeiro e desempate por ID. Entrega e retry dos alertas F27 ainda pendentes.
- PR #23: gate documental obrigatório no workflow existente: UTF-8 válido, sinais de corrupção (inclusive interrogações repetidas entre letras em prosa) e consistência das declarações explícitas mais recentes de STATUS com a matriz. Preserva perguntas e exemplos técnicos Markdown; testes independentes de corrupção e de texto legítimo.
- D07: formulários suspensos e armazenados, sem consumir o limite de âncoras; preservar envio nativo.
- Preservar política pronta, destinos aprovados, demais mapeamentos, Stealth/OBSERVE_ONLY e PAGE_REDIRECT.
- Usar somente laboratório e dados sintéticos; GS08/GS13 integrais e F27 completo continuam pendentes.
- Pré-entrega obrigatória: conferir documentação/codificação, executar `python scripts/validate_repo.py` e `python -m unittest discover -s scripts -p 'test_*.py'`; identificar sessão revisora independente, isolamento real, SHA/delta e parecer; conferir CI verde no HEAD final, incluindo checks da aplicação quando relevantes. Gate documental não prova funcionamento do sistema.

## F27: SMTP local em laboratório

Aplicar `infra/015_cta_alert_deliveries.sql` após as migrations anteriores. A inserção do alerta prepara uma única entrega na mesma transação; alertas existentes são preparados pela migration. A exclusão por retenção remove a entrega associada.

Antes da migration, encerrar todos os workers simuladores antigos e não reiniciá-los: eles não reconhecem a classificação nova. Aplicar também `infra/016_cta_local_smtp.sql`: entregas existentes ficam no modo SIMULATED, inclusive pendentes e reservas expiradas, e nunca são enviadas pelo novo worker. Um resultado DELIVERED anterior é classificado SIMULATED, não aceitação SMTP. Novas entregas são SMTP_LOCAL; SMTP_LOCAL_ACCEPTED significa aceitação pelo servidor local, não entrega final.

O worker fica desabilitado por padrão. Somente em laboratório isolado, após `npm run build`, fornecer `DATABASE_URL`, `CTA_SMTP_LAB=1` e `CTA_SMTP_LAB_PORT` do servidor de captura sem relay em 127.0.0.1 e iniciar `node dist/apps/cta-delivery-worker.js`. Remetente e destinatário são fixos em example.test; não há host configurável nem credenciais. A operação SMTP tem prazo total de dez segundos, inferior à reserva de um minuto. Falha espera um minuto; no máximo três reservas contam como tentativas. A retenção de 30 dias remove também entregas pendentes ou falhadas.

O token impede confirmação obsoleta, mas uma interrupção após aceitação e antes da confirmação pode repetir a mensagem. O Message-ID é estável e não garante deduplicação no servidor. A futura escolha de Brevo ou outro SMTP e configuração de remetente e destinatário autorizado requerem outra implementação e aprovação para ativação real. D03 continua proposta a validar; esta fatia não introduz Redis. F27 e GS08/GS13 integrais permanecem pendentes.

## Global notification settings in the laboratory

Apply `infra/017_notification_settings.sql` to the laboratory database. Authenticated GET and POST `/admin/notification-settings` read and save the singleton. POST requires exactly `version`, `provider` (brevo or smtp), `host`, `port`, `tls_mode` (implicit or starttls), `sender` and `recipient`. Settings may be null while incomplete. A material change disables the preference; a stale version returns 409.

POST `/admin/notification-settings/preference` accepts `{"enabled":true,"version":N}` to request enablement of complete settings, or `{"enabled":false}` to disable without a version. Responses report `incomplete`, `configured_disabled` or `enablement_requested` and always `real_delivery_operational:false`. Atomic audit records actions, versions and field names, without values. No credentials or provider verification are involved. Workers do not read these settings; requesting enablement does not send mail. The API remains laboratory-only. An authenticated local administrative interface supports global settings and preference changes without real delivery; Chromium coverage is in `tests/admin-notification-ui.test.ts`. F26 remains planned, F27 partial, GS08/GS13 pending and D03 proposed.

## Shared notification budget

Stop all old F26 servers and F27 workers, apply `infra/018_notification_budget.sql`, then start only updated processes against the same PostgreSQL database. Old versions bypass the shared budget. F26 and F27 compete for 10 reservations per rolling 60 minutes and each alert has at most three attempts; interruption and uncertain results consume a reservation. SMTP acceptance may still result in duplicates. The F26/F27 backlog expiry policy is 24 hours, as detailed below; F26, F27 and GS13 remain incomplete.


## Expiração de notificações em 24 horas — PR #30

Antes da atualização, parar todos os servidores F26 e workers F27 antigos. Após as migrações anteriores, incluindo `infra/018_notification_budget.sql`, aplicar primeiro `infra/019_alert_outbox_expiry.sql` e depois `infra/020_cta_delivery_expiry.sql`. Somente então reiniciar os processos com as versões novas; não reiniciar versões antigas, que ignoram a expiração.

Novas reservas são impedidas a partir de 24 horas de `incidents.first_seen` (F26) ou `cta_drift_alerts.created_at` (F27). F26 registra `expired_at`; F27 usa `EXPIRED` para entregas SMTP_LOCAL elegíveis. Incidentes, alertas e histórico SIMULATED são preservados. Uma entrega em andamento com reserva válida pode concluir; expiração não cancela SMTP já iniciado.

Evidência: `tests/notification-expiry.test.ts` cobre concorrência, orçamento saturado, reinício, preservação do histórico e envio em andamento. A execução consultada de `d169dba` passou 35 testes; isso não equivale à conclusão formal do job da CI. O teste de fronteira F26 não reproduz exatamente a passagem do prazo entre SELECT e UPDATE. Revisão do delta documental e CI do novo HEAD devem ser conferidas no PR antes de retirar Draft. F26/F27/GS13 permanecem incompletos; sem envio externo ou ativação real.
