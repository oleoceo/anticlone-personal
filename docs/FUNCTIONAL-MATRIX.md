# Matriz de Cobertura Funcional — AntiClone Personal

**Estado:** cobertura documental F01–F40 **AUDITADA** nas fontes temáticas consultadas; F41–F45 registram lacunas. Não é código implementado nem prova de comportamento; a auditoria não garante exaustividade.

Legenda: **P** = planejada no Personal; **PARCIAL** = parte comprovada, capacidade incompleta; **V** = validada por teste; **B** = bloqueada com explicação. Inicialmente tudo está `P`. Cada `Fxx` só vira `V` depois de evidência de teste, não por texto ou interface.

| ID | Capacidade operacional preservada | Fonte SaaS (arquivo ou texto) | Prova mínima / cenário | Sit. |
|---|---|---|---|---|
| F01 | Vários projetos próprios e identidade estável independente da URL | 12-MVP-SCOPE, 14-DOMAIN-MODEL | GS16, GS01; cadastro e isolamento local em tests/projects.test.ts, CI 41677878620 | PARCIAL |
| F02 | Múltiplas origens autorizadas, preview/staging e pathnames | 12-MVP-SCOPE, 23-RUNTIME-PROTOCOL | GS01 | P |
| F03 | Instalação universal HTML/React/Vite/WordPress quando permitido | 12-MVP-SCOPE, 27-COMPATIBILITY-MATRIX | GS01, GS10 | P |
| F04 | Bootstrap pequeno + Core Runtime | 23-RUNTIME-PROTOCOL | Carregamento e falha em Chromium, tests/gs02.test.ts, CI 41680979048; instalação limitada a laboratório | PARCIAL |
| F05 | Fallback independente com capacidades limitadas | 23-RUNTIME-PROTOCOL | GS09; observacao em laboratorio, canarios pendentes | PARCIAL |
| F06 | HTML Canary e CSS Canary best-effort | 23-RUNTIME-PROTOCOL, 02- Observacoes Tecnicas | GS09, GS10 | P |
| F07 | Entrega de scripts, rotas públicas e alias persistido/versionado | 24-EDGE-DELIVERY-NETWORK, 02- Observacoes Tecnicas | GS01, GS10 | P |
| F08 | Verificação de instalação e degradação FULL/PARTIAL/UNSUPPORTED | 27-COMPATIBILITY-MATRIX, 12-MVP-SCOPE | GS10 | P |
| F09 | Contexto autorizado vs. execução em host não autorizado | 23-RUNTIME-PROTOCOL | Origem alegada comparada no servidor, original e cópia em tests/gs02.test.ts, CI 41680979048; sinais forjáveis | PARCIAL |
| F10 | Contextos `file://`, iframe/sandbox quando possível, sem garantia | 23-RUNTIME-PROTOCOL | GS10 | P |
| F11 | Observações duráveis com fonte e timestamps | 21-EVENT-MODEL, 25-INCIDENT-EVIDENCE-MODEL | GS02, GS12 | P |
| F12 | Incidente por host/projeto, lifecycle e falso positivo | 25-INCIDENT-EVIDENCE-MODEL | GS02, GS12 | P |
| F13 | Avaliação probabilística do provável operador e sinal de confiança | 25-INCIDENT-EVIDENCE-MODEL, 01- Decisoes Tecnicas | GS05, GS12 | P |
| F14 | Modo Invisível/Stealth de observação sem mitigação visível | 20-POLICY-ENGINE, 00- O anticlone | GS05 | P |
| F15 | Captura de tráfego por PAID, ORGANIC, REFERRAL, DIRECT_UNKNOWN | 20-POLICY-ENGINE, 22-METRIC-DICTIONARY | GS04, GS12 | P |
| F16 | Dados de UTM/click-ID/referrer e atribuição com incerteza | 21-EVENT-MODEL, 22-METRIC-DICTIONARY | GS12 | P |
| F17 | Redirecionamento de página para destino aprovado | 20-POLICY-ENGINE, 23-RUNTIME-PROTOCOL | GS06 | P |
| F18 | Render gate limitado e fail-open em timeout | 23-RUNTIME-PROTOCOL, 28-PERFORMANCE-BUDGETS-BENCHMARKS | GS06, GS10 | P |
| F19 | Descoberta de vários CTAs/checkout/WhatsApp distintos | 26-CONVERSION-SURFACES-DRIFT, 00- O anticlone | GS03 | P |
| F20 | Mapeamento de CTA pirateado para destino correto aprovado | 26-CONVERSION-SURFACES-DRIFT | GS03 | P |
| F21 | Troca local de CTA sem chamada de rede no clique com regra pronta | 23-RUNTIME-PROTOCOL, 02- Observacoes Tecnicas | GS03, GS07 | P |
| F22 | DOM dinâmico, SPA, links/formulários dentro da compatibilidade | 26-CONVERSION-SURFACES-DRIFT, 27-COMPATIBILITY-MATRIX | GS07, GS10 | P |
| F23 | Percentuais 0–100 em passos de 10 por classe e ação | 20-POLICY-ENGINE, 12-MVP-SCOPE | GS04 | P |
| F24 | Bucketing estável por sessão/regra/versão | 20-POLICY-ENGINE | GS04 | P |
| F25 | Mudança material de checkout e REVIEW_REQUIRED somente no ponto | 26-CONVERSION-SURFACES-DRIFT | GS08 | P |
| F26 | Alerta de clone por host, deduplicação e histórico | 31-NOTIFICATIONS-EMAIL-TEMPLATES, 00- O anticlone | GS02, GS13 | P |
| F27 | Alerta de mudança de CTA, deduplicação e retry | 31-NOTIFICATIONS-EMAIL-TEMPLATES | GS08, GS13 | P |
| F28 | Painel de incidentes, evidências, filtros e auditoria | 25-INCIDENT-EVIDENCE-MODEL, 45-PROJECT-WORKSPACE-UX | GS12 | P |
| F29 | Métricas de sessões, ações, redirecionamentos e fontes reais | 22-METRIC-DICTIONARY | GS14 | P |
| F30 | Estimativa recuperada rotulada; conversão ≠ venda | 22-METRIC-DICTIONARY, 01- Decisoes Tecnicas | GS14 | P |
| F31 | Webhook mínimo de checkout com autenticação e idempotência | 33-INTEGRATIONS-WEBHOOKS-ADAPTIVE-MAPPING | GS14 | P |
| F32 | DNS/ASN/hosting externo separado do IP do visitante | 25-INCIDENT-EVIDENCE-MODEL, 16-SECURITY-PRINCIPLES | GS12 | P |
| F33 | Segurança do gateway: body, spoofing, rate, replay, validação | 16-SECURITY-PRINCIPLES, 02- Observacoes Tecnicas | GS11 | P |
| F34 | Admin único, login seguro, MFA, sessão e trilha de alterações | 18-AUTHENTICATION-AUTHORIZATION (simplificado) | GS16; senha, sessão e TOTP com prevenção de replay implementados e testados em laboratório: tests/admin-auth.test.ts e tests/admin-totp.test.ts; faltam trilha de auditoria e requisitos de produção | PARCIAL |
| F35 | Persistência PostgreSQL, fila/outbox e dedup a reinício | 12-MVP-SCOPE, 29-DATABASE-PERSISTENCE | GS02, GS13 | P |
| F36 | Histórico preservado com projeto pausado/arquivado | 12-MVP-SCOPE, 34-PRIVACY-DATA-RETENTION | GS15 | P |
| F37 | Proteção de privacidade, minimização e retenção | 34-PRIVACY-DATA-RETENTION | GS15 | P |
| F38 | Backups, recuperação e deploy/rollback verificados | 36-BACKUP-DISASTER-RECOVERY, 38-CI-CD-MIGRATIONS-RELEASE | GS16 | P |
| F39 | Testes navegador e performance reais, sem números inventados | 27-COMPATIBILITY-MATRIX, 28-PERFORMANCE-BUDGETS-BENCHMARKS | GS10, GS16 | P |
| F40 | Um painel responsivo de projetos, proteção, conversões e incidentes | 12-MVP-SCOPE, 39-INFORMATION-ARCHITECTURE | GS16 | P |
| F41 | Identidade de CTA por marcador estável ou correspondência estrutural com confiança; candidato novo ou incerto exige revisão antes de substituir | 26-CONVERSION-SURFACES-DRIFT §§3, 12, 23 | GS17 | P |
| F42 | Propagação configurável de atribuição por allowlist nos destinos de página e CTA, sem repasse arbitrário de parâmetros | 20-POLICY-ENGINE §13, 26-CONVERSION-SURFACES-DRIFT §17 | GS18 | P |
| F43 | Política publicada versionada e determinística: precedência de stealth/segurança, fases de entrada e interação e rejeição de conflitos ambíguos | 20-POLICY-ENGINE §§4, 8–9, 14, 18 | GS19 | P |
| F44 | Correlacionar ausência do Core com sinais independentes ainda observados, registrando possível degradação ou adulteração sem tratá-la como certeza | 23-RUNTIME-PROTOCOL §14, 25-INCIDENT-EVIDENCE-MODEL §§2, 11.5 | GS20 | P |
| F45 | Alertas de instalação inativa quando habilitados e de falha operacional, com deduplicação, retry e histórico | Blueprint §2; 31-NOTIFICATIONS-EMAIL-TEMPLATES | GS21 | P |

