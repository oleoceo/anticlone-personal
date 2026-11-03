# STATUS — AntiClone Personal

- **Estado:** GS02 demonstrado em laboratório no CI 41669343753; detecção experimental.
- **F01/F34 parciais:** projetos locais e autenticação com TOTP testados; faltam requisitos de produção e auditoria.
- **F04/F09 parciais:** bootstrap e Core separados; original, cópia e falhas em Chromium no CI 41680979048 (2056cf6).
- **Limites:** somente laboratório, sem exposição pública, painel ou dados reais; sinais de origem são forjáveis.
- **Retenção:** observações 7 dias; incidentes inativos e alertas 30 dias, limpeza durante operação.
- **Testes locais:** lint, typecheck e build passaram; suíte integrada exige PostgreSQL isolado indisponível localmente.
- **Revisão:** independente, achados de teste corrigidos e reavaliados; PR #7, sem merge ou deploy.

- **F05 em implementacao:** fallback em laboratorio; GS09 completo depende de canarios e ainda nao foi comprovado.

- **F06/GS09 em andamento:** canarios passivos em laboratorio; validacao depende de CI e revisao independente.
