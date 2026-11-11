# Frente 3 — fechamento funcional em laboratório

Base obrigatória: `f95e9da0fea5de203bab092fa39a8047bc4404be` (#66/#67). Uma branch e um PR; nenhuma operação de produção. Acompanhamento/classificações exclusivamente em [FUNCTIONAL-MATRIX.md](FUNCTIONAL-MATRIX.md).

## Implementação

- Cadastro de projeto disponível no painel e na API autenticada pela mesma transação. Migration 059 registra criação, origem normalizada, horário do servidor e administrador autenticado, sem token/MFA/IP. Falha da auditoria reverte cadastro. Não há backfill de eventos antigos.
- Migration 060 registra INSERT/UPDATE/DELETE das 27 relações operacionais enumeradas nela: projeto/LP/URLs, políticas, destinos/mapeamentos/referências comerciais, configurações, autorização e backlog. Metadados incluem relação, colunas alteradas, referências e transação; valores arbitrários, credenciais e payloads não são copiados. `DATABASE_CONFIGURATION_WRITE` não identifica pessoa. Auditorias específicas e versões imutáveis continuam sendo a fonte de valores/justificativas.
- Consulta privada de cadastro/alterações, navegação por seções, filtros de domínio/estado nos incidentes retornados e CSS na mesma origem compatível com CSP. Filtros são locais ao conjunto limitado da investigação, sem promessa de busca histórica ilimitada. Desktop 1440×1000 e mobile 390×844.
- Metadados 060 expiram após 90 dias e são limitados a 10.000 por projeto/escopo global durante a manutenção; registro de cadastro é configuração durável. Retenção de dados anteriores não mudou. Backup não é apagado pela limpeza do banco.
- `upgradeLaboratory` oferece ledger/checksum, exclusão mútua e aplicação transacional de cada migration. Recusa bancos fora dos nomes descartáveis de ensaio. Não é procedimento de adoção de ledger/migração de produção. O histórico contém 57 arquivos até 058, não 58 migrations.
- Bundle operacional por allowlist, checksum e SHA do código: não serializa ambiente completo nem credenciais. Rejeita chaves extras, URL com credenciais, valores inválidos e corrupção. Banco, código e arquivos do repositório são recuperados separadamente; segredos e TLS exigem recuperação privada própria.
- Webhook genérico agora recusa chave hexadecimal de comprimento ímpar, evitando truncamento silencioso. HMAC autentica o remetente configurado; não comprova venda recuperada ou atribuição à proteção.
- React/ReactDOM/Vite foram adicionados somente como dependências de desenvolvimento para uma fixture real compilada. WordPress/MariaDB são containers descartáveis do teste. O painel existente não foi convertido silenciosamente para React.

## Reprodução e evidências

No Windows/WSL deste laboratório:

```powershell
wsl -d Ubuntu -- bash scripts/front3-lab.sh focused
wsl -d Ubuntu -- bash scripts/front3-lab.sh
```

O primeiro comando é diagnóstico focado, não CI completa. O segundo reproduz o workflow com Node 22, PostgreSQL 16 descartável, Chromium, Nginx/TLS, imagens Docker e Compose, lint/typecheck/build e todas as suítes. Exportações são cópias controladas no `/tmp` do laboratório existente, não worktrees. Nenhum banco existente é reaproveitado pelo runner. Artefatos sanitizados ficam em `test-results/front3/<UTC>/`; a CI oficial do SHA final é vinculada no PR.

| Prova prática | Implementação/teste |
|---|---|
| HTML, CSP, canais individualmente bloqueados, ausência completa | `front3-compatibility`; recebimentos consultados no PostgreSQL, separados de pedidos bloqueados |
| React/Vite real, CSP, SPA e link dinâmico | Fixture compilada pelo Vite; Core/Fallback, dois canários e incidente persistidos |
| WordPress real | `front3-wordpress`: instalação real, mu-plugin via hook de footer, CSP permissiva explícita no original e na cópia, original preservado, HTML copiado em host distinto observado |
| iframe/sandbox/file/offline | `front3-compatibility`: snapshot de fontes/host/incidente por contexto, sem host inventado para origem opaca |
| Duas ofertas de valores distintos, checkout/WhatsApp sintético, popup/sticky/modal/dinâmico | `multiple-cta-surfaces`: BRL 6700/9700 em unidades mínimas, captura, aprovação manual, destinos distintos, texto alterado sem perder marcador, drift isolado, SPA e clique sem decisão de rede |
| UNCERTAIN, PAGE_REDIRECT e REPLACE_CONVERSION, autorizações | `operational-authorization`, `optional-stealth`, `scoped-gateway`: gateway real via Nginx/TLS, destinos HTTPS sintéticos, aprovação e D05/D09/D15 |
| Classes e percentuais independentes | `protection-admin-ui`, `allocation`: quatro classes declaradas, percentuais por ação; sem autenticar origem de tráfego |
| Admin desktop/mobile, CSRF e rollback de cadastro | `front3-admin`; screenshots sintéticos nos artefatos; regressões de triagem/SMTP usam seletor específico de projeto |
| Upgrade/restore/rollback | `front3-upgrade`: baseline até 058 → 059/060; reexecução vazia, checksum divergente recusado, 061 defeituosa sem tabela/ledger residual; pg_dump/restore reais, bundle e executável de `f95e9da` sobre esquema aditivo com runtime no browser |
| SMTP sintético clone/CTA/saúde, retry/reinício | `smtp-provider`, `provider-notifications`, `gs02`; aceitação local não significa caixa postal externa |
| Retenção e métricas honestas | `front3-admin`, suítes de retenção existentes, `observed-metrics`, `checkout-webhook`; sessão/clique/tentativa/remetente autenticado continuam separados |

Os componentes são integrados em cenários reais distintos, com esquemas/contas sintéticos isolados. Não se afirma uma venda real nem um único teste contínuo reunindo os 12 passos em uma instalação externa. O contrato genérico não confirma carregamento do destino nem identidade humana.

## Compatibilidade observada

Com todos os canais: Core e Fallback observados, dois canários, incidente deduplicado. Remover Bootstrap ou Core conserva Fallback e canários; remover Fallback conserva Core. Remover um canário conserva o outro. Apenas canários/CSP sem scripts: dois registros passivos, nenhum incidente ativo/mitigação. Todos bloqueados: nenhum recebimento; ausência permanece desconhecida. Testes de mitigação ativa são separados, em políticas aprovadas, não atribuídos a esses canários.

No Chromium ensaiado, sandbox vazio ou somente `allow-scripts` e `file://` receberam canários com host vazio, sem observações Core/Fallback ou incidente atribuível. Sandbox `allow-scripts allow-same-origin` recebeu todos os canais. Offline não gerou recibos e preservou navegação no mesmo documento. Não extrapolar esses resultados para outros navegadores ou políticas de terceiros.

## Desempenho e limites

O JSON `compatibility-performance.json` registra 30 navegações por variante, em ordem alternada; p50/p95/p99 de navegação, heap Chromium aproximado, 100 GETs de asset e 100 decisões com concorrência 5, respostas 429 separadas, RSS/HWM do gateway e falha real do processo/reinício. p99 de 30 amostras é a cauda observada, não estimativa robusta de produção. Heap arredondado não comprova overhead zero. Carga original HTTP local; Nginx/TLS é comprovado nas suítes operacionais, sem atribuir a elas esses percentis.

O render gate atual não oculta visualmente o documento: existe prazo de decisão de entrada de 150 ms e fail-open comprovado por GS06, distinto da preparação CTA. Esta entrega não transforma esse prazo em invisibilidade nem em 0 ms. F18 conserva a lacuna visual.

## Conflitos que permanecem

- **F14 / D05:** ON conserva política para UNCERTAIN. O visitante incerto pode ver PAGE_REDIRECT/CTA; invisibilidade desejada não é atingida. Alternativas para decisão do proprietário: política de observação (perde mitigação), reduzir percentual/classe (reduz alcance, não garante invisibilidade) ou nova fonte independente validada com regra conservadora (exige contrato, minimização e teste). Nenhuma foi ativada silenciosamente.
- **F22 / D07:** âncoras em DOM dinâmico/SPA/popups são suportadas; formulários ficam armazenados sem interceptação e envio nativo é preservado. Botão exclusivamente JavaScript sem âncora não ganha destino por inferência. Alternativa segura já suportada: link explícito para checkout, separado do formulário, sem repassar seus campos. Não foram interceptados dados reais.
- **F13:** operacionalmente UNCERTAIN; LOW/HIGH fortes são fixtures. Recibos do servidor original e importações administrativas podem contextualizar LP/instalação, não vincular visita a uma pessoa. Timestamp declarado/importado não vira primeira visita humana comprovada.
- **F32:** DNS autorizado tem fonte e horários; ASN/provedor permanecem `NOT_AVAILABLE`. IP do visitante não identifica hospedagem.

## Lacunas de implementação e autorização

F18 conserva gate visual; F25 conserva descoberta comercial sem associação segura/marker (UNKNOWN) apesar do snapshot manual integrado; F29 conserva confirmação externa de handoff/carregamento; F31 conserva adaptador/atribuição de provedor real; F37 conserva política integral de expiração de arquivos/logs/backups; F40 conserva fluxo mobile integral/decisão da stack. Não reclassificar esses itens como entregues por documentação.

O proprietário precisa escolher/autorizar provedor e contrato de checkout, fonte independente eventual de risco/ASN, eventual revisão de D05/D07, política operacional de backups/logs e decisão sobre adequação do painel à stack. Contas SMTP/sites/destinos/TLS/offsite/VPS reais ficam exclusivamente para homologação autorizada. Sem merge, deploy, DNS, segredo externo ou migration de produção.

## Resultado final

Foco `20261111T091733Z`: **5/5 PASS**, zero falhas/skips, 75,8 s. WordPress **7.1.4**. Navegação baseline p50/p95/p99 **9,4/11,9/13,6 ms**, runtime **27,4/31,3/36,5 ms**, delta p50 **18,0 ms**. Assets **1,74/6,53/18,59 ms**, zero falhas em 100. Decisões admitidas **13,54/30,31/31,92 ms** (24); **76** rejeições 429 esperadas, separadas dos tempos admitidos; zero falhas inesperadas. As cargas de browser também registraram 101 respostas 429 de canais/decisões: isso faz parte da degradação observada, não é omitido dos resultados. RSS gateway **76.204 → 76.640 KiB**, pico **84.180 KiB**; heap browser arredondado em 10 MB não mede delta fino. Dez falhas de conexão com processo parado foram esperadas; navegação e observação após reinício passaram. Não são números da VPS ou de TLS.

Falhas corrigidas: seletores antigos ambíguos com novos filtros; CSS inline bloqueado pela CSP (diagnóstico independente, corrigido por app.css); LP ausente na preparação legada; contagem de arquivos 57/58; consulta de ponto incerto incompatível com NOT NULL; WordPress CLI encerrando antes de instalar por ausência de WP_INSTALLING (diagnóstico independente, sentinela de instalação adicionada). As execuções anteriores com essas falhas não são evidência de sucesso.

Comparação da matriz: 13 → 22 laboratório; 16 → 6 incompletas; 12 → 13 homologação externa; quatro bloqueadas preservadas. Pendências: uma crítica, 16 altas, seis médias. Seis incompletas restantes explicitadas acima; nenhuma venda, pessoa ou entrega externa foi fabricada para encerrar itens.

Regressão local integral do código **39b0b14ffd4413c815dea8e4462f11fbf8a15d7d**: **118 Node + 10 Python PASS**, zero falhas/skips, lint/typecheck/build, Nginx/TLS, imagens Docker e Compose, exit 0; suíte Node **446,4 s**. Artefatos e manifesto: `test-results/front3/20261111T092216Z/`, exportação imutável `/tmp/anticlone-front3-source-7yh8de`. Após essa exportação, o delta `687f11d` passou a exigir recibos novos de cada executável no rollback; o último delta acrescentou a CSP permissiva explícita ao WordPress e sua cópia. Nenhum código de produção mudou nesses deltas. A CI oficial do SHA final, incluindo essas provas adicionais, é a confirmação imutável final no [PR #68](https://github.com/oleoceo/anticlone-personal/pull/68).

Revisão independente read-only **`/root/front3_review`**: favorável a **687f11df3a92042491bd1ebd3702426ae24ff50f**, sem P0/P1/P2 pendente, condicionada aos gates; delta CSP de teste também revisado, sem novo achado. Classificações 22/6/13/4 e limites aceitos pela revisão. Parecer final do delta documental/CSP e links dos checks por SHA ficam no PR. CI em execução não é PASS, e o PR só fica pronto após a conferência no SHA final. Sem autorização de merge/produção.
