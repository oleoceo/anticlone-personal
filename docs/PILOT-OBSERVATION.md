# Preparação do primeiro piloto: observação

Estado: IMPLEMENTADO PARCIALMENTE — configuração de origens e modo conservador; não é autorização de operação pública nem proteção ativa demonstrada.

## Fatia F02/F09

`apps/gateway-mode.ts` separa `GATEWAY_MODE=LAB` (padrão compatível com os testes existentes) de `PILOT_OBSERVE`. Neste último, `PILOT_ORIGINS` é um array JSON de 1–20 origens HTTPS canônicas, sem caminhos, credenciais, portas alternativas, curingas ou IPs. A origem principal persistida do projeto deve constar uma única vez. Outras origens são declarações explícitas do proprietário, não descoberta nem prova de propriedade. Configuração só muda com reinício; cada processo continua vinculado a um projeto. Não há fetch, DNS ou instalação em sites a partir dessa lista.

Exemplo exclusivamente sintético: `PILOT_ORIGINS=["https://owner.test","https://preview.owner.test"]`. Não usar `ALLOWED_ORIGIN`, `LAB_CONTROLLED_ORIGIN` ou `LAB_CONTROLLED_RISK` nesse modo: o processo recusa iniciar. O gateway continua ouvindo somente em loopback; publicação HTTPS, proxy, domínio e credenciais exigem preparação e autorização separadas.

As origens exatas da lista não criam incidentes. Outras origens alegadas geram os mesmos sinais não verificados e deduplicados do laboratório; Origin, Referer e payload não autenticam uma cópia. A lista não concede acesso administrativo, confiança ao JavaScript nem risco LOW. O risco permanece UNCERTAIN por insuficiência de evidência; página e refresh de CTA retornam OBSERVE_ONLY antes de consultar políticas de mitigação. Esta fatia não implementa um classificador operacional. Políticas laboratoriais persistidas não habilitam ações nesse modo.

## Capacidades candidatas e impedimentos

Podem compor uma futura etapa de observação, após gates e autorização de instalação: bootstrap/core, observação deduplicada de origem não autorizada, canários e fallback limitados, múltiplas origens próprias exatas, preservação de links nativos e consulta administrativa local com MFA existente. O teste usa Chromium, PostgreSQL e HTTPS interceptado em domínios sintéticos, sem TLS/proxy público nem conexão com páginas reais.

Continuam indisponíveis para o piloto: proteção ativa de página/CTA, risco LOW operacional, checkout/WhatsApp externo aprovado, SMTP externo, verificação de instalação universal, garantia contra spoofing/flood distribuído, publicação segura do gateway/admin, backup/restore e aceitação de produção. Os limites globais de requisição são laboratoriais e podem degradar sob abuso. O gateway público e a segurança de proxy/autenticação ainda são impedimentos: não expor o processo diretamente. Os testes não concluem Entrega A, B ou C, nem GS01/GS10 integrais.

Teste novo: `tests/pilot-observation.test.ts`, com lista exata e separação de modos, origens principal/preview sem incidentes, duas cópias não confiáveis, tráfego pago sem mitigação, decisões UNCERTAIN, clique nativo e indisponibilidade de scripts. Regressões completas existentes cobrem risco, stealth, percentuais, página, CTA, drift e falhas; resultados e SHA final no PR.

## Requisito preservado

PENDENTE — confirmação manual do preço anunciado por CTA integrada ao Offer Snapshot, sem alterar automaticamente decisões de proteção. O interpretador comercial isolado não é consumidor operacional; o protótipo contextual anterior permanece BLOCKED. Esta fatia não o reativa nem elimina funções planejadas.
