# AntiClone Personal — Blueprint de implementação enxuta

**Tipo:** aplicação privada, single-owner, self-hosted em VPS  
**Painel:** `https://protect.leoceo.online`  
**Repositório:** GitHub privado independente do SaaS  
**Objetivo:** operação real de detecção, evidências, alertas, análise de conversões e mitigação configurável em páginas próprias, preservando capacidade técnica e removendo arquitetura comercial SaaS.

> Este documento é uma **recomendação de escopo e arquitetura**, não a afirmação de que as funcionalidades já estão implementadas. O arquivo `PROJECT_STATE.md` do pacote SaaS dizia, em 2026-09-09, que a implementação ainda não havia começado. Inspecionar o estado atual do repositório SaaS se houver código posterior.

## 1. Princípio inegociável

**Enxugar a plataforma, não amputar a proteção.** A aplicação final precisa percorrer o ciclo:

`instalar → identificar execução fora de origem autorizada → registrar observações → correlacionar incidente → enviar alerta deduplicado → classificar tráfego → avaliar risco do operador → aplicar a política apropriada de redirecionamento de página/CTA → registrar ação e alterações → apresentar resultados no painel → manter histórico e capacidade de investigação`.

O sistema não impede toda clonagem, não pode garantir que scripts sobrevivam quando um terceiro remove os recursos, não pode inferir pessoa física com certeza de um fingerprint e não pode garantir redirecionamento quando a lógica foi removida ou bloqueada.

## 2. Mapa de funcionalidades operacionais — todas preservadas

| Capacidades | Versão Personal |
|---|---|
| Vários projetos próprios | Cadastro, pausa, edição de origem autorizada, arquivamento e múltiplas páginas por projeto. Identidade estável independente da URL editável. |
| Instalação multiplataforma | Snippet universal, instruções HTML/CSS, suporte best-effort a sites estáticos, WordPress, React/Vite, construtores que permitam scripts, teste de saúde e indicação FULL/PARTIAL/UNSUPPORTED/NOT_VERIFIED. |
| Camadas de proteção | Bootstrap pequeno + Core Runtime + Fallback independente + HTML Canary + CSS Canary onde aplicável. Decoy de documentos antigos é absorvido pelo papel do fallback, sem prometer ação ativa por canários passivos. |
| Execução em URL autorizada/não autorizada | Identificação e registro de contextos, com origens de produção, preview e staging configuráveis. Observação de `file://` apenas quando transporte permitido. |
| Identificação de dispositivos e operador | Sessões efêmeras e sinais probabilísticos de comportamento/rede/browser com versão do modelo e confiança LOW/UNCERTAIN/HIGH. Nada de identidade humana ou hardware único comprovado. |
| Detecção de clones | Observações recebidas e corroboradas, incidentes por projeto+host, primeiro/último acesso observado, evidências e falsos positivos. |
| Telemetria de tráfego | Sessões do clone, origens paid/organic/referral/direct_unknown, UTMs/click IDs quando presentes, informações limitadas de dispositivo, eventos, conversões e fontes atribuíveis. |
| Identificação de hospedagem | DNS/ASN/provedor de maneira assíncrona, separada do IP do visitante; fetch externo com prevenção de SSRF. |
| Redirecionamento de página | Destino oficial validado, por classe de tráfego e porcentagem; decisão de entrada com limite temporal e liberação em falha. |
| Substituição de CTA | Inventário e seleção de pontos diferentes (planos distintos, WhatsApp, botões, formulário e CTA dinâmico), mapeamento para destino oficial, ação local quando política pronta, sem consulta de rede no clique. |
| Tráfego e percentuais | PAID_ATTRIBUTED, ORGANIC, REFERRAL e DIRECT_UNKNOWN; percentuais independentes por ação/classe, 0–100% em passos de 10; alocação determinística por sessão/regra, sem novo sorteio a cada clique. |
| Modo Invisível | Opcional por política: OFF ignora risco na seleção; ON preserva ações originais diante de evidência forte de possível operador. UNCERTAIN conserva política e registra incerteza. Investigação independente e limitada; sem promessa de invisibilidade infalível. |
| Monitoramento de checkout | Registro de destinos encontrados, alterações relevantes, múltiplas ofertas/planos, matching com marcadores estáveis e fallback estrutural com nível de confiança. |
| Drift comercial | Alteração material exige REVIEW_REQUIRED do ponto afetado; os demais CTAs continuam funcionais. Alertas sem spam. |
| Alertas | Clone confirmado, alteração de CTA/checkout, instalação inativa quando habilitado, falha operacional; e-mail com deduplicação, retry, histórico e destinatário único configurado. |
| Evidências | Linha do tempo, origem da observação, timestamps, sinais de confiança, dados de destino, infra e anexos/referências seguros. Não chamar evidência de identificação jurídica. |
| Métricas | Sessões únicas, incidentes, redirecionamentos, CTA substituídos, checkout handoffs, taxa de mitigação, fonte de tráfego, histórico, estimativa de receita. Sem métricas inventadas. |
| Receita efetiva | Integração mínima com webhook de checkout que suporte identificação de venda atribuída, autenticação/assinatura e idempotência; sem módulo de assinaturas SaaS. Se não houver webhook confiável, mostrar somente estimativa. |
| Infraestrutura/camuflagem | Perfil de rede com rotas não descritivas, alias estável por instalação e revisões versionadas com período de compatibilidade. Um hostname operacional é suficiente inicialmente; domínio extra é endurecimento, não necessidade de lançamento. Não imitar marcas/plataformas de terceiros. |
| Operação | Login privado com MFA, auditoria de mudanças, backups e teste de restore, retenção de dados, health checks, deploy rollback. |

