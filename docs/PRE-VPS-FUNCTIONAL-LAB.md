# Laboratorio funcional pre-VPS

Base f193ca60; branch feat/consolidacao-pre-vps. Sem deploy ou ativacao operacional.

Com PostgreSQL isolado em TEST_DATABASE_URL e Chromium correspondente ao lockfile:

    npm run build
    node --test --test-concurrency=1 dist/tests/observed-metrics.test.js dist/tests/scoped-gateway.test.js

O teste scoped e o fluxo integrado: dois projetos, duas LPs adicionais do mesmo projeto, original e copia localhost/127.0.0.1, gateway Node real, Chromium, SMTP sintetico, tres ofertas (inclusive canal WhatsApp sintetico), aprovacoes e regras F42 por pagina, classes declaradas, 0/50/100 e versoes, drift isolado/reaprovacao, sessao e acoes persistidas, estimativa, remocao de Core, backend interrompido e reiniciado. O relogio Chromium e controlado somente para manter o prazo laboratorial do Page Redirect; nao e medicao de latencia ou garantia de prazo em producao. Classes sao alegacoes de navegador. LOW sintetico e restrito ao opt-in de instalacoes e origem loopback. Projeto inelegivel e original continuam OBSERVE_ONLY. HIGH/UNCERTAIN tambem sao cobertos pelas regressoes existentes de risco e GS06.

O teste observed-metrics complementa concorrencia/idempotencia, reconexao PostgreSQL, conflito de evento, isolamento, recibo expirado ou de outro projeto, ausencia de dados, revisao de premissas e painel autenticado Chromium. Recibo vincula a alegacao a uma decisao elegivel; nao autentica o visitante nem a execucao. Tentativa de redirect nao comprova carregamento; clique nao comprova checkout ou venda. Valores de campanha publicados sao publicos e explicitamente permitidos, sem detector infalivel de dados sensiveis.

Validacao final no codigo f0dd974f90325f76a688a6e016ae8f996a2d355c: Linux, PostgreSQL 16, Chromium e Nginx HTTPS reais; 98 testes PASS, 0 FAIL, 0 SKIP, processo encerrado com codigo 0 (219577.617969 ms). Lint, typecheck, build final, validacao documental e 9 testes Python PASS. Imagem Docker construida e Compose config --quiet aprovado. Revisao independente /root/final_consolidated_review favoravel ao delta consolidado e correcoes finais, sem achados bloqueantes. Telemetria, estimativa e protecao permanecem limitadas ao contrato laboratorial. Receita recuperada comprovada e handoff/carregamento externo permanecem indisponiveis sem instrumentacao confiavel. SMTP local comprova aceitacao do transporte sintetico, nao caixa postal externa.

Migrations aditivas: 047 fatos/premissas, 048 recibos, 049 isolamento das flags operacionais de drift. Configuracoes aprovadas continuam versionadas e imutaveis. Mudancas em destinos/mapeamentos/ofertas/marcadores/referencias/politicas invalidam a aprovacao. Rollback de codigo preserva tabelas e dados; codigo anterior pode voltar a suspender toda a pagina em drift. Nenhuma migration de producao foi executada.

Evidencia local final: /tmp/anticlone-final-linux-suite.log (WSL), SHA-256 879be2c9a0f147afa8b60412ac538696109af2b55c7df4efa5ea709047cf8d8c; /tmp/anticlone-final-linux-suite.exit contem 0. Comandos: python3 scripts/validate_repo.py; python3 -m unittest discover -s scripts -p "test_*.py"; npm run lint; npm run typecheck; HTTPS_GATE_TEST=1 npm test; npm run build. O laboratorio usa historico Git original somente leitura para o teste de rollback (GIT_DIR=/source/.git e safe.directory=/source); CI usa checkout com historico completo. A fixture TTL F44 agora e transacional, e o restore aguarda ausencia real de sessoes no PostgreSQL. As duas falhas anteriores foram corrigidas e a bateria integral repetida com zero falhas/skips.
