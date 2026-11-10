# Testes de aceitação — Golden Scenarios

Todos usam **ambientes, cópias simuladas e domínios autorizados** sob controle do proprietário. Sem atacar páginas alheias. Cada GS só passa com teste reproduzível e evidência (comando/log/resultado e versão).

| ID | Verificação operacional |
|---|---|
| GS01 | Site original: comportamento preservado, contexto autorizado, instalação saudável. |
| GS02 | Cópia simulada em hostname diferente: observação + incidente único + e-mail único após múltiplas visitas e reinício. |
| GS03 | Multiplos CTAs e ofertas variaveis: cada ponto selecionado segue exclusivamente ao destino aprovado. Nomes comerciais e canais sao exemplos. |
| GS04 | 0/50/100% e classes por ação: bucketing estável por sessão; distribuição estatística em conjunto grande. |
| GS05 | Stealth v2 OFF ignora risco; ON suprime operador com evidência forte e conserva política para UNCERTAIN. Legado preservado até republicação/reaprovação. Laboratório em tests/optional-stealth.test.ts; classificação operacional continua indisponível. |
| GS06 | Page Redirect com destino aprovado; timeout de decisão libera navegação e não prende tela. |
| GS07 | CTAs criados tardiamente, SPA, formulários e popups suportados conforme matriz de compatibilidade. |
| GS08 | Drift material do checkout gera revisão/alerta e não desabilita outros mapeamentos válidos. |
| GS09 | Core removido/bloqueado: fallback e canários dão somente as capacidades documentadas. |
| GS10 | CSP, bloqueadores, iframe, offline e mobile: degradar sem quebrar original; medir performance. |
| GS11 | Payload oversized, spoofing/replay, flood, SSRF, injeção de URL; sem confiança em dados client-side. |
| GS12 | Incident/evidence conservam fonte, host, tempos, tráfego, DNS/ASN e incerteza, com correlação revisável. |
| GS13 | Dedup e retry de e-mails; falha de provedor não desfaz incidente; mudança de host gera novo evento. |
| GS14 | Cliques/handoffs não são vendas; receita estimada distinta de webhook de venda verificada; webhook duplicado idempotente. |
| GS15 | Pausa, arquivamento e retenção: histórico mantido corretamente e dados sensíveis expiram. |
| GS16 | Dois projetos isolados logicamente, login/MFA, backup restaurável e deploy/rollback com smoke test. |
| GS17 | Dois CTAs com texto igual permanecem distintos; alteração de texto preserva identidade válida; candidato novo ou de baixa confiança não é substituído automaticamente. |
| GS18 | Em redirecionamento de página e CTA, somente parâmetros de atribuição configurados e permitidos chegam ao destino; parâmetros arbitrários não são repassados. |
| GS19 | Stealth v2 explícito e independente em PAGE_REDIRECT/REPLACE_CONVERSION; OFF com PAID 100% e DIRECT_UNKNOWN 0% independe de risco. ON suprime evidência forte, UNCERTAIN mantém política. Segurança, fases, versões, aprovação, isolamento e fail-open preservados; configurações ambíguas rejeitadas. tests/optional-stealth.test.ts em laboratório; GS19 integral permanece parcial. |
| GS20 | Em cópia autorizada, Core interrompido enquanto fallback ou canário ainda envia sinal produz registro de possível degradação com fonte e horário; ausência de todos os sinais permanece desconhecida. |
| GS21 | Com alerta de inatividade habilitado, ausência de sinais além do prazo configurado e falha operacional geram alertas rastreáveis, com deduplicação, retry e histórico; retomada e nova falha são registradas. |

GS16, recorte PostgreSQL: `tests/recovery.test.ts` usa migrations 001–032 (e futuras presentes), dados sintéticos de dois projetos, snapshot pg_dump e restore transacional em banco isolado vazio. Confere SHA-256 do archive, conteúdo de todas as tabelas, auditoria, políticas, configuração/outbox, sequência, replay TOTP após reinício, consulta admin autenticada, Chromium e dois reinícios de cada processo gateway PILOT_OBSERVE/admin. Recusa origem, confirmação incorreta, destino com objetos/conexões e corrupção. Offsite, arquivos operacionais e rollback VPS continuam pendentes; operação em `POSTGRES-RECOVERY.md`; CI e revisão do SHA final no PR. Não conclui GS16 integral.

É proibido substituir teste real por mock no lugar de teste de integração/E2E exigido. Mocks são permitidos somente em camadas unitárias apropriadas.

GS01/GS03/GS04/GS06/GS08/GS11/GS16/GS19, recorte laboratorial da Frente B: `tests/protection-admin-ui.test.ts` integra painel autenticado, PostgreSQL 001–032 e Chromium; 0/50/100 e quatro classes declaradas para cada ação, percentuais independentes, duas ofertas, checkout HTTPS sintético local com hostname separado, clique sem rede de decisão, drift isolado/reaprovação auditada, projeto separado e rejeição CSRF. As visitas PAGE_REDIRECT usam relógio Chromium controlado para selecionar o bucket; o prazo/fail-open real e D08/D09 continuam exercitados em GS06/refresh existentes. Destinos externos exigem aprovação exata por ambiente. Não comprova operação em domínios reais, venda ou classificação operacional.