**Regra de escopo:** não transformar a simplificação da interface em remoção de uma das capacidades acima. Se uma capacidade tiver restrição de navegador ou integração, documentar claramente a limitação e testar o comportamento degradado.

## 3. Cortes definitivos de SaaS

Eliminar a implementação de: Organization, Membership, Tenant Isolation, múltiplos usuários de clientes, Admin/Staff roles, client-app separado, planos/plan_versions, subscrições, cobrança, Feature/Entitlement, Manual Access Grants, comercialização, limites de uso por cliente, flags comerciais, dashboards MRR/ARR, controle de acesso por checkout, automação de provisionamento SaaS, Broadcast Campaign, página de cadastro público, painel de suporte a clientes, auditoria de impersonation, hub de ferramentas futuras, complexidade de domínio por tenant e domínios neutros em pool para milhares de clientes.

Preservar `admin_user` único e login/MFA real; jamais substituir autenticação por URL secreta. Manter `project_id`, `installation_id`, `policy_version`, `incident_id`, `conversion_point_id`, `action_id` como identidades duráveis. Remover `organization_id` dos objetos Personal quando só adiciona tenancy fictícia.

## 4. Arquitetura de execução

**Monólito modular single-owner, com worker executável do mesmo projeto.**

```text
Navegador no site próprio ou em cópia não autorizada
    ├── Bootstrap / Core / Fallback JavaScript
    ├── HTML Canary
    └── CSS Canary
                │
                ▼
   runtime.leoceo.online   (hostname operacional sugerido;
                            precisa de DNS/TLS sob seu controle)
                │  HTTPS, rate limit, rotas públicas delimitadas
                ▼
           Nginx/Caddy
                │
                ▼
       Fastify / TypeScript
       ├── Public: assets, bootstrap/decision, event batches, canaries
       ├── Admin: auth, projetos, policies, incidentes, CTAs, métricas
       ├── Domínio: matching, policies, drift, incidentes, risco
       ├── PostgreSQL: estado durável, observações, evidências, outbox
       ├── Redis/BullMQ: fila/cache/rate control
       └── Worker: correlação, agregação, DNS/ASN, e-mails, webhooks

Admin browser -> https://protect.leoceo.online -> Nginx/Caddy
                               └── UI React/Vite + rotas autenticadas Fastify
```

