# CI local do PR #64

O proprietário escolheu reproduzir o workflow localmente, sem minutos do GitHub Actions. **CI local PASS e GitHub Actions BLOCKED são estados diferentes.** O workflow remoto não foi alterado. PR #64 permanece Draft; não há autorização de merge/deploy. F08 continua BLOCKED por ausência de isolamento de rede comprovado para um verificador navegável.

## Ambiente e execução

`scripts/local-ci.sh` reproduz as etapas de `.github/workflows/ci.yml`, sem duplicar lógica dos testes. Exige Linux, Node 22/npm, Python 3, clientes PostgreSQL 16 (`pg_dump`/`pg_restore`), Docker com Compose, OpenSSL e `gateway.test` resolvendo exclusivamente para loopback. Playwright instala Chromium e suas dependências de SO; isso exige root ou sudo no laboratório. O runner cria PostgreSQL 16 descartável com dados em tmpfs, porta aleatória publicada somente em 127.0.0.1 e credenciais sintéticas; sobrescreve TEST_DATABASE_URL e não usa DATABASE_URL. Ao terminar, remove exclusivamente seu container. Não apontar ferramentas do laboratório para produção.

Na raiz de um checkout Linux completo da branch do PR, com essas dependências:

```bash
node --version # deve ser 22.x
docker compose version
getent ahostsv4 gateway.test # 127.0.0.1
LOCAL_CI_LOG_DIR="$PWD/test-results/pr64-local-ci/final" bash scripts/local-ci.sh
```

Alternativamente, passe o caminho de uma exportação imutável como primeiro argumento. Para os testes de rollback de código, preserve acesso ao histórico Git completo. O runner grava SHA, estado Git, manifesto SHA-256 das fontes, versões, comandos, duração e código de saída por etapa. Interrompe no primeiro erro, inclusive falha de gravação do log. `result.txt` registra o código global; `steps.tsv` permite auditar cada comando. `tests.log` contém a saída integral, sem filtragem de falhas/skips. `evidence.sha256` verifica os logs e manifestos; execute `sha256sum -c evidence.sha256` na pasta dos artefatos.

Neste computador o laboratório já existente é `anticlone-investigation-lab`, em Ubuntu/WSL2, com rede host e `/tmp` compartilhado com o host Docker para os mounts do teste Nginx. O Node padrão desse container era 24, por isso foi disponibilizado o Node **22.23.4** já instalado no WSL, em `/opt/node22`, sem substituir o padrão. O plugin Compose existente no WSL também foi disponibilizado. Invocação neste laboratório, após exportar o HEAD para `/tmp/<exportacao>`:

```bash
docker exec \
  -e PATH=/opt/node22/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  -e GIT_DIR=/gitroot/.git -e GIT_WORK_TREE=/tmp/<exportacao> \
  -e LOCAL_CI_LOG_DIR=/tmp/<evidencias> \
  anticlone-investigation-lab bash /tmp/<exportacao>/scripts/local-ci.sh /tmp/<exportacao>
```

Rede host e mounts aqui são recursos do laboratório de integração, **não isolamento de um verificador F08**. O teste usa documentos HTTPS sintéticos sob controle do laboratório. Não comprova DNS/TLS público ou produção. Não instale um runner público/self-hosted do GitHub para executar estes comandos.

## Evidências desta revisão

O diff `4691f4c..48a9541` contém somente STATUS.md e RUNTIME-DISTRIBUTION-CONTRACT.md. O HEAD de referência **48a95410d6d16e3bf5cc2e1ee7e349cdb112b731** foi exportado do Git, sem alterações locais, e passou pelo workflow completo com Node 22: **105 PASS, 0 FAIL, 0 SKIP**, testes em 307092 ms, pipeline em 450 s, código global **0**. Incluiu npm ci, nove testes Python, Chromium real, Nginx, build Docker, Compose, PostgreSQL descartável, recuperação/restore reais, lint/typecheck/build e suíte HTTPS completa.

Versões observadas: npm 10.9.9; Python 3.12.3; PostgreSQL/pg_dump/pg_restore 16.15; Playwright 1.64.1; Chromium 156.0.8078.4; Docker 29.8.0; Compose 5.5.1; OpenSSL 3.0.13; Nginx tag 1.28-alpine. Imagens e respectivos hashes constam nos logs.

Artefatos completos sanitizados, fora do Git, preservados em `test-results/pr64-local-ci/`: `reference-48a9541/` para o HEAD informado e `final/` para a execução integral do novo HEAD. Cada pasta contém `result.txt`, `steps.tsv`, versões, manifestos e logs individuais. O relatório consolidado gerado em `report.json` registra os SHAs, resultados e hashes dos artefatos. Credenciais constantes nos comandos são exclusivamente sintéticas e públicas do laboratório; nenhum ambiente/segredo operacional foi exportado. Os originais também permanecem no `/tmp` do WSL indicado em cada resultado.

O teste `operational-authorization.test.ts` foi ampliado, sem acrescentar uma cópia do cenário: agora reúne OPERATIONAL, distribuição v2, painel com MFA/CSRF, publicação/rotação nas mesmas origens, autorização/suspensão pela interface, original/cópia HTTPS, PAGE e CTA reais, isolamento e aliases antigos, falha de rede e indisponibilidade real do upstream. Respostas comerciais não são fabricadas nem reescritas. PAGE seleciona PAID; CTA também seleciona DIRECT_UNKNOWN, possibilitando provar ambos na mesma LP. O clique é observado sem interceptação de decisão. As únicas respostas fornecidas pelo teste são os documentos sintéticos; falhas de rede são induzidas exclusivamente nos negativos.

Provas focadas: TLS direto **1/1 PASS**; processo real atrás de Nginx/TLS **1/1 PASS** (46490 ms). Prova negativa do runner: tornar `versions.log` um diretório faz o comando de versões passar e `tee` falhar; o runner registra **exit 1**, interrompe e não cria banco. A mesma prova foi repetida invocando o script por caminho relativo a partir de `scripts/`, para conferir a resolução do runner antes da mudança de diretório. Logs em `runner-negative/` e `runner-relative/`.

`npm ci` relata nove avisos moderados de dependências de desenvolvimento já existentes; o audit suplementar com `--omit=dev` retornou zero vulnerabilidades de produção. Nenhum pacote/lockfile foi atualizado automaticamente. Avisos não são falhas dos testes nem garantia de ausência universal de vulnerabilidades.

A revisão independente anterior dos módulos A–D permanece aplicável: nenhum arquivo em apps/runtime/infra foi alterado nesta rodada. O delta de teste/runner passa por revisão independente específica; seu parecer, o SHA efetivamente testado e o resultado integral final constam no relatório/PR. O bloqueio financeiro remoto não transforma um teste local em falha de código, nem produz um status GitHub verde.
