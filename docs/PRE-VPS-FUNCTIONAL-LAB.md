# Laboratorio funcional pre-VPS

Base f193ca60; branch feat/consolidacao-pre-vps. Sem deploy ou ativacao operacional.

Com PostgreSQL isolado em TEST_DATABASE_URL e Chromium correspondente ao lockfile:

    npm run build
    node --test --test-concurrency=1 dist/tests/observed-metrics.test.js dist/tests/scoped-gateway.test.js

O teste scoped e o fluxo integrado: dois projetos, duas LPs adicionais do mesmo projeto, original e copia localhost/127.0.0.1, gateway Node real, Chromium, SMTP sintetico, tres ofertas (inclusive canal WhatsApp sintetico), aprovacoes e regras F42 por pagina, classes declaradas, 0/50/100 e versoes, drift isolado/reaprovacao, sessao e acoes persistidas, estimativa, remocao de Core, backend interrompido e reiniciado. O relogio Chromium e controlado somente para manter o prazo laboratorial do Page Redirect; nao e medicao de latencia ou garantia de prazo em producao. Classes sao alegacoes de navegador. LOW sintetico e restrito ao opt-in de instalacoes e origem loopback. Projeto inelegivel e original continuam OBSERVE_ONLY. HIGH/UNCERTAIN tambem sao cobertos pelas regressoes existentes de risco e GS06.

O teste observed-metrics complementa concorrencia/idempotencia, reconexao PostgreSQL, conflito de evento, isolamento, recibo expirado ou de outro projeto, ausencia de dados, revisao de premissas e painel autenticado Chromium. Recibo vincula a alegacao a uma decisao elegivel; nao autentica o visitante nem a execucao. Tentativa de redirect nao comprova carregamento; clique nao comprova checkout ou venda. Valores de campanha publicados sao publicos e explicitamente permitidos, sem detector infalivel de dados sensiveis.

Estado reproduzido localmente: os dois testes focados PASS; lint/typecheck/build PASS. Regressao integral, HTTPS e revisao consolidada ainda pendentes. Relatorio final deve substituir este estado somente apos os comandos correspondentes. Receita recuperada comprovada e handoff/carregamento externo permanecem indisponiveis sem instrumentacao confiavel. SMTP local comprova aceitacao do transporte sintetico, nao caixa postal externa.

Migrations aditivas: 047 fatos/premissas, 048 recibos, 049 isolamento das flags operacionais de drift. Configuracoes aprovadas continuam versionadas e imutaveis. Mudancas em destinos/mapeamentos/ofertas/marcadores/referencias/politicas invalidam a aprovacao. Rollback de codigo preserva tabelas e dados; codigo anterior pode voltar a suspender toda a pagina em drift. Nenhuma migration de producao foi executada.
