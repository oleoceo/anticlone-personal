# STATUS — AntiClone Personal

- **Estado:** GS02 e GS06 demonstrados em laboratório; detecção experimental.
- **F01/F34 parciais:** projetos locais e autenticação com TOTP testados; faltam requisitos de produção e auditoria.
- **F04/F05/F06/F09 parciais:** Core, fallback e canários testados em laboratório; compatibilidade e GS09 completo pendentes.
- **F17/F18 parciais:** GS06 comprovou destino aprovado e LOW local; espera limitada e fail-open testados, sem gate visual completo.
- **F43 parcial:** publicação autenticada, versões imutáveis e ativação transacional testadas em laboratório; motor geral de precedência, fases de interação, demais cenários de GS19 e classificador pendentes. Políticas legadas exigem republicação.
- **F15/F16 parciais:** classificação declarada em laboratório, com fonte e incerteza; presença diária, sem corroboração nem GS04 completo.
- **F23/F24 parciais:** PAGE_REDIRECT e sessao efemera testados em laboratorio; GS04 completo e outras acoes pendentes.
- **Retenção:** observações 7 dias; incidentes inativos e alertas 30 dias.
- **Revisão e CI:** revisão independente sem bloqueio para laboratório; CI 41719646208 aprovado no commit 258fa28.

- **F13/F14 em desenvolvimento:** avaliador conservador de laboratório e OBSERVE_ONLY; GS05 integral e classificador operacional pendentes.

- **F19/F20/F41 parciais:** inventario e mapeamento manual em laboratorio; testes de navegador e PostgreSQL na CI 41726344521 (13c051e); revisao independente sem P0/P1 remanescente. GS03/GS17 integrais e descoberta dinamica pendentes.