### Rastreio da auditoria documental

- F01–F10: instalação e redundância — 12-MVP-SCOPE, 23-RUNTIME-PROTOCOL, 24-EDGE-DELIVERY-NETWORK e 02- Observacoes Tecnicas; degradação correlacionada acrescentada em F44.
- F11–F18: evidências, risco e política — 20-POLICY-ENGINE, 21-EVENT-MODEL, 25-INCIDENT-EVIDENCE-MODEL e 00- O anticlone; precedência esclarecida em F43 e D05–D06.
- F19–F27: conversões e alertas — 26-CONVERSION-SURFACES-DRIFT, 31-NOTIFICATIONS-EMAIL-TEMPLATES e 00- O anticlone; identidade, atribuição e saúde acrescentadas em F41, F42 e F45.
- F28–F40: evidências, métricas, segurança e operação — 22-METRIC-DICTIONARY, 25-INCIDENT-EVIDENCE-MODEL, 16-SECURITY-PRINCIPLES, 33-INTEGRATIONS-WEBHOOKS-ADAPTIVE-MAPPING, 34-PRIVACY-DATA-RETENTION e Blueprint. A comparação é temática, não uma revisão integral de cada especificação histórica.

## Fora do Personal (por decisão de produto, não por perda de função de proteção)

Tenants/organizações comerciais, memberships de clientes, checkout de assinatura, planos e entitlements, gestão de clientes, broadcast, MRR/ARR, hub, duas apps independentes, pool comercial multi-domínio, plugins de milhares de plataformas, instalações customer-owned SaaS.

## Auditoria inicial obrigatória — uma vez, com esforço limitado

1. Ler `docs/SOURCES.md` e, se acessíveis, somente os 10–12 documentos temáticos centrais do RAR. Conferir funções e casos de borda contra F01–F40.
2. Para cada lacuna operacional real, adicionar **uma linha F41+** com fonte e prova; para dúvida/contradição, registrar em `docs/DECISIONS.md`.
3. Marcar explicitamente cobertura documental como `AUDITADA` apenas quando comparada; **não** marcar itens `V` sem teste de implementação.
4. Não importar os modelos de tenancy ou o grafo M00–M11. A auditoria não deve virar reconstrução do SaaS.
