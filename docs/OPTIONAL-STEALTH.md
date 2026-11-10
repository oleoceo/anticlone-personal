# Stealth opcional — D05, semântica v2

Decisão do proprietário de 2026-11-09, base main após PR #61. Esta entrega demonstra F14/F43 e GS05/GS19 em laboratório controlado. Não habilita mitigação em domínios reais, não muda PILOT_OBSERVE nem a ativação operacional.

## Contrato de configuração e seleção

Página e cada superfície de CTA têm configuração independente e imutável na versão publicada: `stealth_version:2` e `stealth:true` (ON) ou `stealth:false` (OFF). O formulário exige escolha explícita; versão desconhecida, null, strings e OFF sem versão são recusados. `enabled` continua controlando a política comercial, separadamente. O runtime recebe `stealthVersion:2` como metadado da semântica da decisão, sem autoridade de autorização.

| Configuração | LOW | HIGH | UNCERTAIN / avaliador indisponível |
|---|---|---|---|
| v2 OFF | Avaliar política | Avaliar política | Avaliar política |
| v2 ON | Avaliar política | Suprimir apenas com evidência forte verificável; rótulo isolado não basta | Avaliar política, registrar incerteza quando disponível |
| Legada | LOW da fixture permite avaliar | OBSERVE_ONLY | OBSERVE_ONLY |

Avaliar política mantém origem/projeto autorizados, LP e projeto elegíveis, aprovação publicada compatível, destino autorizado, classe, percentual, versão/bucketing, drift, lifecycle, timeout e fail-open. O laboratório exige instalação e origem loopback explicitamente configuradas. Página e CTA usam suas próprias fases: supressão da política de entrada não desabilita uma política de CTA independente. Original e contextos não autorizados ficam OBSERVE_ONLY. PAGE_REDIRECT conserva o prazo de 150 ms; CTA pronto decide localmente no clique, validade/refresh anteriores preservados.

A avaliação atual permanece probabilística conservadora: ausência de UTM, primeiro contato, repetições, IP/DNS e sinais de navegador não sustentam HIGH. Não existe fonte operacional verificável por visita para classificar operador nesta entrega. Evidência forte é demonstrada exclusivamente por fixture sintética configurada no servidor em loopback: origem e instalação autorizadas, SCOPED_LAB_RISK=HIGH ou LAB_CONTROLLED_RISK=HIGH, source=lab_configuration, reason=controlled_fixture, confidence=test_only. Isso não é calibração nem identificação humana. LOW/HIGH/UNCERTAIN/ERROR são fixtures de teste, nunca campos aceitos do visitante. Em v2 ON, HIGH sem essa evidência é tratado como não demonstrado; não suprime. Uma futura fonte operacional exige nova versão de avaliador, critérios documentados, calibração e autorização do proprietário.

## Migração explícita, compatibilidade e rollback

Em banco de laboratório, aplicar 050 após as migrations anteriores. Ela adiciona campos opcionais e remove somente o CHECK antigo que impedia OFF em página; não atualiza políticas, não reescreve versões ou aprovações e não preenche evidências históricas. NULL significa contrato legado; página antiga com stealth=true e CTA antigo sem campos novos continuam sob o contrato anterior. Clientes legados ainda podem publicar apenas esse contrato, identificado na inspeção por versão ausente; omissão nunca significa OFF.

Para migrar: escolher ON/OFF, publicar nova versão em cada ação desejada, consultar a LP e aprovar novamente o snapshot exato de versões. Publicar por si só não reaprova a LP. Na mesma fase de CTA da LP não se aceita misturar contratos legados e v2: migrar explicitamente todas as superfícies aprovadas dessa fase antes de reaprovar. A consulta de decisão também rejeita a mistura antes de avaliar risco. Esse bloqueio por configuração é invariável para LOW/HIGH/UNCERTAIN e evita que a espera investigativa legada condicione OFF. Modos ON/OFF entre superfícies v2 continuam independentes; PAGE_REDIRECT pode migrar separadamente. Campos de Stealth v2 fazem parte do snapshot; troca de versão/configuração invalida a aprovação anterior conforme os gates existentes. Snapshots legados omitem os novos campos nulos para preservar comparabilidade. Sem 050, novas publicações v2 falham; versões antigas e observação permanecem compatíveis. A interface exige a migration para novas publicações.

Rollback de configuração: selecionar uma versão anterior e reaprovar as vinculações da LP quando necessário. Rollback de código: parar processos novos, reativar/aprovar versões legadas antes de usar código antigo e conservar a migration aditiva. Código antigo não interpreta a semântica v2; não prometer rollback funcional de OFF sem essa preparação. Não executar migração ou rollback de produção nesta entrega.

## Investigação independente e limites

Reutilizam-se risk_assessment_days, incidentes, investigation/timeline e sinais existentes de Core, fallback, canários, hostnames e primeiro recebimento. Nenhum coletor ou fingerprint novo, valor bruto de UTM, click-ID, IP ou identificador permanente foi adicionado. Recursos/download e file:// só podem compor investigação quando efetivamente observados pelas fontes existentes; não se fabricam eventos de download nem observabilidade de arquivo local a partir de ausência do Core.

A primeira observação do incidente retido é a data em que o sistema o viu, nunca a data real de publicação da cópia. A correlação é limitada por projeto/cópia/host e pelos dados disponíveis; a sessão efêmera usada no bucketing é manipulável e não prova pessoa ou dispositivo único. Não se recupera IP real por trás de proxies. Canários, hostname, Core/fallback e categorias de atribuição são alegações; fontes do mesmo navegador não são evidências independentes. Limitações, gaps e contradições do avaliador existente continuam preservados.

Na semântica v2, a decisão não aguarda persistência investigativa: falha gera diagnóstico fixo sem alterar seleção; uma queda pode perder a amostra pendente. Legado preserva o requisito histórico de persistência antes de mitigar. O registro mantém limite de 1400 agregados/projeto e sete dias; consulta de risco até 100 linhas. Timeline mantém limites existentes (100 eventos por consulta/host, 10.000/projeto, 30 dias). Nenhum dado foi retropreenchido ou coletado sem limite. Falhas das consultas de segurança/aprovação/política continuam fail-open na navegação, retornando OBSERVE_ONLY.

## Prova reproduzível

`npm run build && node --test --test-concurrency=1 dist/tests/optional-stealth.test.js`, com TEST_DATABASE_URL de banco isolado e Chromium instalado. O teste usa PostgreSQL real, gateway HTTP local e Chromium; valida PAID 100%/DIRECT_UNKNOWN 0% nas duas ações para LOW/HIGH/UNCERTAIN/ERROR, ON forte/incerto, políticas independentes, duas LPs/projetos, legado/migração/reaprovação, original, pause, destinos e falha de backend. O teste de persistência pendente prova que uma decisão v2 não aguarda a investigação. GS06, scoped-gateway, atribuição F42, métricas F29/F30, drift e lifecycle têm regressões na bateria integral existente.

F13/F14/F43 e GS05/GS19 integrais continuam parciais: esta prova não valida classificador operacional, browser hostil, todas as plataformas ou mitigação real. Revisão independente, comandos e estado da CI do SHA final serão registrados no PR consolidado.

Complemento PR #64: OPERATIONAL admite decisões scoped somente com autorização administrativa persistida por LP e aprovação vigente. Risco permanece UNCERTAIN, sem fixtures HIGH/LOW. OFF independe do risco, ON mantém UNCERTAIN; legado não migra implicitamente. Prova HTTPS sintética em operational-authorization.test.ts, sem autorizar domínios reais. Restrições LAB acima continuam nos respectivos caminhos.