GS01/GS02/GS13/GS16, transporte configurável F26: `tests/smtp-provider.test.ts` usa PostgreSQL, Chromium e SMTP local com TLS implícito e STARTTLS. Demonstra original preservado, cópia observada, incidente/mensagem únicos no cenário, falha de autenticação persistida, retry após reinício, consulta autenticada e isolamento de projetos. Rejeita certificado não confiável, destinatário ambíguo e configuração divergente; SMTP lento termina no prazo total de 10s. Sem conta externa ou comprovação de entrega na caixa postal. Configuração e limites em `CLONE-SMTP.md`; revisão e CI no SHA final do PR.
GS14 parcial: `tests/checkout-webhook.test.ts` usa PostgreSQL real, HTTP e Chromium
para autenticação HMAC, reenvios concorrentes/reinício, conflito de evento/venda,
isolamento de projetos e consulta administrativa com CSRF. Eventos são sintéticos;
receita atribuída, estimativa e ações ausentes não são inventadas. A CI HTTPS
também exercita o contrato genérico através do Nginx. Adaptador externo pendente.

GS01/GS11/GS16, recorte de preparacao HTTPS: `tests/https-gateway.test.ts` testa fronteira de headers e orcamento limitado; com HTTPS_GATE_TEST=1 na CI Linux, usa Nginx TLS real, PostgreSQL e Chromium para carregar runtime, persistir incidente de copia controlada, preservar OBSERVE_ONLY/clique nativo, rejeitar spoofing de autoridade, corpo excessivo e flood, e manter navegacao durante falha upstream. Certificado sintetico local nao comprova TLS/DNS da VPS. Imagem Docker e construida na CI; sem deploy. Runbook em `HTTPS-OBSERVE-RUNBOOK.md`. Recorte parcial: nao conclui replay, SSRF, diagnostico universal, backup/restore ou GS01/GS11/GS16 integrais. Gates do SHA final no PR.

GS02 em laboratório: `tests/gs02.test.ts` cobre visitas repetidas, falha SMTP local, retry e reinícios com um incidente e uma mensagem no cenário controlado. GS13 em laboratório: `tests/detection.test.ts` cobre dois hosts, deduplicação independente e reconexão; `tests/notification-intents.test.ts`, `tests/notification-budget.test.ts` e `tests/notification-expiry.test.ts` cobrem reconciliação, orçamento e expiração. A fronteira F26 de 24h entre SELECT e UPDATE é revalidada no SQL, mas não reproduzida exatamente no teste. Aceitação SMTP incerta pode resultar em duplicatas; não há garantia exactly-once. GS13 foi demonstrado em laboratorio no PR #32 integrado (CI 41899147841); F26/F27 integrais e entrega externa permanecem pendentes.

GS08 em laboratorio: `tests/gs08.test.ts` integra PostgreSQL e Chromium para drift de URL observada, alerta deduplicado, continuidade de outro CTA e reaprovacao autenticada com auditoria. Historicamente a decisao era carregada na entrada; o PR #38 acrescentou renovacao limitada em abas abertas, conforme CTA-INVENTORY-LAB.md. CI 41903843908 aprovada (38 testes) e revisao independente favoravel no PR #33. A fixture atualizada ate 021 verifica exatamente uma intencao F27 SMTP_LOCAL sem trigger legado; CI e revisao do novo HEAD registradas no PR.

GS03 laboratorial, recorte A demonstrado: `tests/gs03.test.ts`, CI 41911761424 em 6756c37 (39 testes, PostgreSQL/Chromium) e revisao independente `/root/gs03_review` sem achados remanescentes. Recorte e lacunas B/C em `docs/CTA-INVENTORY-LAB.md`. Oferta sem marcador, destinos externos reais e GS17 integral pendentes; gates do HEAD final no PR #34.

PR #36 / F21 temporal: GS08 sem relogio virtual retarda resposta REPLACE_CONVERSION em mais de 150 ms, aguarda processamento antes do clique e exige checkout aprovado apenas no CTA elegivel, preservando o ponto sob revisao. PAGE_REDIRECT mantem prazo de entrada (GS06: resposta valida retida 250 ms, pagina e link nativos). Negativos GS08: percentual zero, regra desabilitada, risco UNCERTAIN no servidor; resposta invalida, pagehide e transicoes de pathname/query (inclusive ida e volta) no browser. Naquele PR nao havia renovacao em abas abertas; o PR #38 acrescentou renovacao limitada. Selecao e risco permanecem laboratoriais e probabilisticos. Gates do HEAD final no PR.

Estados: IMPLEMENTADO E TESTADO — renovação laboratorial de CTA no PR #38; IMPLEMENTADO PARCIALMENTE — GS03/GS08 laboratoriais; REDUZIDO POR DECISÃO DOCUMENTADA — formulários (D07); PENDENTE — reconhecimento comercial hostil e checkout externo; BLOQUEADO — nenhum bloqueio geral estabelecido.

D05 atualizada em 2026-11-09 supera a expectativa inicial de GS05/GS19 para novas versões explícitas; referências a UNCERTAIN nos relatos históricos continuam descrevendo a semântica legada testada naquele momento.

Correção PR #64: operational-authorization.test.ts acrescenta HTTPS sintético não-loopback com PostgreSQL/Chromium e Nginx quando HTTPS_GATE_TEST=1. Sem SCOPED_LAB_RISK/ORIGIN; dois projetos/três LPs, autorização, suspensão/reautorização, concorrência, geração, lifecycle, instalação inválida e destino divergente. Suítes anteriores mantêm classes/percentuais, tempos/refresh, D05–D15, métricas, SMTP e recuperação.

runtime-distribution.test.ts cobre rotação na mesma origem, histórico estável, revisões anteriores, recursos neutros v2, papéis, camadas e duas LPs no mesmo hostname/pathnames distintos. Headers ausentes/forjados e snippets copiados não certificam execução. verify com loopback/metadata/não autorizados é recusado; diagnóstico NOT_VERIFIED/UNKNOWN. GS10/F08 integral BLOCKED até isolamento deny-by-default comprovado; não há navegador de verificação no backend.