A escolha de `runtime.leoceo.online` é **proposta**, não endereço existente verificado. Alternativa inicial: caminhos públicos segregados no domínio disponível, reconhecendo o risco de expor o host do painel e de concentrar falhas. O ideal é separar o hostname operacional do hostname de administração, mesmo quando ambos apontam à mesma VPS. Não há necessidade de Cloudflare Workers, múltiplos backends ou Kubernetes para a primeira versão; Cloudflare como DNS/proxy/WAF pode ser adotado conforme a infraestrutura disponível.

### Stack pragmática

- **TypeScript, Node.js, Fastify**: preserva a linha de arquitetura consolidada nas especificações mais recentes.
- **React + Vite**: um único painel responsivo, sem app de cliente e admin separados.
- **PostgreSQL + Drizzle**: estado durável, transações, migrations, métricas e outbox.
- **Redis + BullMQ**: worker de eventos e e-mails para não bloquear a decisão. Redis não é a única fonte de verdade.
- **Runtime em TypeScript compilado para JS leve**: código próprio reutilizável, output estático com revisões.
- **Vitest + Playwright**: testes do motor e dos cenários de navegador.
- **Docker Compose + Nginx/Caddy + GitHub Actions mínimo**: deploy seguro na VPS.
- **E-mail SMTP/API**: um provedor configurado, com template estático editável por código (sem CMS de templates).

**Não separar em nove packages apenas para seguir o monorepo SaaS.** Sugestão de layout:

```text
anticlone-personal/
├── AGENTS.md
├── CLAUDE.md
├── README.md
├── docs/
│   ├── PRODUCT-SCOPE.md
│   ├── RUNTIME-CONTRACT.md
│   ├── TEST-SCENARIOS.md
│   └── DEPLOY-RUNBOOK.md
├── apps/
│   ├── web/                 # React/Vite, painel único
│   └── server/              # Fastify API + módulos de domínio
├── runtime/
│   ├── bootstrap/
│   ├── core/
│   ├── fallback/
│   └── canaries/
├── shared/                   # Contratos e schemas; nada de regra de negócio UI
├── tests/
├── infra/
│   ├── compose.yaml
│   └── proxy/
└── .github/workflows/
```

O worker pode reutilizar módulos de `apps/server` em um processo separado (`node dist/worker.js`), sem precisar de `apps/workers` completo. Manter os limites lógicos entre API pública, API privada, regras, persistência e worker.

### Persistência essencial

Entidades lógicas agrupadas (não necessariamente uma tabela para cada nome):

- **Controle:** `admin_users`, `admin_sessions`, `projects`, `protected_origins`, `protected_pages`, `installations`, `network_profiles`.
- **Regras:** `policy_versions`, `conversion_points`, `conversion_mappings`, `offer_snapshots`, `drift_events`.
- **Observações:** `observations`, `incidents`, `evidence_items`, `operator_assessments`, `action_facts`, `runtime_sessions`.
- **Operação:** `outbox_events`, `notifications`, `notification_deliveries`, `daily_metrics`, `audit_events`.
- **Integração opcional habilitável:** `webhook_receipts`, `normalized_sales`, `webhook_delivery_attempts` se outbound estiver habilitado.

Adicionar índices e unicidade especialmente em `(project_id, normalized_unauthorized_host)` para correlação, `notification_dedup_key`, ids de eventos/webhooks e `(policy_version, conversion_point_id)` quando apropriado. Regras de arquivamento não podem apagar históricos contabilizados.

## 5. Protocolo de segurança e mitigação

