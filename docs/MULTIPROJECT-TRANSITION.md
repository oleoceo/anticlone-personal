# Transicao multiprojeto do PR #59

Escopo laboratorial. Nao ativa mitigacao operacional, pausa, arquivo ou exclusao de projetos.

## Gateway e instalacoes existentes

Aplique as migrations aditivas em ordem, inclusive 041 e 042, no ambiente de teste e reinicie os processos. Nao altere versoes historicas de politicas nem remova registros de instalacao. As migrations 037-040 continuam sem aprovar automaticamente politicas legadas.

Mantenha PROJECT_ID e a configuracao legada enquanto qualquer pagina usar /runtime.js, /observe, /observe/fallback, canarios ou /checkout-webhook legados. O mesmo processo aceita /i/<installation_id>/... para todos os projetos. A manutencao antiga cuida de PROJECT_ID; a varredura do catalogo processa separadamente os demais projetos. Sem PROJECT_ID, a varredura processa todos os projetos e as rotas sem identidade retornam 404 deliberadamente: nao existe associacao confiavel para elas.

Transicao sem perder observacao: manter PROJECT_ID; cadastrar paginas e URLs pelo painel; substituir os snippets gradualmente; consultar os sinais por Page ID no painel; conferir que nenhuma instalacao ainda usa as rotas antigas; somente depois retirar PROJECT_ID e os parametros exclusivos do gateway legado. Nao ha conversao automatica de payload legado em identidade scoped. Nao retirar PROJECT_ID apenas para habilitar rotas novas: elas ja coexistem. Nao habilitar PILOT_OBSERVE multiprojeto nesta implementacao; o piloto legado continua disponivel com PROJECT_ID e rejeita fixtures laboratoriais scoped.

Sinais de pagina sao alegacoes nao autenticadas, limitadas a uma atualizacao por fonte/pagina/minuto e retidas por sete dias. NOT_VERIFIED permanece: recebimento de um sinal nao prova integridade nem protecao ativa. Core/fallback nao sao atividade independente para disparar inatividade; sem fonte independente o diagnostico permanece desconhecido. Os controles legados de instalacao/inatividade continuam vinculados a origem principal, nao sao novos alertas de ausencia por pagina.

## Manutencao

Todos os projetos persistidos sao elegiveis: nao existe ciclo de pausa/arquivo nesta entrega. O sweep usa lotes de 25 e serializa a execucao; gates, backoff de 60s, fontes de falha, coleta pendente e baseline sao separados por projeto. Uma falha nao cancela o restante do sweep. Limites e locks das rotinas de alerta/degradacao continuam valendo. Retencoes existentes permanecem 24h/7d/30d conforme a tabela; nao ha limpeza de historico fora dessas politicas. DNS continua exigindo autorizacao privada explicita do host e incidente do mesmo projeto. Historico de saude e sinais de pagina tem manutencao horaria; DNS consulta um host autorizado por projeto/minuto, mantendo a deduplicacao de seis horas e limpeza horaria.

## Checkout autenticado

CHECKOUT_WEBHOOK_ROUTES e um array JSON privado, com objetos contendo exatamente project, route e secret. Cada route identifica /checkout-webhook/<route>, possui um segredo HMAC hexadecimal proprio (64-128 caracteres), e aponta para um projeto existente. Segredos repetidos entre rotas ou com CHECKOUT_WEBHOOK_SECRET sao recusados, inclusive chaves HMAC equivalentes por preenchimento com zeros. As novas rotas exigem pares hexadecimais completos. Nao incluir essa variavel no snippet, painel, logs ou repositorio. Configurar fora de arquivos versionados.

O remetente usa o contrato HMAC existente: SHA256(secret, timestamp + '.' + corpo bruto), timestamp Unix em X-Checkout-Timestamp, assinatura hexadecimal em X-Checkout-Signature e application/json. O corpo preserva somente event_id, sale_id, amount_minor, currency e occurred_at. Janela de cinco minutos, limite de 2048 bytes, 120 eventos por rota/minuto, recusa de contexto de navegador e idempotencia por projeto/evento/venda permanecem. A rota so seleciona a configuracao; quem autoriza e a assinatura com o segredo especifico. project_id publico, Origin, pathname e Installation ID nao autorizam nada. Vendas reportadas nao sao receita recuperada nem atribuicao verificada.

O endpoint legado /checkout-webhook com CHECKOUT_WEBHOOK_SECRET e PROJECT_ID permanece compativel. Para migrar um remetente, configure sua rota, atualize o endpoint/segredo no remetente e reutilize os mesmos IDs para retries. A idempotencia continua no mesmo projeto, independentemente da rota. Sem PROJECT_ID, nao ha endpoint legado habilitado.

## Entrada independente por pagina e transicao de URL

page_entry_policy_bindings e a ativacao PAGE_REDIRECT por projeto/Page ID no gateway scoped. O painel oferece versoes publicadas elegiveis e confirma a versao especifica na aprovacao transacional da pagina. Duas paginas podem selecionar versoes diferentes sem mudar o historico. active_protection_policies continua sendo a ativacao exclusiva do gateway legado. Mudancas nesse ponteiro nao revogam aprovacoes scoped independentes; para suspender uma pagina, remover/trocar seu vinculo ou desabilita-la invalida sua geracao. Mudancas em configuracao compartilhada de CTA/destinos continuam invalidando conservadoramente o projeto. A aprovacao inclui geracoes, destinos, Stealth, alocacao e estado comercial. PAGE_REDIRECT conserva prioridade sobre CTA na entrada e todos os gates de risco.

1. Autorizar a nova URL na mesma pagina: Page ID e Installation ID permanecem.
2. Instalar o mesmo snippet na nova URL e carrega-la. Na aba Rede do navegador, conferir manualmente o carregamento de /i/<installation_id>/runtime.js e as requisicoes /observe ou /observe/fallback com resposta 204. Os sinais no painel agregam todas as URLs da pagina; durante autorizacao dupla nao distinguem a URL antiga da nova e nao verificam automaticamente presenca/integridade do script na nova URL. Essa verificacao manual nao e prova de integridade nem protecao.
3. Com duas URLs autorizadas, manter OBSERVE_ONLY. Nao ha promessa de protecao continua durante essa transicao.
4. Remover a autorizacao antiga. Historico e aprovacoes antigas permanecem armazenados, mas a geracao anterior nao autoriza decisoes.
5. Consultar politicas da pagina, revisar destinos e CTAs compativeis e confirmar nova aprovacao com a geracao atual.
6. Retomar somente decisoes laboratoriais elegiveis. Alteracao posterior volta a exigir revisao.

Fixtures SCOPED_LAB_INSTALLATION (singular, compativel) ou SCOPED_LAB_INSTALLATIONS (lista de ate 100 UUIDs separados por virgula) mais SCOPED_LAB_ORIGIN somente autorizam testes locais em loopback. Nunca usar essas variaveis como configuracao de protecao operacional.

## Provas reproduziveis

npm run lint, npm run typecheck, npm run build e npm test. A suite completa exige TEST_DATABASE_URL, Chromium e pg_dump/pg_restore; HTTPS exige Linux/Docker e HTTPS_GATE_TEST=1 na CI. Testes multiproject-contract, scoped-gateway, pages-admin, multiple-cta-surfaces (regressao PR #58), checkout-webhook, optional-schema e recovery cobrem o contrato. GS16 inclui paginas, versoes vinculadas, aprovacoes e sinais nao vazios no backup/restore. Resultados e revisao do SHA final estao no PR #59; nenhum teste nao executado deve ser declarado PASS.
