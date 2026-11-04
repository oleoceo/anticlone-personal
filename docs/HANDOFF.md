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

## Configura""o administrativa global de notifica""es

Aplicar `infra/017_notification_settings.sql` no banco de laborat"rio. GET e POST em `/admin/notification-settings` exigem sess"o administrativa; POST aceita exatamente `version`, `provider` (brevo ou smtp), `host`, `port`, `tls_mode` (implicit ou starttls), `sender` e `recipient`. Cada par"metro pode ser null enquanto incompleto. Um salvamento material desabilita a prefer"ncia; vers"o desatualizada retorna 409.

POST em `/admin/notification-settings/preference` aceita `{"enabled":true,"version":N}` para solicitar habilita""o de configura""o completa, ou `{"enabled":false}` para desabilitar sem vers"o. Respostas incluem `incomplete`, `configured_disabled` ou `enablement_requested` e sempre `real_delivery_operational:false`. A auditoria transacional guarda a""o, vers"o e nomes de campos, sem valores. N"o h" credenciais ou verifica""o de provedor. Nenhum worker l" essa configura""o; solicitar habilita""o n"o produz envio. A API continua exclusiva de laborat"rio, sem interface web. F26 segue planejada, F27 parcial, GS08/GS13 pendentes e D03 proposta a validar.
