# Matriz de Cobertura Funcional — AntiClone Personal

Frente B, recorte laboratorial F17/F20/F21/F23/F24/F43: `tests/protection-admin-ui.test.ts` acrescenta configuração no painel, quatro classes declaradas e 0/50/100 por ação, destinos HTTPS externos autorizados por URL exata, múltiplas ofertas e revisão isolada de drift. Capacidade integral continua PARCIAL: LOW operacional, formulários (D07), destinos comerciais reais e cenários adversariais integrais permanecem pendentes. Detalhes em `PROTECTION-ADMIN.md`; gates finais no PR.

Frente A / F26: `tests/smtp-provider.test.ts` demonstra transporte SMTP configurável por ambiente privado, TLS implícito/STARTTLS, retry com histórico 033 e consulta no painel, em PostgreSQL/Chromium/SMTP local. Configuração pública deve coincidir com ambiente privado; credenciais não chegam ao browser. Capacidade permanece PARCIAL: aceitação local não prova entrega externa, nem provedor real autorizado configurado. Limites em `CLONE-SMTP.md`; gates e revisão do SHA final no PR.

**Estado:** cobertura documental F01–F40 **AUDITADA** nas fontes temáticas consultadas; F41–F45 registram lacunas. Não é código implementado nem prova de comportamento; a auditoria não garante exaustividade.

Legenda: **P** = planejada no Personal; **PARCIAL** = parte comprovada, capacidade incompleta; **V** = validada por teste; **B** = bloqueada com explicação. Inicialmente tudo está `P`. Cada `Fxx` só vira `V` depois de evidência de teste, não por texto ou interface.

