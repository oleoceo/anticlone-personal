# Handoff — AntiClone Personal

- Base: main `963da9e`, PRs #21, #22 e #23 integrados; F25/F27 permanecem PARCIAL na matriz e no STATUS.
- PR #21: alerta persistente por transição de CTA mapeado para revisão, deduplicado até reaprovação, com retenção de 30 dias; F25 preserva reaprovação auditada. Migration de laboratório: `infra/014_cta_drift_alerts.sql`, após as anteriores.
- PR #22: consulta autenticada `GET /admin/projects/:id/cta/alerts`, limitada a 100 alertas por projeto, mais recentes primeiro e desempate por ID. Entrega e retry dos alertas F27 ainda pendentes.
- PR #23: gate documental obrigatório no workflow existente: UTF-8 válido, sinais de corrupção (inclusive interrogações repetidas entre letras em prosa) e consistência das declarações explícitas mais recentes de STATUS com a matriz. Preserva perguntas e exemplos técnicos Markdown; testes independentes de corrupção e de texto legítimo.
- D07: formulários suspensos e armazenados, sem consumir o limite de âncoras; preservar envio nativo.
- Preservar política pronta, destinos aprovados, demais mapeamentos, Stealth/OBSERVE_ONLY e PAGE_REDIRECT.
- Usar somente laboratório e dados sintéticos; GS08/GS13 integrais e F27 completo continuam pendentes.
- Pré-entrega obrigatória: conferir documentação/codificação, executar `python scripts/validate_repo.py` e `python -m unittest discover -s scripts -p 'test_*.py'`; identificar sessão revisora independente, isolamento real, SHA/delta e parecer; conferir CI verde no HEAD final, incluindo checks da aplicação quando relevantes. Gate documental não prova funcionamento do sistema.

## F27: entrega simulada em laboratório

Aplicar `infra/015_cta_alert_deliveries.sql` após as migrations anteriores. A inserção do alerta prepara uma única entrega na mesma transação; alertas existentes são preparados pela migration. A exclusão por retenção remove a entrega associada.

Após `npm run build`, iniciar `node dist/apps/cta-delivery-worker.js` com `DATABASE_URL` do laboratório. O processo percorre um alerta por segundo; a simulação não usa rede nem registra conteúdo. Interrupção retoma após reserva expirar em um minuto; falha espera um minuto. São no máximo três tentativas, inclusive reservas interrompidas; após esgotamento o estado é FAILED. SIGTERM/SIGINT encerra após o processamento atual.

A reserva possui token para rejeitar confirmação antiga. Uma interrupção entre simulação e confirmação pode repetir a simulação; nenhum resultado representa entrega externa. O estado DELIVERED significa apenas simulação local concluída. GS08/GS13 integrais e envio real permanecem pendentes.
