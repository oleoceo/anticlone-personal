# STATUS — AntiClone Personal

- **Estado:** GS02 demonstrado em laboratório no CI 41669343753, commit e5988d8; detecção permanece experimental.
- **F34 parcial:** API local de login de proprietário, sessão efêmera e limite por processo; sem MFA ou trilha de alterações.
- **Limites:** uso somente em laboratório; exposição pública bloqueada, sem painel e sem dados reais.
- **Retenção:** observações 7 dias; incidentes inativos e alertas 30 dias, com limpeza durante operação.
- **Testes:** autenticação local, lint, typecheck e build; GS02 depende de PostgreSQL, Chromium e SMTP de teste no CI.
- **Branch:** feat/admin-auth-lab; revisão independente e CI registrados no PR.
