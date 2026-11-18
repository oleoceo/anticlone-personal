# Painel React — Entrega B

- **Incidentes.** Lista por projeto com filtros e retorno contextual. A investigação reúne situação, fontes, recibos, linha do tempo e detalhes do backend. A triagem usa a versão do incidente e justificativa auditada.
- **Proteção.** PAGE_REDIRECT e REPLACE_CONVERSION têm publicação versionada, aprovação do conjunto na LP e autorização explícita de origem e caminho. A UI exibe os vínculos que serão substituídos. O inventário de CTA oferece importação, mapeamento, seleção pendente e revisão de destino e termos conforme os dados retornados.
- **Conversões.** Cliques observados, estimativa e vendas reportadas aparecem em áreas próprias. O ticket e a taxa usam inteiros e preservam versão e data do servidor. Vínculos comerciais separam projeto, LP, conta e versão. Receita recuperada comprovada continua indisponível.
- **Continuidade visual.** Formulários centralizados no desktop, área Incidentes na navegação e instruções de instalação com os controles de cópia. Códigos de diagnóstico permanecem nos detalhes. A galeria local da Entrega A continua apontando para a V2.2.
- **Limites do contrato.** Publicar no projeto e aprovar na LP são escritos distintos. A autorização usa a revisão retornada e reconsulta vínculos e gerações antes do envio. A autorização do React exige que a aprovação conferida ainda seja a vigente no momento da gravação. Os clientes administrativos anteriores continuam compatíveis. As consultas de investigação respeitam o recorte retido. Os fluxos de Visão Geral, Configurações e gestão das contas de checkout ficam para a Entrega C. O painel anterior segue acessível.

## Validação

Com PostgreSQL isolado em `TEST_DATABASE_URL`, rode `npm run build` e `node --test --test-name-pattern="incident to PAGE_REDIRECT" dist/tests/admin-frontend.test.js`. Para produzir capturas locais, defina `TEST_FRONTEND_B_CAPTURES` para uma pasta de saída. O teste usa contas, projetos, LPs e domínios sintéticos com as APIs reais.
