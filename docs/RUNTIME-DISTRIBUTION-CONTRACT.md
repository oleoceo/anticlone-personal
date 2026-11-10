# Contrato de arquitetura e distribuição v1

Base inspecionada: main após PR #63, 34853e1. Este contrato precede alterações do runtime. F07/F03 são a capacidade verificável desta consolidação; nenhuma capacidade ausente passa a entregue por este documento.

| Camada atual | Entrada e identidade | Saída / dependências | Falha |
|---|---|---|---|
| Bootstrap (`runtime/bootstrap.js`) | URL do script, pathname, sessão pública, sinais declarados | Carrega Core; aplica PAGE_REDIRECT e snapshots CTA; consulta entry-decision/cta-refresh; recibos F29. Fallback é instalado separadamente | Redirect 150ms fail-open; CTA sem fetch no clique, resposta até 5s, TTL 120s; navegação nativa |
| Core (`runtime/core.js`) | URL, origem/pathname, atribuição limitada | POST observe; somente coleta, não é o motor completo | Melhor esforço, sem bloquear página |
| Fallback (`runtime/fallback.js`) | Sua própria URL e contexto | POST observe/fallback, observação independente quando instalado diretamente | Sem promessa de mitigação; falha silenciosa |
| HTML/CSS Canary | GET imagem com Referer alegado | observeCanary; agregados passivos, sem decisão | Referer ausente é desconhecido; nenhuma mitigação |
| Gateway (`server.ts`, `scoped-gateway.ts`) | IDs públicos de instalação, JSON limitado, headers não confiáveis | resolvePageContext -> projeto/LP; coleta, políticas, elegibilidade e respostas | Observação 4xx/503; decisão OBSERVE_ONLY; proxy e limites preservados |
| Motor (`page-redirect.ts`, `cta-policy.ts`, `allocation.ts`) | Snapshot aprovado e versionado, destino validado, classe/sessão | Decisão por ação, percentuais independentes, drift por ponto/superfície | Sem aprovação/elegibilidade mantém original; ainda limitado ao laboratório |
| Stealth (`risk.ts`, `stealth.ts`) | Evidência com procedência e avaliação separada | Legado LOW; v2 OFF sem veto de risco; ON conserva UNCERTAIN (D05) | Sem HIGH operacional fabricado; fixture HIGH somente laboratório |
| Alias Manager (novo v1) | Instalação da LP + papel + revisão | Associação durável, pública, sem credenciais; caminhos antigos preservados | Sem migration/configuração, distribuição explicitamente indisponível |
| Instalação/painel (`protected-pages.ts`, `admin-ui.ts`) | Admin autenticado/CSRF, projeto + LP | Criação explícita de distribuição; consulta sem gerar aliases; HTML/CSS e diagnóstico por camada | NOT_VERIFIED: sinais alegados não comprovam instalação |

## Distribuição v1

Três papéis lógicos SCRIPT, TELEMETRY e STATIC_ASSETS compartilham inicialmente uma origem operacional própria. Configuração privada associa cada papel à sua origem; acesso admin permanece privado e separado. Origem pública nunca é inferida de Host/Origin da requisição. O consumidor recebe URLs completas por papel. Não há identidade falsa de terceiros.

Cada revisão persiste origens e aliases por instalação/papel. Publicar revisão posterior é explícito; revisões anteriores continuam resolvíveis. Alterar configuração não altera URLs distribuídas. Rotas legadas `/runtime.js`, `/i/:installation/...` permanecem. Identificadores/aliases são correlação, não autenticação. Novos caminhos usam `/d/v1/:alias/:endpoint` e retornam o mesmo contrato de decisão atual; v1 de distribuição não muda versões das políticas.

Bootstrap continua responsável pela execução de ações; Core continua coletor. Scripts distribuídos recebem as três bases por papel; Fallback aparece como script independente no HTML. Reinseri-lo permite nova tentativa após falha. Canários são passivos e vinculados à instalação, com diagnóstico limitado; retenção dos sinais de LP permanece sete dias. Sem scripts ativos não há promessa de proteção ativa.

F45: canários autorizados atualizam a atividade na instalação existente, quando o schema opcional está presente. F44: `runtime-layer-observations.ts` liga Core/Fallback e canários scoped ao avaliador existente, somente para IDs/origem SCOPED_LAB autorizados em loopback. Fila serial limitada a 100, lacuna monotônica após reinício/saturação/perda conhecida, retenção e limiares existentes. A manutenção conserva a mesma origem de correlação. Falhas depois do contexto resolvido invalidam a linha de base; rejeições anteriores ao contexto/proxy continuam desconhecidas. Correlação é por projeto/host, não comprova adulteração individual de uma LP. Stealth não consome essa inferência como identidade de operador.

## Configuração e instalação

Migration 051 sucede 050 e as migrations existentes, somente no laboratório autorizado nesta entrega. Gateway e admin compartilham banco/código; o proxy público continua recusando rotas administrativas. Admin permanece no processo privado existente. `/admin/ui/distribution` usa sessão e CSRF existentes.