1. O cliente instala referência pública de runtime e sinais de integridade **somente nos seus próprios sites**.
2. Na página, o runtime observa `location` e características mínimas do ambiente. No servidor, validar/normalizar o contexto com sinais da requisição e os IDs públicos da instalação. Uma string de hostname enviada pelo navegador é **evidência não confiável**, nunca prova isolada.
3. Na origem autorizada, não aplicar mitigação visível; realizar verificação de instalação, descoberta de pontos de conversão e métricas configuradas.
4. Em origem não autorizada, coletar observações e obter decisão de sessão sob limites estritos de tamanho/tempo. Armazenar evidências e incidentes no backend; processar trabalho pesado no worker.
5. D05 atualizada (2026-11-09): Stealth é opcional por política versionada de página/CTA. OFF ignora LOW/HIGH/UNCERTAIN na seleção comercial. ON suprime mitigação visível apenas com evidência forte verificável de possível operador e confiança documentada; UNCERTAIN mantém a política por padrão e registra incerteza. Segurança, origem, elegibilidade, aprovação, destino e percentuais continuam obrigatórios. Legado preservado até republicação/reaprovação explícitas; demonstração somente em laboratório, sem ativação em domínios reais.
6. `PAGE_REDIRECT`: decisão de entrada com render gate temporário **limitado**; timeout libera a página (*fail-open*), sem travá-la. Não prometer 0 ms/100% de acerto.
7. `REPLACE_CONVERSION`: quando política e ponto estão prontos, decidir **localmente**, sem `fetch()` no momento do clique. Cobrir âncoras, formulários, janelas, mobile e DOM dinâmico onde a plataforma permitir.
8. Separar inventário de conversões, mapeamento e alteração material. Alterações que invalidem mapeamento colocam apenas o ponto afetado em `REVIEW_REQUIRED`, em vez de mandar um comprador para oferta errada.
9. Percentuais baseados em hash determinístico de `(public_session_id, rule_id, policy_version)`, com estratégia documentada para recarga/sessão. Não rerolar clique a clique.
10. Ações/telemetria posteriores ao clique são assíncronas e sujeitas a falha. Métricas de ação representam ação iniciada/observada, não comprovação de compra ou de carregamento do checkout externo.
11. O gateway deve validar esquema, métodos, limites, sessão/instalação, origem contextual, taxa e filas, sem aceitar destinos arbitrários ou segredos no browser.
12. `Referer`, `Origin`, UTMs, Canvas e WebGL são **sinais com limitações**. `Referer` pode faltar; `Origin` não constitui autenticação; clientes não browser podem forjar headers; fingerprints não identificam humanos; `file://` pode não conseguir transmitir; scripts removidos não continuam ativos.

**Preferência por segurança e integridade sobre camuflagem impossível:** caminhos neutros e bundles minificados ajudam a organização/obfuscação, mas não garantem ocultação no DevTools. Não fabricar payloads que se apresentem falsamente como provedores terceiros, nem usar o nome de marcas sem autorização. As redes públicas devem ser construídas sobre segurança real, não obscuridade.

### Política de percentuais

Representar como regra declarativa versionada, sem uma DSL de programação:

```text
project_id
policy_version
page_redirect_enabled
page_redirect_destination_id
conversion_replacement_enabled
stealth_enabled // explícito por política; stealth_version=2 na nova semântica
allocation[PAID_ATTRIBUTED]   = 0..100 step 10
allocation[ORGANIC]          = 0..100 step 10
allocation[REFERRAL]         = 0..100 step 10
allocation[DIRECT_UNKNOWN]   = 0..100 step 10
conversion_point_mappings[]
```

**Observação:** definir prioridades entre Page Redirect e CTA Replacement (redirecionamento de página executado na entrada prevalece; CTA funciona se a página permanece). Configurações/percentuais devem ser independentes por tipo de ação se a interface assim permitir, não uma porcentagem global compartilhada.

## 6. Painel único — UX sem páginas placebo

**Navegação primária (quatro itens):**

