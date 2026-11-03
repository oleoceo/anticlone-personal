# STATUS — AntiClone Personal

- **Estado:** GS02 e GS06 demonstrados em laboratório; detecção experimental.
- **F01/F34 parciais:** projetos locais e autenticação com TOTP testados; faltam requisitos de produção e auditoria.
- **F04/F05/F06/F09 parciais:** Core, fallback e canários testados em laboratório; compatibilidade e GS09 completo pendentes.
- **F17/F18 parciais:** GS06 comprovou destino aprovado e LOW local; espera limitada e fail-open testados, sem gate visual completo.
- **F43 parcial:** publicação autenticada, versões imutáveis e ativação transacional testadas em laboratório; motor geral de precedência, fases de interação, demais cenários de GS19 e classificador pendentes. Políticas legadas exigem republicação.
- **F15/F16 parciais:** classificação declarada em laboratório, com fonte e incerteza; presença diária, sem corroboração nem GS04 completo.
- **Retenção:** observações 7 dias; incidentes inativos e alertas 30 dias.
- **Revisão e CI:** revisão independente sem P0/P1 para laboratório; PR #12: CI 41702201540 aprovado no commit do PR; merge 92f38c0; credencial privilegiada PostgreSQL permanece confiável.

- **F13/F14 em desenvolvimento:** avaliador conservador de laboratorio e OBSERVE_ONLY; GS05 integral e classificador operacional pendentes. CI e revisao final desta branch pendentes.