| ID | Capacidade operacional preservada | Fonte SaaS (arquivo ou texto) | Prova mínima / cenário | Sit. |
|---|---|---|---|---|
| F01 | Vários projetos próprios e identidade estável independente da URL | 12-MVP-SCOPE, 14-DOMAIN-MODEL | GS16, GS01; cadastro e isolamento local em tests/projects.test.ts, CI 41677878620 | PARCIAL |
| F02 | Múltiplas origens autorizadas, preview/staging e pathnames | 12-MVP-SCOPE, 23-RUNTIME-PROTOCOL | Lista exata HTTPS em PILOT_OBSERVE: tests/pilot-observation.test.ts, PostgreSQL/Chromium local; pathnames e GS01 integral pendentes, docs/PILOT-OBSERVATION.md | PARCIAL |
| F03 | Instalação universal HTML/React/Vite/WordPress quando permitido | 12-MVP-SCOPE, 27-COMPATIBILITY-MATRIX | GS01, GS10 | PARCIAL |
| F04 | Bootstrap pequeno + Core Runtime | 23-RUNTIME-PROTOCOL | Carregamento e falha em Chromium, tests/gs02.test.ts, CI 41680979048; instalação limitada a laboratório | PARCIAL |
| F05 | Fallback independente com capacidades limitadas | 23-RUNTIME-PROTOCOL | GS09 parcial: fallback e canários em Chromium, tests/gs02.test.ts; CSP e outros navegadores pendentes | PARCIAL |
| F06 | HTML Canary e CSS Canary best-effort | 23-RUNTIME-PROTOCOL, 02- Observacoes Tecnicas | GS09 parcial em Chromium, tests/gs02.test.ts, CI 41688461172; CSP e outros navegadores pendentes | PARCIAL |
| F07 | Entrega de scripts, rotas públicas e alias persistido/versionado | 24-EDGE-DELIVERY-NETWORK, 02- Observacoes Tecnicas | GS01, GS10 | PARCIAL |
| F08 | Verificação de instalação e degradação FULL/PARTIAL/UNSUPPORTED | 27-COMPATIBILITY-MATRIX, 12-MVP-SCOPE | GS10: sinais nao autenticados em tests/installation.test.ts; verificacao controlada pendente | PARCIAL |
| F09 | Contexto autorizado vs. execução em host não autorizado | 23-RUNTIME-PROTOCOL | Origem alegada comparada no servidor, original e cópia em tests/gs02.test.ts, CI 41680979048; sinais forjáveis | PARCIAL |
| F10 | Contextos `file://`, iframe/sandbox quando possível, sem garantia | 23-RUNTIME-PROTOCOL | GS10 | P |
| F11 | Observações duráveis com fonte e timestamps | 21-EVENT-MODEL, 25-INCIDENT-EVIDENCE-MODEL | GS02, GS12 | PARCIAL |
| F12 | Incidente por host/projeto, lifecycle e falso positivo | 25-INCIDENT-EVIDENCE-MODEL | GS02, GS12 | PARCIAL |
| F13 | Avaliação probabilística do provável operador e sinal de confiança | 25-INCIDENT-EVIDENCE-MODEL, 01- Decisoes Tecnicas | GS05, GS12 | PARCIAL |
| F14 | Modo Invisível/Stealth de observação sem mitigação visível | 20-POLICY-ENGINE, 00- O anticlone | GS05 | PARCIAL |
| F15 | Captura de tráfego por PAID, ORGANIC, REFERRAL, DIRECT_UNKNOWN | 20-POLICY-ENGINE, 22-METRIC-DICTIONARY | Presença diária declarada em laboratório: tests/traffic.test.ts e tests/gs02.test.ts; GS04 pendente | PARCIAL |
| F16 | Dados de UTM/click-ID/referrer e atribuição com incerteza | 21-EVENT-MODEL, 22-METRIC-DICTIONARY | Sinais mínimos validados e fonte sem valores brutos: tests/traffic.test.ts e tests/gs02.test.ts; GS12 pendente | PARCIAL |
| F17 | Redirecionamento de página para destino aprovado | 20-POLICY-ENGINE, 23-RUNTIME-PROTOCOL | GS06 integrado em Chromium: destino aprovado e LOW controlado, CI 41691788658; LOW é configuração de laboratório, não classificador real | PARCIAL |
| F18 | Render gate limitado e fail-open em timeout | 23-RUNTIME-PROTOCOL, 28-PERFORMANCE-BUDGETS-BENCHMARKS | GS06: espera limitada e fail-open testados; página não é ocultada, render gate visual completo pendente | PARCIAL |
| F19 | Descoberta de vários CTAs/checkout/WhatsApp distintos | 26-CONVERSION-SURFACES-DRIFT, 00- O anticlone | Laboratorio: inventario passivo de elementos presentes, tests/cta-browser.test.ts e tests/cta-inventory.test.ts, CI 41726344521; GS03 integral pendente | PARCIAL |
| F20 | Mapeamento de CTA pirateado para destino correto aprovado | 26-CONVERSION-SURFACES-DRIFT | Laboratorio: associacao manual autenticada por projeto e oferta em tests/cta-inventory.test.ts, CI 41726344521; GS03 integral pendente | PARCIAL |
| F21 | Troca local de CTA sem chamada de rede no clique com regra pronta | 23-RUNTIME-PROTOCOL, 02- Observacoes Tecnicas | GS03 parcial: ancoras estaticas mapeadas em laboratorio, tests/f21.test.ts, CI 41730953550; GS03 integral e GS07 pendentes | PARCIAL |
| F22 | DOM dinâmico, SPA, links/formulários dentro da compatibilidade | 26-CONVERSION-SURFACES-DRIFT, 27-COMPATIBILITY-MATRIX | Laboratório: âncoras tardias e SPA no mesmo pathname em tests/f21.test.ts; GS07 e GS10 integrais pendentes | PARCIAL |
| F23 | Percentuais 0-100 em passos de 10 por classe e acao | 20-POLICY-ENGINE, 12-MVP-SCOPE | PAGE_REDIRECT em laboratorio: tests/allocation.test.ts e tests/gs06.test.ts; outras acoes e GS04 completo pendentes | PARCIAL |
| F24 | Bucketing estavel por sessao/regra/versao | 20-POLICY-ENGINE | Laboratorio: tests/allocation.test.ts e tests/gs06.test.ts; identidade manipulavel, GS04 completo pendente | PARCIAL |
| F25 | Mudança material de checkout e REVIEW_REQUIRED somente no ponto | 26-CONVERSION-SURFACES-DRIFT | Laboratório: drift por destino/colisão isolado ao ponto e reaprovação autenticada com auditoria em tests/cta-inventory.test.ts; regressão Chromium em tests/f21.test.ts; CI 41750058855 (6c56b70) e 41752363089 (4c6a848). GS08 laboratorial em tests/gs08.test.ts (CI 41903843908, revisao favoravel no PR #33); fixture ate 021 verifica intencao F27 SMTP_LOCAL sem trigger legado, gates do novo HEAD no PR; capacidade integral pendente | PARCIAL |
| F26 | Alerta de clone por host, deduplicação e histórico | 31-NOTIFICATIONS-EMAIL-TEMPLATES, 00- O anticlone | Laboratório: GS02 em tests/gs02.test.ts; hosts e reconexão em tests/detection.test.ts; orçamento, expiração e reconciliação em tests/notification-budget.test.ts, tests/notification-expiry.test.ts e tests/notification-intents.test.ts. GS13 demonstrado em laboratorio no PR #32 (CI 41899147841); entrega externa e capacidade integral pendentes | PARCIAL |
| F27 | Alerta de mudança de CTA, deduplicação e retry | 31-NOTIFICATIONS-EMAIL-TEMPLATES | Laboratório: tests/cta-inventory.test.ts, tests/cta-delivery.test.ts e tests/cta-local-smtp.test.ts; orçamento, expiração e reconciliação em tests/notification-budget.test.ts, tests/notification-expiry.test.ts e tests/notification-intents.test.ts; SIMULATED preservado. GS13 demonstrado em laboratorio no PR #32 (CI 41899147841); GS08 laboratorial em tests/gs08.test.ts (CI 41903843908, revisao favoravel no PR #33); fixture ate 021 verifica intencao F27 SMTP_LOCAL sem trigger legado, gates do novo HEAD no PR; entrega externa e capacidade integral pendentes | PARCIAL |
| F28 | Painel de incidentes, evidências, filtros e auditoria | 25-INCIDENT-EVIDENCE-MODEL, 45-PROJECT-WORKSPACE-UX | GS12 | PARCIAL |
| F29 | Métricas de sessões, ações, redirecionamentos e fontes reais | 22-METRIC-DICTIONARY | GS14 | P |
| F30 | Estimativa recuperada rotulada; conversão ≠ venda | 22-METRIC-DICTIONARY, 01- Decisoes Tecnicas | GS14 | P |
| F31 | Webhook mínimo de checkout com autenticação e idempotência | 33-INTEGRATIONS-WEBHOOKS-ADAPTIVE-MAPPING | GS14 | P |
| F32 | DNS/ASN/hosting externo separado do IP do visitante | 25-INCIDENT-EVIDENCE-MODEL, 16-SECURITY-PRINCIPLES | GS12 parcial: DNS autorizado, ASN/hosting indisponiveis | PARCIAL |
| F33 | Segurança do gateway: body, spoofing, rate, replay, validação | 16-SECURITY-PRINCIPLES, 02- Observacoes Tecnicas | tests/https-gateway.test.ts: headers, limites, corpo e falha upstream; GS11 integral (replay/queue/SSRF) pendente; gates no PR | PARCIAL |
| F34 | Admin único, login seguro, MFA, sessão e trilha de alterações | 18-AUTHENTICATION-AUTHORIZATION (simplificado) | GS16; senha, sessão e TOTP com prevenção de replay implementados e testados em laboratório: tests/admin-auth.test.ts e tests/admin-totp.test.ts; faltam trilha de auditoria e requisitos de produção | PARCIAL |
| F35 | Persistência PostgreSQL, fila/outbox e dedup a reinício | 12-MVP-SCOPE, 29-DATABASE-PERSISTENCE | GS02, GS13 | PARCIAL |
| F36 | Histórico preservado com projeto pausado/arquivado | 12-MVP-SCOPE, 34-PRIVACY-DATA-RETENTION | GS15 | P |
| F37 | Proteção de privacidade, minimização e retenção | 34-PRIVACY-DATA-RETENTION | GS15 | PARCIAL |
| F38 | Backups, recuperação e deploy/rollback verificados | 36-BACKUP-DISASTER-RECOVERY, 38-CI-CD-MIGRATIONS-RELEASE | Imagem/Compose e smoke HTTPS em tests/https-gateway.test.ts; backup/restore e rollback VPS de GS16 pendentes, sem deploy | PARCIAL |
| F39 | Testes navegador e performance reais, sem números inventados | 27-COMPATIBILITY-MATRIX, 28-PERFORMANCE-BUDGETS-BENCHMARKS | GS10, GS16 | PARCIAL |
| F40 | Um painel responsivo de projetos, proteção, conversões e incidentes | 12-MVP-SCOPE, 39-INFORMATION-ARCHITECTURE | GS16 | PARCIAL |
| F41 | Identidade de CTA por marcador estável ou correspondência estrutural com confiança; candidato novo ou incerto exige revisão antes de substituir | 26-CONVERSION-SURFACES-DRIFT §§3, 12, 23 | Laboratorio: marcador por superficie e sugestoes estruturais sem associacao automatica, tests/cta-inventory.test.ts, CI 41726344521; GS17 integral pendente | PARCIAL |
| F42 | Propagação configurável de atribuição por allowlist nos destinos de página e CTA, sem repasse arbitrário de parâmetros | 20-POLICY-ENGINE §13, 26-CONVERSION-SURFACES-DRIFT §17 | GS18 | P |
| F43 | Política publicada versionada e determinística: precedência de stealth/segurança, fases de entrada e interação e rejeição de conflitos ambíguos | 20-POLICY-ENGINE §§4, 8–9, 14, 18 | Laboratório: publicação autenticada, versões imutáveis e ativação transacional comprovadas em tests/policy-admin.test.ts, tests/protection-policy.test.ts e tests/gs06.test.ts; CI 41697907777. F43 e GS19 completos ainda dependem do motor geral de precedência, fases de interação e demais cenários; políticas legadas exigem republicação.; fases de entrada e interacao separadas e prazo CTA limitado conforme D09 em tests/cta-refresh.test.ts; validacao integral e classificador operacional pendentes. | PARCIAL |
| F44 | Correlacionar ausência do Core com sinais independentes ainda observados, registrando possível degradação ou adulteração sem tratá-la como certeza | 23-RUNTIME-PROTOCOL §14, 25-INCIDENT-EVIDENCE-MODEL §§2, 11.5 | GS20 | P |
| F45 | Alertas de instalação inativa quando habilitados e de falha operacional, com deduplicação, retry e histórico | Blueprint §2; 31-NOTIFICATIONS-EMAIL-TEMPLATES | GS21 | P |

### Rastreio da auditoria documental

- F01–F10: instalação e redundância — 12-MVP-SCOPE, 23-RUNTIME-PROTOCOL, 24-EDGE-DELIVERY-NETWORK e 02- Observacoes Tecnicas; degradação correlacionada acrescentada em F44.
- F11–F18: evidências, risco e política — 20-POLICY-ENGINE, 21-EVENT-MODEL, 25-INCIDENT-EVIDENCE-MODEL e 00- O anticlone; precedência esclarecida em F43 e D05–D06.
- F19–F27: conversões e alertas — 26-CONVERSION-SURFACES-DRIFT, 31-NOTIFICATIONS-EMAIL-TEMPLATES e 00- O anticlone; identidade, atribuição e saúde acrescentadas em F41, F42 e F45.
- F28–F40: evidências, métricas, segurança e operação — 22-METRIC-DICTIONARY, 25-INCIDENT-EVIDENCE-MODEL, 16-SECURITY-PRINCIPLES, 33-INTEGRATIONS-WEBHOOKS-ADAPTIVE-MAPPING, 34-PRIVACY-DATA-RETENTION e Blueprint. A comparação é temática, não uma revisão integral de cada especificação histórica.

## Quadro de conclusao A/B/C apos PR #41

Este quadro complementa as provas acima, sem mudar criterios. `Parcial` significa codigo demonstrado em laboratorio; `Integracao` significa componentes presentes sem fluxo operacional completo; `Ausente` significa que nao foi localizada implementacao suficiente do comportamento integral. Nenhuma linha e aceite de producao. A prova indicada e reproduzivel pelo teste existente; resultado do novo recorte HTTPS depende dos gates no SHA final do PR. GS01-GS21 continuam no contrato `TEST-SCENARIOS.md`.

| Funcao / entrega | Estado real e prova atual | Dependencia / criterio restante para conclusao |
|---|---|---|
| F01 · C | Parcial: projects.test.ts | Ciclo pausa/arquivo, varias paginas e GS16 operacional. |
| F02 · A | Parcial: pilot-observation.test.ts | Persistir origens/pathnames por instalacao e validar GS01 real. |
| F03 · A | Integracao: bootstrap HTML testado | HTML/React/Vite/WordPress controlados e GS10 por compatibilidade. |
| F04 · A | Parcial: gs02.test.ts | Publicacao versionada e instalacao fora do laboratorio. |
| F05 · A | Parcial: gs02.test.ts | GS09 completo, CSP e navegadores suportados. |
| F06 · A | Parcial: gs02.test.ts | Diagnostico best-effort de canarios e GS09/GS10 reais. |
| F07 · A | Parcial: server.ts, https-gateway.test.ts | Alias persistido/versionado e compatibilidade de revisoes. |
| F08 · A | Parcial: instalacao primaria e sinais nao autenticados em tests/installation.test.ts | Verificacao controlada, matriz completa de capacidades e GS10 integral pendentes. |
| F09 · A | Parcial: pilot-observation.test.ts | Corroboracao e contexto operacional, sem confiar no Origin. |
| F10 · A | Ausente: sem prova completa file/iframe | Matriz de transporte/sandbox com degradacao GS10. |
| F11 · A | Parcial: detection.test.ts/gs02.test.ts | Evidencias operacionais e GS12 completos. |
| F12 · A | Parcial: detection.test.ts | Lifecycle e falso positivo auditados no painel (GS12). |
| F13 · B | Parcial: risk.test.ts, somente UNCERTAIN operacional; consulta investigativa, degradacao opcional e avaliacao estruturada conservadora em tests/investigation.test.ts e tests/structured-risk.test.ts; sem classificador operacional de operador | Classificador versionado multissinal, validacao conservadora GS05/GS12. |
| F14 · B | Parcial: protection-policy.test.ts | Precedencia operacional de Stealth com classificador e GS05/GS19 completos. |
| F15 · B | Parcial: traffic.test.ts | Sessao e fatos reais para GS04/GS14. |
| F16 · B | Parcial: traffic.test.ts | Atribuicao revisavel, incerteza e GS12 completos. |
| F17 · B | Parcial: gs06.test.ts, loopback | Destinos externos aprovados, classificador e GS06 operacional. |
| F18 · B | Parcial: gs06.test.ts | Gate visual e medidas de timeout/performance GS06/GS10. |
| F19 · B | Parcial: cta-browser.test.ts | Identidade confiavel e ofertas dinamicas sem marcador, GS03/GS17. |
| F20 · B | Parcial: cta-inventory.test.ts | Aprovacao de destinos externos por oferta e GS03 integral. |
| F21 · B | Parcial: f21.test.ts/cta-refresh.test.ts | Risco e destinos operacionais; sem rede no clique, GS03/GS07. |
| F22 · B | Parcial: f21.test.ts; formularios suspensos D07 | Superficies dinamicas e matriz GS07/GS10; respeitar D07. |
| F23 · B | Parcial: allocation.test.ts | Todas as acoes/classes integradas e GS04 completo. |
| F24 · B | Parcial: allocation.test.ts | Versao/sessao operacionais e GS04 com incerteza documentada. |
| F25 · B | Parcial: cta-commercial.test.ts/gs08.test.ts | Offer Snapshot, associacao contextual segura e GS08 externo. Prototipo reprovado BLOCKED. |
| F26 · A | Parcial: detection.test.ts, notification-*.test.ts | SMTP externo aprovado, historico operacional e GS13 externo. |
| F27 · B | Parcial: cta-local-smtp.test.ts/gs08.test.ts | Provedor externo e GS13 operacional, sem exactly-once prometido. |
| F28 · A | Integracao: admin-ui.ts e consultas locais | Evidencias, filtros, lifecycle e auditoria completos (GS12). |
| F29 · C | Ausente: agregados parciais nao sao metricas completas | Fatos de sessao/acao/handoff e GS14. |
| F30 · C | Ausente: sem receita operacional | Preco confirmado/snapshot, estimativa rotulada e GS14. |
| F31 · C | Ausente: webhook de vendas | Integracao escolhida, assinatura/idempotencia e GS14. |
| F32 · A | Parcial: DNS autorizado e historico em tests/infrastructure-dns.test.ts; ASN/hosting NOT_AVAILABLE | Fonte confiavel de ASN/hosting, TTL verificavel e GS12 integral pendentes. |
| F33 · C | Parcial: https-gateway.test.ts + limites existentes | Proxy/TLS integrado neste PR; replay/queue/SSRF e GS11 integral pendentes. |
| F34 · C | Parcial: admin-auth.test.ts/admin-totp.test.ts | Administracao de producao, auditoria e GS16. |
| F35 · C | Parcial: detection.test.ts/notification-intents.test.ts | Worker/Redis conforme D03 ainda proposto; reinicios operacionais GS02/GS13. |
| F36 · C | Ausente: ciclo completo pausa/arquivo | Preservar historico/agregados e GS15. |
| F37 · C | Parcial: cleanup/expiracao e notification-expiry.test.ts | Politica integral de dados e GS15, incluindo logs/backup. |
| F38 · C | Integracao: Compose/imagem/smoke deste PR | Restore ensaiado, upgrade versionado e rollback real na VPS (GS16). |
| F39 · C | Parcial: suites Chromium e mobile laboratoriais | Navegadores/medidas reais p95/p99 e GS10/GS16. |
| F40 · C | Parcial: admin-ui.ts e testes de UI locais | Painel React/Vite responsivo completo e GS16. |
| F41 · B | Parcial: cta-inventory.test.ts | Identidade estrutural segura, multiplas ofertas, GS17 integral. |
| F42 · B | Ausente: propagacao configuravel | Allowlist por destino, parametros adversariais e GS18. |
| F43 · B | Parcial: policy-admin.test.ts | Precedencia geral/entrada/interacao e conflitos, GS19 integral. |
| F44 · A | Parcial: correlacao laboratorial de Core com fallback e canarios HTML/CSS; sinais sao alegacoes nao autenticadas. | GS20 integral pendente: perdas antes do gateway, inclusive no proxy, nao sao observaveis. |
| F45 · A | Ausente: inatividade/falha rastreavel | Instalacoes persistidas, dedup/retry/historico e GS21. |

Caminho critico: publicacao HTTPS observavel -> risco/Stealth -> destinos externos de pagina/CTA -> identidade e superficies -> confirmacao manual de preco por CTA/Offer Snapshot versionado -> associacao contextual segura -> drift/revisao -> atribuicao/metricas/vendas -> seguranca/painel/retencao/restore e aceitacao final. SMTP externo, diagnostico de instalacao e enriquecimento de A devem acompanhar suas dependencias sem considerar a primeira instalacao como encerramento. Preparacao de publicacao nao autoriza DNS/deploy nem conclui A/B/C.

## Fora do Personal (por decisão de produto, não por perda de função de proteção)

Tenants/organizações comerciais, memberships de clientes, checkout de assinatura, planos e entitlements, gestão de clientes, broadcast, MRR/ARR, hub, duas apps independentes, pool comercial multi-domínio, plugins de milhares de plataformas, instalações customer-owned SaaS.

## Auditoria inicial obrigatória — uma vez, com esforço limitado

1. Ler `docs/SOURCES.md` e, se acessíveis, somente os 10–12 documentos temáticos centrais do RAR. Conferir funções e casos de borda contra F01–F40.
2. Para cada lacuna operacional real, adicionar **uma linha F41+** com fonte e prova; para dúvida/contradição, registrar em `docs/DECISIONS.md`.
3. Marcar explicitamente cobertura documental como `AUDITADA` apenas quando comparada; **não** marcar itens `V` sem teste de implementação.
4. Não importar os modelos de tenancy ou o grafo M00–M11. A auditoria não deve virar reconstrução do SaaS.

GS03 laboratorial recorte A demonstrado: `tests/gs03.test.ts`, CI 41911761424 em 6756c37, PostgreSQL/Chromium. F19/F20/F21 continuam PARCIAL; oferta sem marcador e destinos externos reais pendentes, conforme `docs/CTA-INVENTORY-LAB.md`. Nao equivale a protecao operacional nem conclui GS17.

Interpretador comercial isolado (recorte F25/F41): `tests/commercial-interpreter.test.ts` demonstra parsing monetario exato e significado limitado em Chromium localhost; sem associacao, persistencia ou integracao de protecao. Limites em `docs/COMMERCIAL-INTERPRETER-LAB.md`. Nao conclui F25/F41 nem GS17; prototipo contextual anterior permanece BLOCKED. Revisao e CI do SHA final no PR.