1. **Visão Geral:** incidentes ativos, novos clones, saúde, tráfego de cópias, ações, estimativa de valor e alertas relevantes.
2. **Projetos:** lista, criar, editar, pausar/arquivar; detalhe do projeto com abas `Resumo | Proteção | Conversões | Incidentes | Instalação`.
3. **Incidentes:** lista agregada e detalhe com host, primeira/última observação, evidências, origens de tráfego, alterações, risco probabilístico, recursos de investigação, falso positivo e resolução.
4. **Configurações:** perfil/segurança, destinatário de e-mails, provedor de entrega, domínio operacional/perfis de rota, integrações de checkout, retenção/backup/saúde. Evitar subnavegação lateral adicional.

**Login:** rota `/login` sem signup público. Áreas privadas protegidas com sessão e MFA; CSRF/cookies/configuração de proxy revisados. Interface responsiva mobile. Se módulo ainda não funciona, não mostrar botão ligado fictício.

## 7. Três entregas verticais, sem 12 milestones e sem dezenas de T01–T07

Estas são **entregas operacionais**, não nova burocracia de projetos. Dentro de cada uma, Codex executa mudanças pequenas de código e testes; a entrega é aceita por comportamento observável.

### Entrega A — Loop real de detecção e aviso

**Incluir:** repo, Compose, autenticação, panel mínimo, projetos/origens/instalação, script básico, gateway/ingestão, observações, incidente por host, deduplicação e e-mail, verificação de instalação, log/diagnóstico básico.

**Critério de pronto:** abrir página própria simulada e sua cópia sob hostname de teste controlado; o painel reconhecer origens distintas, gerar um único incidente por host e emitir um único aviso de detecção apesar de visitas repetidas. O site original não recebe ação visível; reiniciar serviço não apaga o incidente.

### Entrega B — Motor de proteção integral

**Incluir:** bootstrap/core/fallback, canários HTML/CSS, tráfego por classes, regras e percentuais determinísticos, risco/Stealth, Page Redirect, conversões/CTA com inventário e mapeamento, DOM dinâmico, drift/REVIEW_REQUIRED, alerta de alteração, proteção contra abuso, testes multi-browser.

**Critério de pronto:** em ambiente próprio de clone simulado, provar redirecionamento de página e CTA, vários planos, classes 0/50/100, estabilidade por sessão, operação de Stealth, alternância de política, fallback limitado e continuidade de CTAs não afetados pelo drift. Se o backend falha, não travar a navegação. Nada de `fetch()` no clique com policy pronta.

### Entrega C — Operação pessoal completa e produção

**Incluir:** painel responsivo completo, filtros, evidências, métricas verdadeiras, receita estimada com entradas configuráveis, integração mínima de webhook de vendas para receita comprovada quando compatível, DNS/ASN enrichment seguro, painel de alertas, histórico, arquivamento, retenção, backup + restore, GitHub Actions e deploy na VPS.

**Critério de pronto:** proteger dois projetos diferentes sem misturar informações; validar métricas sem duplicidades; testar webhook duplicado sem venda duplicada; arquivar um projeto mantendo histórico; restaurar backup em ambiente controlado; fazer deploy/rollback; comparar páginas com/sem runtime e medir overhead; executar teste autorizado final em página real.

Não chamar uma entrega de concluída por frontend bonito ou endpoints mockados. Sem abrir novos épicos SaaS durante a implementação.

## 8. Cenários de aceitação críticos (Golden Scenarios)

