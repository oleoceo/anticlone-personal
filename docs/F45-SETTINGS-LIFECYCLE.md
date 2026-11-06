# F45: transicoes de configuracao (PR #48)

No SHA 61ec289, um episodio INACTIVE aberto com prazo de 60 segundos
continuava elegivel para SMTP depois da alteracao para 86400 segundos.
Reproducao em PostgreSQL 16 e SMTP loopback: o teste esperava zero mensagens
e observou uma. A configuracao apenas fazia upsert; a entrega consultava a
habilitacao atual, sem invalidar o diagnostico feito sob a politica anterior.
Episodios antigos tambem ocupavam a chave unica de episodio aberto.

`configureHealth` reutiliza o advisory lock de projeto `(hashtext(project),45)`.
Alterar habilitacao ou prazo invalida os episodios INACTIVE abertos e expira
suas entregas nao enviadas, junto com a configuracao e sua auditoria, na mesma
transacao. Nao altera a linha de base: uma avaliacao posterior pode abrir um
novo episodio se a evidencia existente satisfizer a nova politica. Uma gravacao
identica nao acrescenta auditoria nem invalida episodios. Outros projetos e
episodios encerrados permanecem preservados.

Desabilitar notificacoes OPERATIONAL expira as intencoes pendentes, preservando
o diagnostico aberto e suas chaves de reconciliacao. Reabilitar nao ressuscita
essas intencoes. A recuperacao e uma falha posterior permitem novo episodio.
O envio exige `recovered_at IS NULL` e `invalidated_at IS NULL` para ambos os
tipos. Assim, falhas recuperadas antes da reserva SMTP ficam apenas no historico;
nao se envia uma notificacao historica. A reserva/envio e as transicoes continuam
serializadas pelo lock existente. Uma entrega que adquiriu o lock antes da
alteracao pode concluir antes de a nova configuracao ser confirmada.

A migration aditiva 029 sucede 028 e cria `health_settings_history`, com projeto,
valores anteriores/novos e horario do servidor. Copia a configuracao existente
como snapshot inicial, sem inventar seu passado. A retencao e de 30 dias, como
o historico dos episodios encerrados. Aplicar migrations apenas pelo fluxo
autorizado; nenhuma migration de producao foi executada nesta tarefa.
O gateway exige ambas as migrations e reinicio; somente 028 deixa F45
NOT_INSTALLED, preservando os demais caminhos. Na reversao laboratorial,
remover a tabela 029 antes da tabela de configuracao 028.

Provas em `tests/health-settings-lifecycle.test.ts`: prazo 60s para 24h,
disable/reenable, novo episodio concorrente deduplicado, historico e isolamento,
rollback apos escrita da configuracao, serializacao pelo lock, tres caminhos de
recuperacao OPERATIONAL e cancelamento operacional sem alterar reconciliacao.
`health-alerts.test.ts` e `health-gateway.test.ts` preservam as provas anteriores
de concorrencia, reinicio, gateway, Chromium e SMTP real local.
O gate HTTPS completo permanece na CI Linux; evidencia e SHA final no PR #48.
F44 PARCIAL, F08 BLOCKED, NOT_VERIFIED e OBSERVE_ONLY permanecem inalterados.
