# Fechamento operacional sobre #69

Base `8834bf3c9f34cc699404705495bdb09daf53a110`. CI tecnica separada no PR #71,
SHA `29c2a065785665d80598e123211c60be8ceb87d1`, execucao oficial
[43052496536](https://github.com/oleoceo/anticlone-personal/actions/runs/43052496536)
verde. Chromium sem apt, smoke real, Docker, Nginx, PostgreSQL, HTTPS e suite
integral preservados. #70 fechado/Draft nao foi importado; nenhuma migration 062.

## Defeitos e prova integrada

O inventario administrativo recusava projetos HTTPS por uma restricao antiga a
localhost. A consulta agora usa `configurationOrigin`, como publicacao e mapping.
Captura automatica por iframe permanece local. Para sites HTTPS proprios, o painel
conserva a importacao manual revisada existente, autenticada/CSRF, sem fetch do backend.
Primeiro publique a superficie/caminho com a politica desabilitada; importe os
candidatos; consulte e mapeie cada ponto a uma oferta/destino aprovado; publique,
aprove na LP e autorize o contexto operacional explicitamente.

Exemplo sintetico de lista para o campo JSON (URLs reais devem ser do contexto
proprio revisado; nomes/rotulos nao identificam uma oferta por si):

```json
[{"marker":"checkout01","kind":"a","parent":"div","ordinal":1,"url":"https://site-proprio.test/checkout"}]
```

O site deve ter `data-anticlone-surface="landing"` no ancestral e
`data-anticlone-point="checkout01"` no link correspondente. A importacao nao ativa
mitigacao nem atribui um destino a candidato incerto. Conteudo observado continua
nao confiavel. A confirmacao administrativa nao autentica a pagina nem o visitante.

`tests/operational-journey.test.ts` exercita o mesmo projeto/LP em cada viewport
(1440 e 390): cadastro, instalacao v2, original/copia, Core/Fallback, incidente
deduplicado, SMTP local com falha e processos de entrega sucessivos, estado de
aceitacao no painel, destinos/mapping, Stealth v2 OFF, 0/50/100 e quatro classes por
acao, popup com duas ofertas, suspensao e recuperacao. Documentos sinteticos sao
fornecidos pelo laboratorio; APIs, Chromium, PostgreSQL e SMTP sao reais. Nao ha
mock de decisao. Os testes existentes de Nginx/HTTPS, canarios, timeout/fail-open,
drift isolado, candidatos incertos, pontos dinamicos e restore continuam exigidos.
Resultados e SHA final devem ser conferidos no PR consolidado; teste em execucao
ou falho nao constitui prova.

## F37: arquivos, logs e backups

`node dist/apps/artifact-retention.js ROOT --plan` apenas lista candidatos;
`--apply` apaga exclusivamente arquivos reconhecidos dentro de ROOT. Nesta entrega
`--apply` e ensaiado somente com arquivos sinteticos temporarios. Nao foi agendada
limpeza nem removido backup operacional.

O operador provisiona um diretorio privado dedicado, sem symlinks/junctions,
contendo `logs/`, `backups/` e `retention-policy.json`:

```json
{"format":1,"log_days":7,"backup_days":30}
```

Os prazos acima sao exemplo de laboratorio, nao escolha de producao. Dias inteiros
entre 1 e 3650 sao obrigatorios. Exporte somente logs sintetizados/necessarios para
`logs/*.log`; o criterio e mtime, sem seguir subdiretorios. Backups ficam em
`backups/ID/`, criados pelo comando de recovery existente. Arquivos desconhecidos,
archives corrompidos e diretorios parciais sao preservados para diagnostico.
O backup mais recente e o ultimo snapshot com restore verificado sao preservados,
mesmo vencidos. Sem snapshot verificado nenhum backup e apagado automaticamente.
Backups antigos ainda contem dados que ja expiraram no banco; o limite efetivo de
retencao inclui sua janela de backup e copias externas.

Restore integro grava `restore-verified.json` exclusivo, com hash do archive e
horario; checksums/recibos detectam corrupcao, nao autenticam arquivos contra quem
tem escrita no diretorio. Proteja esse root e suas copias. Nao permita escritores
concorrentes durante a limpeza: o lock serializa apenas instancias da ferramenta,
nao elimina corrida com processos externos. A ferramenta recusa caminhos
simbolicos e remove arquivos individualmente, sem delete recursivo. Apos crash,
verifique que nao existe processo de retencao ativo antes de remover manualmente
`.retention-lock`; nunca remova locks automaticamente por idade.

Docker mantem logs locais limitados a 2 x 5 MB por servico, conforme Compose;
Nginx nao grava access log. Essa rotacao e por tamanho, nao por dias. Logs exportados
seguem a politica explicita acima. Backups/offsite/configuracoes privadas exigem
armazenamento controlado e a mesma politica de expiracao em cada destino; a
ferramenta nao acessa provedor externo. Monitorar falta de espaco continua necessario.

## F38: migrations, backup, restore e rollback

Antes da primeira instalacao: fixar SHA/imagem, rever `infra/001..061`, preparar
banco novo isolado e ensaiar o mesmo release. `apps/versioned-upgrade.ts` executa
ledger/checksum, lock e transacao por migration apenas em bancos de laboratorio
`anticlone_upgrade_*`/`anticlone_restore_*`; nao e comando de upgrade de producao.
Volume novo do Compose inicializa migrations; volume existente nao as reexecuta.
Adocao do ledger em banco legado exige inventario/backup/ensaio especifico e
autorizacao, sem marcar migrations como aplicadas por suposicao.

Procedimento versionado: [POSTGRES-RECOVERY.md](POSTGRES-RECOVERY.md) para snapshot,
integridade e restore em destino vazio/offline; `tests/front3-upgrade.test.ts`
comprova upgrade, falha atomica, restore e rollback do executavel sobre esquema
aditivo. `saveOperationalBundle`/`readOperationalBundle` recuperam configuracoes
permitidas e SHA, sem serializar segredos. Conserve separadamente credenciais,
MFA, TLS, rendered Nginx/env, aprovacoes externas e acesso ao armazenamento privado.
Rollback troca executavel/imagem para SHA anteriormente ensaiado; nao executa down
migration destrutiva. Reconfira original, recibos, incidentes, destinos e politicas
antes de liberar mitigacao; restauracao isolada nao autoriza corte de producao.

## Compatibilidade e dependencias reais

Links `a[href]` com marcadores estaveis suportam mapeamento, DOM dinamico/SPA e
popup dentro dos testes existentes. Descricao alterada nao deve trocar oferta.
Drift material exige revisao do ponto afetado. Sem marcador/confianca suficiente,
nao ha associacao automatica. Formularios mantem envio nativo; botoes que dependem
exclusivamente de JavaScript, sem link navegavel, nao recebem substituicao. D07
permanece: esses CTAs bloqueiam REPLACE_CONVERSION naquele ponto; adaptar o site
proprio para link explicito e uma opcao suportada. Page Redirect e independente.

WhatsApp/checkout no ensaio sao destinos sinteticos aprovados, sem mensagem, conta,
pagamento ou venda real. Homologacao exige LPs e destinos reais do proprietario,
DNS/TLS/infra autorizados e recebimento na caixa SMTP real. DNS sintetico nao prova
DNS publico; ASN/provedor indisponivel permanece explicito. F29/F31 distinguem
clique/handoff de venda e conservam webhook generico autenticado/idempotente;
adaptador financeiro depende do provedor escolhido. F13/F14 #69 ficam shadow,
sem veto novo; F32/Stealth v3 nao bloqueiam esta fatia.

Decisoes para instalacao: URLs/CTAs proprios e destinos exatos, classes/percentuais,
SMTP/remetente/destinatario, retencao e armazenamento privado/offsite, ambiente e
janela de instalacao autorizada. Nenhum merge/deploy/DNS/conexao de conta/migration
de producao foi realizado.