| Cenário | Verificação |
|---|---|
| GS01 Original | Origem autorizada, compra e navegação normais, telemetria opcional e saúde correta. |
| GS02 Clone | Execução fora da whitelist cria observação/incidente; dois acessos não geram dois incidentes/e-mails. |
| GS03 CTA múltiplos | Plano Básico e Premium distintos, mapeamento correto e WhatsApp não afetado indevidamente. |
| GS04 Política 0/50/100 | Bucketing determinístico por sessão e categoria; proporções estatísticas verificáveis em grande amostra. |
| GS05 Modo invisível | Stealth OFF: risco não interfere na seleção. ON: evidência forte de operador suprime; UNCERTAIN conserva política e registra incerteza. Sem identidade garantida; legado exige migração explícita. |
| GS06 Página | Redirecionamento com URL aprovada; render gate sempre solto no prazo em erro/timeout. |
| GS07 Dynamic DOM | Popup/sticky CTA aparece após carregamento e é inventariado/tratado quando compatível. |
| GS08 Drift | Checkout alterado gera alerta/review, sem desabilitar outras opções. |
| GS09 Fallback | Core removido: fallback mantém só capacidades declaradas; canários só observam. Sem falsa promessa de proteção integral. |
| GS10 Ad blockers/CSP/offline | Diagnóstico indica perda real de capacidade, sem travar original ou visitante. |
| GS11 Abuse | Rate limit, body bounds, controles de replay/queue; entradas falsas não concedem autoridade. |
| GS12 Forense | URL host observada, DNS/ASN separados de IP visitante, primeira observação sem chamar data de publicação. |
| GS13 Alertas | Notificação não duplica; falha SMTP não desfaz incidente; retries são identificáveis. |
| GS14 Métricas | Cliques ≠ compras; receita estimada rotulada; webhooks duplicados deduplicados. |
| GS15 Retenção | Arquivo/pausa não apaga agregados; dados sensíveis expiram conforme política definida. |
| GS16 Restore | Backup de Postgres e arquivos operacionais restaura de verdade, com teste antes do deploy principal. |

## 9. Organização de Codex, Claude Code e Poracode

**Regra de ouro:** dois agentes não implementam a mesma parte em uma única árvore de trabalho simultaneamente. Poracode oferece múltiplos agentes, diffs e worktrees; isso é útil para **implementar e revisar**, não para criar duas implementações concorrentes do mesmo domínio.

- **Codex:** implementar uma fatia funcional delimitada (código, migration, teste, UI mínima) a partir de casos de aceitação.
- **Claude Code:** revisão independente de lógica, segurança, regressão e coerência do runtime/contrato; propor patch em worktree próprio ou relatório. Alternar papéis quando fizer sentido.
- **Poracode:** acompanhar worktrees/branches, diffs, testes, commits e PRs. Um branch por comportamento significativo, não 70 documentos de tasks.
- **Fonte de verdade única:** `docs/PRODUCT-SCOPE.md` + `docs/RUNTIME-CONTRACT.md` + `docs/TEST-SCENARIOS.md` (as escolhas e requisitos pessoais), com `AGENTS.md` apontando para eles e `CLAUDE.md` referenciando as mesmas regras em vez de duplicá-las.
- **Status enxuto:** `STATUS.md` com `Feito | Em construção | Próxima capacidade | Bloqueio | Último teste` e máximo de uma página. Atualizar apenas em mudança real.
- **Pull Request:** escopo pequeno, diff revisado, testes que comprovam comportamento, rollback quando envolve dados. Não exigir cerimônia de 11 milestones.

### Instruções iniciais sugeridas para AGENTS.md / CLAUDE.md

```markdown
# AntiClone Personal — regras de implementação
- Projeto privado para um único administrador; não construir funcionalidades SaaS.
- Preservar integralmente capacidades listadas em docs/PRODUCT-SCOPE.md.
- Priorizar um ciclo ponta-a-ponta testável em vez de scaffolding e UI decorativa.
- Não criar páginas, rotas ou controles placebo.
- Browser/runtime é ambiente hostil; IDs públicos não são segredos.
- Não prometer rastreamento determinístico, 0 ms, blindagem infalível ou receita confirmada sem dados.
- Aplicar backend autorizado para mudanças e URLs de destino.
- Evitar network call na decisão local de CTA quando política pronta.
- Tratar métricas/eventos com dedup e versão. Dados sensíveis têm retenção definida.
- Não alterar contrato do runtime sem testes dos cenários Golden relevantes.
- Antes de implementar: informar arquivos afetados, cenários e risco de regressão.
- Ao concluir: listar diff funcional, migrations, testes executados e limites conhecidos.
- Não abrir fase/milestone extra nem adicionar serviços sem necessidade medida.
```

