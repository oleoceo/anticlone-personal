# Testes de aceitação — Golden Scenarios

Todos usam **ambientes, cópias simuladas e domínios autorizados** sob controle do proprietário. Sem atacar páginas alheias. Cada GS só passa com teste reproduzível e evidência (comando/log/resultado e versão).

| ID | Verificação operacional |
|---|---|
| GS01 | Site original: comportamento preservado, contexto autorizado, instalação saudável. |
| GS02 | Cópia simulada em hostname diferente: observação + incidente único + e-mail único após múltiplas visitas e reinício. |
| GS03 | Planos Básico e Premium e WhatsApp: CTA selecionado mapeia exclusivamente ao destino certo. |
| GS04 | 0/50/100% e classes por ação: bucketing estável por sessão; distribuição estatística em conjunto grande. |
| GS05 | Stealth: provável operador/risco incerto em observe-only, sem fingir identidade certa. |
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
| GS19 | Com stealth ativo e risco alto ou incerto, a mitigação visível é suprimida mesmo com atribuição paga; entrada e interação usam suas fases, versões publicadas são imutáveis e conflito ambíguo impede publicação. |
| GS20 | Em cópia autorizada, Core interrompido enquanto fallback ou canário ainda envia sinal produz registro de possível degradação com fonte e horário; ausência de todos os sinais permanece desconhecida. |
| GS21 | Com alerta de inatividade habilitado, ausência de sinais além do prazo configurado e falha operacional geram alertas rastreáveis, com deduplicação, retry e histórico; retomada e nova falha são registradas. |

É proibido substituir teste real por mock no lugar de teste de integração/E2E exigido. Mocks são permitidos somente em camadas unitárias apropriadas.
