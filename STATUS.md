# STATUS — AntiClone Personal

- **Estado:** GS02 demonstrado em laboratório no CI 41669343753, commit e5988d8; detecção permanece experimental.
- **F34 parcial:** login local com senha e TOTP, sessão efêmera e proteção de replay persistente; sem trilha de alterações.
- **Limites:** somente laboratório, exposição pública bloqueada, sem painel e sem dados reais; limite de tentativas é por processo.
- **Retenção:** observações 7 dias; incidentes inativos e alertas 30 dias, com limpeza durante operação.
- **Testes:** autenticação e GS02 dependem de PostgreSQL; Chromium e SMTP de teste necessários para GS02 no CI.
- **Branch:** feat/admin-totp-lab; revisão e CI registrados no PR.