## 10. Custos e infraestrutura

Um único repositório, um serviço web, um processo API, um worker, Postgres e Redis em Docker na VPS existente reduzem o número de operações e fornecedores. O custo de infraestrutura tende a ser menor do que uma arquitetura com vários serviços/hosts, mas **o custo total não pode ser estimado sem CPU/RAM, tráfego, armazenamento, plano SMTP, política de backup e proteção perimetral**.

Mínimo de produção:

- HTTPS para painel e endpoint operacional.
- MFA/sessões seguras, painel não aberto a cadastros e endpoints administrativos separados dos públicos.
- Senhas/chaves SMTP/database fora do GitHub e do bundle browser, rotação quando necessário.
- Firewall, limites de requisição/body, políticas de confiança em proxies corretamente configuradas; Cloudflare/Nginx sem aceitar cabeçalhos de IP falsificados de qualquer cliente.
- Restrições de rede e timeouts para enriquecimento de host externo (SSRF), e visualização segura de evidências hostis.
- Backup automático offsite, restore ensaiado, monitoramento do processo/filas/disco, migrações versionadas e rollback.
- Privacidade e LGPD: coletar somente o necessário, documentar base legal, avisos, prazos e controle de acesso, sobretudo se usar sinais de dispositivo/rede de visitantes.

## 11. Decisões antigas que devem ser reinterpretadas

| Afirmação anterior | Forma correta de preservar a capacidade |
|---|---|
| Canvas/WebGL + SHA-256 identifica pessoa/hardware de modo inequívoco | Gera sinal probabilístico sujeito a colisões, alteração, bloqueios e regras de privacidade. SHA-256 não torna dado automaticamente anônimo. |
| `file://` sempre faz ping e identifica o futuro clonador | Observação apenas best-effort; navegadores e política de rede podem impedir comunicação. |
| X-Forwarded-For primeiro IP é sempre real | Só confiar em cabeçalhos de proxies explicitamente confiáveis; IP recebido do navegador é do visitante/saída de rede, não necessariamente hospedagem do clone. |
| Pixel/CSS Canary detecta qualquer cópia | Referer pode ser omitido, recursos podem ser removidos/cacheados/bloqueados; canário observa sinais parciais. |
| Captura do clique em 0 ms; script tem impacto zero | Garantir caminho local sem rede quando pronto; medir p95/p99 e overhead real. Primeiro clique/timeout pode falhar de forma segura. |
| Alias, Base64 e nomes de pixel escondem o sistema de qualquer IA/DevTools | Ofuscação não é controle de segurança; rotas públicas e JS são inspecionáveis. Não imitar serviço terceirizado. |
| Toda primeira visita sem UTM pertence ao operador | Sinal fraco: normal classificar como desconhecido; avaliação probabilística multissinal. |
| Fila basta para resposta instantânea em verificação | Separar decisão síncrona pequena do processamento assíncrono; garantir durabilidade do incidente e intenção de notificação. |
| Comprar de checkout significa venda recuperada | Handoff/click executado ≠ compra; só webhook/instrumentação confiável confirma transação. |

## 12. Critérios de corte de escopo sem perda funcional

Quando surgir a proposta de um componente adicional, perguntar:

1. É necessária para instalar/detectar/analisar/proteger/alertar/medir nos meus próprios projetos?
2. É fundamental para segurança, latência, correção ou recuperação de falhas?
3. Há teste observável que a justifique?
4. Se não, é apenas uma abstração da futura operação comercial SaaS?

Se for (4), **não implementar**. Se for funcionalidade AntiClone (1) ou requisito não funcional essencial (2), **preservar**. Se houver abordagem menor que entregue o mesmo comportamento comprovado, preferi-la.

## 13. Prioridade dos documentos SaaS consultados

