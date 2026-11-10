Contrato atual de Stealth: [OPTIONAL-STEALTH.md](OPTIONAL-STEALTH.md), D05 atualizada em 2026-11-09. A exigência de Stealth nesta fatia histórica refere-se às versões legadas; a nova semântica exige publicação explícita.

# Publicação de política no laboratório

Aplique, em ordem numérica, as migrações de `infra/001_initial.sql` até `infra/010_policy_allocation.sql` em um banco de laboratório. O serviço administrativo existente exige sessão autenticada; todos os pedidos abaixo usam JSON, bearer token e não aceitam Origin de navegador.

- `POST /admin/projects/{id}/policy/draft`: `{"enabled":true,"approved_destination":"http://127.0.0.1:PORTA/caminho","stealth":true,"allocation":{"PAID_ATTRIBUTED":100,"ORGANIC":50,"REFERRAL":20,"DIRECT_UNKNOWN":0}}`. O destino deve pertencer à origem do projeto, que deve ser loopback. `allocation` é obrigatório e deve conter as quatro classes mostradas, com percentuais inteiros de 0 a 100 em passos de 10. Outros campos, valores inválidos e `stealth:false` são rejeitados.
- `POST /admin/projects/{id}/policy/publish`: `{}` valida novamente, cria versão e a ativa na mesma transação.
- `POST /admin/projects/{id}/policy/activate`: `{"version":1}` revalida e ativa uma versão publicada do mesmo projeto.

A publicação serializa operações por projeto; versões não podem ser atualizadas nem excluídas por operações SQL normais. Credenciais privilegiadas do banco são confiáveis: elas podem inserir e ativar versões diretamente ou alterar controles, portanto não devem ser expostas. A tabela antiga `page_redirect_policies` não é promovida automaticamente: o proprietário precisa preparar e publicar uma nova versão; até então a decisão é OBSERVE_ONLY. LOW continua restrito à configuração local explícita e às origens loopback. Sem política ativa válida ou com falha de consulta, a decisão é OBSERVE_ONLY.

Esta fatia aceita somente uma regra de entrada e exige stealth; os percentuais aplicam-se a PAGE_REDIRECT em laboratório. Não implementa motor geral de precedência, classificador operacional nem interação. GS04, GS19 e F43 permanecem parciais. O teste de falha renomeia uma tabela e deve rodar apenas em banco de teste isolado, com testes serializados.
