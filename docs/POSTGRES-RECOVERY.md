# Recuperação PostgreSQL — F38 / GS16

O comando inclui todo o banco (tabelas, funções, triggers, índices, constraints,
sequências e estado TOTP persistido), sem lista fixa de migrations. O ensaio usa
001–032 e dados sintéticos em dois projetos. Não aplica migrations durante restore.

Requisitos: Node, dependências instaladas, build atual, `pg_dump` e `pg_restore`
no PATH; cliente PostgreSQL compatível com a versão do servidor. A conta de backup
precisa ler todas as tabelas; a de restore precisa criar os objetos no banco vazio.
Credenciais ficam exclusivamente no ambiente privado `RECOVERY_DATABASE_URL`.
Use uma URL PostgreSQL simples, sem query string; opções libpq privadas como
`PGSSLMODE` e `PGSSLROOTCERT` podem ser configuradas no ambiente dos executáveis.

```text
npm run build
# Defina RECOVERY_DATABASE_URL em ambiente privado, sem imprimir a URL.
npm run recovery -- backup /caminho/privado/backups/2026-11-06
```

O diretório deve ser novo. Em POSIX é criado com modo 0700 e os arquivos com 0600;
no Windows, configure previamente ACL privada no diretório pai. O arquivo
`database.dump` é um archive custom PostgreSQL, sem senhas de roles e sem owners ou
grants. `manifest.json`, escrito apenas após sucesso, contém SHA-256 do archive e
contagem/hash de todas as linhas de cada tabela. A captura usa o mesmo snapshot
repeatable-read de `pg_dump`; alterações concorrentes posteriores ficam de fora.
O inventário ordena e lê linhas em lotes; bancos grandes precisam de espaço para
ordenação e o comando tem limite de dez minutos para cada ferramenta.

O archive contém dados privados e o manifesto contém nomes de tabelas e hashes;
ambos precisam de armazenamento privado, criptografia e cópia offsite sob controle
do proprietário. O SHA-256 detecta corrupção, mas não autentica um backup adulterado
por quem também pode editar o manifesto. Restaure somente artifacts confiáveis.
Falha deixa diretório parcial para diagnóstico, que nunca é sobrescrito pelo comando.

Prepare **manualmente um banco novo dedicado**, sem aplicar migrations, com nome
`anticlone_restore_` seguido de até 40 letras minúsculas, dígitos ou underscores.
Configure a URL privada desse banco e confirme exatamente seu nome:

```text
npm run recovery -- restore /caminho/privado/backups/2026-11-06 anticlone_restore_ensaio
```

O comando recusa o nome do banco de origem, nome não isolado, confirmação incorreta,
archive corrompido, objetos existentes e outras conexões. O destino deve permanecer
isolado e sem aplicações conectadas durante todo o procedimento; o advisory lock
serializa estes comandos, mas não bloqueia clientes externos que ignorem o lock.
`pg_restore --single-transaction --exit-on-error` não usa `--clean`, não exclui bancos
e não altera o banco de origem. Falha de restore desfaz sua transação; divergência
do inventário após restore exige manter o banco isolado e investigar.

Depois da verificação, reinicie gateway e admin **de laboratório** com o banco
restaurado e `GATEWAY_MODE=PILOT_OBSERVE`, sem configuração LOW. Reaplique no ambiente
privado as configurações operacionais existentes: `ADMIN_PASSWORD_RECORD`,
`ADMIN_TOTP_SECRET`, origins permitidas e parâmetros SMTP. Esses segredos, TLS e
arquivos externos não são exportados pelo comando: sua recuperação depende de cópia
privada separada do operador. Sem o mesmo segredo TOTP não há continuidade do fator.
Sessões HTTP são efêmeras, exigindo novo login; códigos TOTP já usados continuam
rejeitados quando o estado persistido e o mesmo segredo são recuperados.

O restore preserva a outbox, inclusive tentativas e próximos horários. Não conecte
um restore a SMTP externo ou a worker ativo durante o ensaio: isso pode repetir
efeitos externos já realizados após o instante do backup. Aceitação SMTP não prova
entrega e a recuperação não oferece exactly-once. O ensaio usa porta SMTP fechada.

Teste reproduzível: `npm run build` e `node --test dist/tests/recovery.test.js`, com
`TEST_DATABASE_URL` de laboratório e permissão `CREATE DATABASE`. Cria bancos
sintéticos exclusivos e artifacts privados temporários; preserva-os para inspeção,
sem apagar bancos. Exercita dados completos, hash, recusa de banco ocupado/online,
identidade de sequência, TOTP após reinício, consulta autenticada, tela Chromium,
dois reinícios do processo gateway PILOT_OBSERVE e dois do processo admin real.
CI Linux usa ferramentas PostgreSQL nativas;
Windows pode definir `RECOVERY_TEST_CONTAINER=anticlone-drift-test` apenas no teste
para usar as ferramentas do container WSL já documentado. Nenhum deploy é realizado.

Automação periódica, criptografia/offsite, recuperação dos arquivos operacionais e
restore de produção permanecem responsabilidades operacionais não demonstradas por
este ensaio. O comando não concede autorização para nenhuma dessas alterações.
