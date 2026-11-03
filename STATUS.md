# STATUS — AntiClone Personal

- **Estado:** GS02 demonstrado em laboratório no CI 41669343753; detecção experimental.
- **F01/F34 parciais:** projetos locais e autenticação com TOTP testados; faltam requisitos de produção e auditoria.
- **F04/F09 em validação:** bootstrap e Core separados, contexto comparado no servidor; CI e revisão pendentes.
- **Limites:** somente laboratório, sem exposição pública, painel ou dados reais; sinais de origem são forjáveis.
- **Retenção:** observações 7 dias; incidentes inativos e alertas 30 dias, limpeza durante operação.
- **Testes locais:** lint, typecheck e build passaram; suíte integrada exige PostgreSQL isolado indisponível localmente.
- **Branch:** feat/lab-bootstrap-core; sem merge ou deploy.
