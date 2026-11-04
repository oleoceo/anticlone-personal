# Handoff — AntiClone Personal

- Base: main d18312c, PR #20 integrado; F25 parcial com reaprovação auditada.
- F27 em desenvolvimento: alerta persistente por transição de CTA mapeado para revisão; sem e-mail ou retry. Aplicar `infra/014_cta_drift_alerts.sql` após as anteriores.
- D07: formulários suspensos e armazenados, sem consumir o limite de âncoras; preservar envio nativo.
- Preservar política pronta, destinos aprovados, demais mapeamentos, Stealth/OBSERVE_ONLY e PAGE_REDIRECT.
- Usar somente laboratório e dados sintéticos; GS08 integral e F27 completo continuam pendentes.
- Revisão Codex independente e CI com PostgreSQL/Chromium exigidas; não fazer merge ou deploy.