Configuração privada inicial do admin: `RUNTIME_PUBLIC_ORIGIN=https://runtime.owner.test`, sem barra final. É exemplo próprio, não endereço publicado. SCRIPT, TELEMETRY e STATIC_ASSETS herdam essa origem única. Quando houver hostname administrativo configurado, informar também `ADMIN_PUBLIC_ORIGIN`; publicação recusa o mesmo hostname operacional. URLs não vêm de campos do browser nem de headers. Aliases são públicos.

No painel, informe projeto e ID da LP em **Distribuição e instalação por LP**. **Consultar distribuição** não cria nem troca aliases. **Publicar endereços de instalação** grava três aliases atomicamente e é idempotente enquanto a configuração não mudar. Copie HTML para a LP e CSS para sua folha de estilos; aplique `anticlone-canary` a um elemento visível existente. A regra CSS pode ser sobrescrita pelo site: confirme a requisição no navegador. Ajuste CSP da página sob seu controle para script-src/connect-src/img-src das origens configuradas; sem permissão da plataforma a camada pode não carregar.

Diagnóstico lista Core/Fallback/HTML/CSS recebidos nos últimos sete dias; Bootstrap não tem sinal próprio e permanece UNKNOWN. Confira runtime.js e core.js na aba Rede para essa camada. Sinal é alegação forjável, portanto NOT_VERIFIED não vira verificação controlada. Canários sem Referer podem produzir agregado desconhecido sem sinal autorizado da LP. Não confundir ausência com adulteração.

Evolução explícita: `RUNTIME_SCRIPT_ORIGIN`, `RUNTIME_TELEMETRY_ORIGIN`, `RUNTIME_STATIC_ASSETS_ORIGIN` no ambiente privado sobrescrevem cada papel. Publicar novamente cria outra revisão; consultar não muda revisão. Revisões e aliases são imutáveis. Manter hostnames/proxies antigos enquanto houver instalação anterior; desligá-los exige migração explícita. O HTTPS fornecido atende um hostname inicial: múltiplos hosts não estão publicados ou homologados e exigirão fronteiras TLS/proxy autorizadas. Consumidores v1 já usam três bases e não precisam mudar.

## Provas reproduzíveis

`tests/runtime-distribution.test.ts`: PostgreSQL/Chromium, painel autenticado, consultas sem rotação, publicação concorrente idempotente, isolamento, F45, HTML/CSS/Fallback independentes, versões antigas e F44 com amostras reais envelhecidas transacionalmente. Trigger sintético no registro principal produz HTTP 503 e invalida a linha de base sem inventar observação Core.

`tests/scoped-gateway.test.ts` executa o mesmo cenário operacional em modo legado e distribuição v1: redirect, CTA sem decisão no clique, quatro classes, 0/50/100, atribuição permitida, drift isolado, revisão, F29/F30/F42, investigação #63, SMTP sintético e reinício. `tests/https-gateway.test.ts`, com `HTTPS_GATE_TEST=1`, carrega aliases por Nginx/TLS real e recusa papel incorreto. Comando completo: `HTTPS_GATE_TEST=1 npm test` no laboratório Linux com PostgreSQL/Chromium/Docker; lint/typecheck/build são gates adicionais. Evidências finais no STATUS/PR; não concluir proteção de produção.

Revisão independente consolidada `/root/distribution_review`, somente leitura: favorável, sem P0/P1/P2 remanescentes. SHA-256 dos 17 arquivos de código/runtime/infra/testes revisados: `dfa7a863043ae7b0e509b5080881055567e4eb188b2c7a425f7830fcc592f60d`. Algoritmo: caminhos ordenados, concatenar caminho + NUL + conteúdo UTF-8 normalizado LF + NUL. Achados resolvidos: retry legado Fallback, atividade F45, lacunas e inicialização F44, origem consistente na manutenção e prova HTTPS. Documentação operacional conferida na mesma sessão.

Prova local final: regressão Linux/PostgreSQL/Chromium/HTTPS 104 PASS, zero falhas/skips (270360 ms), seguida do complemento TLS final 2/2 PASS (17064 ms). Lint/typecheck/build e nove testes Python PASS. Logs laboratoriais `/tmp/anticlone-distribution-suite-final.log` e `/tmp/anticlone-distribution-tls-final.log` no WSL; imagem `anticlone-pilot:test` reconstruída do código final. A CI do SHA final permanece gate do PR.

## Preservação

Nenhuma alteração das regras comerciais, aprovações, drift, F29/F30/F42, investigação #63, alertas, lifecycle ou auditoria é autorizada implicitamente pela distribuição. Testes antigos continuam gates. Coleta, correlação e risco permanecem nos módulos existentes; sem novas características pessoais ou inferência de operador. Homologação é sintética; sem DNS/deploy/migration de produção ou ativação real. Múltiplos hosts requerem configuração explícita de proxy/TLS autorizado no futuro, mantendo o consumidor v1.