Preservar a **semântica de proteção** de `11-PRODUCT-DEFINITION`, `12-MVP-SCOPE`, `16-SECURITY-PRINCIPLES`, `21-EVENT-MODEL`, `22-METRIC-DICTIONARY`, `23-RUNTIME-PROTOCOL`, `24-EDGE-DELIVERY-NETWORK`, `25-INCIDENT-EVIDENCE-MODEL`, `26-CONVERSION-SURFACES-DRIFT`, `27-COMPATIBILITY-MATRIX`, `28-PERFORMANCE-BUDGETS-BENCHMARKS`, `31-NOTIFICATIONS-EMAIL-TEMPLATES`, `34-PRIVACY-DATA-RETENTION`, `67-DEFINITION-OF-DONE`, `68-TEST-ACCEPTANCE-PLAN`.

**Não copiar automaticamente** o escopo de tenancy/comercialização de `18-AUTHENTICATION-AUTHORIZATION`, `19-PLANS-FEATURES-ENTITLEMENTS`, `32-ADMIN-BROADCAST-COMMUNICATIONS`, os múltiplos apps/packages de `64-REPOSITORY-STRUCTURE`, nem o grafo `65-MILESTONES`/`66-TASK-GRAPH`. Esses materiais servem de referência, não de plano Personal obrigatório.

## 14. Prompt para iniciar o projeto com Codex/Claude Code

> Leia `ANTICLONE-PERSONAL-BLUEPRINT.md` como escopo base. Estamos criando um novo repositório privado chamado AntiClone Personal, single-owner, self-hosted numa VPS, com painel em protect.leoceo.online. Não reutilize a arquitetura multi-tenant, comercial e multiapp do SaaS. Preserve todas as capacidades operacionais da matriz de funcionalidades e os cenários Golden. Proponha a estrutura mínima de repositório, modelos essenciais e o primeiro fluxo vertical com teste de detecção real em um hostname de cópia sob nosso controle, incidente deduplicado e envio de e-mail. Antes de escrever código, mostre apenas: (1) módulos/arquivos que implementará, (2) cenário de aceitação e (3) riscos técnicos. Depois implemente esse primeiro fluxo completo e verifique os testes. Não crie 12 milestones, dezenas de tasks, interfaces placebo ou funcionalidades SaaS. Não use mock como prova de funcionamento em produção. Mantenha STATUS.md curto e atualizado.

---

**Nota:** O plano é uma interpretação especializada dos três textos iniciais e do pacote de especificações SaaS recebido. Se houver código SaaS existente fora desse pacote, rever o potencial de reutilização antes de reescrever módulos. A versão Personal não deve migrar automaticamente dados/usuários SaaS nem compartilhar secrets ou banco com o produto comercial.

### Referências técnicas externas para verificação de compatibilidade

- MDN Referrer-Policy: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referrer-Policy
- MDN CORS: https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS
- Cloudflare Workers Static Assets (somente se edge adotado futuramente): https://developers.cloudflare.com/workers/static-assets/
- Poracode: https://poracode.com/

### Atualização derivada de D05 — 2026-11-09

Este blueprint Personal incorpora a decisão atualizada do proprietário. A regra inicial Stealth First suprimia HIGH e UNCERTAIN; esse histórico permanece em docs/DECISIONS.md e nos documentos originais de referência. A nova semântica é opt-in, versionada, independente entre página e CTA e exige republicação/reaprovação. Detalhes e limites em docs/OPTIONAL-STEALTH.md. Nenhuma evidência disponível neste recorte sustenta classificação operacional de operador; o caso forte é uma fixture sintética loopback.

Evolução autorizada em 2026-11-11: investigação contínua com Stealth ON/OFF, perfil de grupo separado da avaliação de sessão e avaliador shadow. O interruptor controla apenas o eventual veto adicional, nunca a investigação. Proposta interna Stealth v3 permanece sem ativação e depende de aprovação posterior; v2 e legado preservados. Implementação, métricas e limites em [F13/F14 shadow](docs/F13-F14-SHADOW.md). Não há evidência operacional suficiente para concluir F13/F14.
