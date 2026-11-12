# STATUS — AntiClone Personal
## F29/F31 — Custom multiprovedor — PR #75
- Base fdcc453 (#74); branch única feat/f29-f31-multiprovider; sem merge/deploy/contas externas ou migrations de produção.
- Catálogo global imutável, contas criptografadas, vínculos versionados, HMAC Custom, ledger/dedup/estornos e relatório F30 por moeda.
- Foco PG/Chromium10/10, Linux commerce/upgrade3/3 e jornada/F18/GS06 corrigido5/5 PASS; lint/typecheck/build PASS. CI inicial126/1; correção só no harness revisada; CI final por SHA no PR75.
- Revisão independente /root/commerce_review favorável ao delta funcional, sem P0/P1/P2 pendente; hashes/provas em docs/F29-F31-MULTIPROVIDER.md e PR.
- Chegada confirmada, atribuição verificável, API externa e estornos parciais não suportados; checkout real depende de contrato/credenciais autorizados.
- F29/F31 integrais não declaradas concluídas; limites/matriz em docs/F29-F31-MULTIPROVIDER.md. PR75 consolidado; sem autorização de merge.

## Hotfix CI shadow apos #72
- Base 3ec1796; branch fix/ci-shadow-entry-deadline; escopo exclusivo do harness, sem runtime/politica/migration/infra alterados.
- CI 43080387939 confundia PAGE_REDIRECT no replay com entrega dentro dos 150 ms; tempo inclui Core e buffering route.fetch/body/fulfill.
- Matriz ON/OFF com relogio controlado e sem interceptacao; transporte real direto e retencoes de 250 ms comprovam navegacao/fail-open/CTA/original.
- Foco PostgreSQL/Chromium 2/2 PASS; direto JSON43,6ms < prazo164,7ms; servidor/replay atrasados JSON293,5/301,5ms, sem page redirect tardio.
- Cabecalho forjado na API de refresh preserva teste de entrada nao confiavel sem preflight artificial ou ampliacao CORS. F13/F14 continuam shadow, sem veto novo.
- Revisao independente, regressao integral e CI oficial do SHA final registradas no PR do hotfix; nao tratar gates pendentes como PASS. Sem merge/deploy/operacoes externas.

## Nucleo operacional apos estabilizacao CI
- Base 8834bf3 + PR tecnico #71 verde em 29c2a06; branch consolidada fix/operational-core-closure, sem merge/deploy.
- Defeito comprovado: consulta/mapping CTA no painel recusava HTTPS; alinhada ao contrato existente. Importacao manual original preservada.
- Jornada continua desktop/mobile 2/2 PASS em laboratorio: projeto/LP, runtime, incidente, SMTP falha/retry/processos novos, destinos, 0/50/100/classes, suspensao/recuperacao.
- F37/F38: retencao configuravel plan/apply so em arquivos sinteticos; preserva latest/verificado, recibo de restore real; foco retention/recovery 2/2 PASS.
- Delta suplementar de canarios/CSS e viewport, regressao integral, revisao final e CI por SHA devem ser conferidos no PR consolidado; nenhum gate pendente e chamado PASS.
- Matriz: 23 laboratorio / 4 incompletas / 14 homologacao / 4 bloqueadas. F18/F25/F29/F31 permanecem; D07 e shadow #69 preservados.
- Limites/decisoes reais: LPs/destinos, SMTP, prazos/armazenamento/offsite e ambiente autorizado; docs/OPERATIONAL-CORE-CLOSURE.md. Nenhuma migration 062/conta externa/operacao de producao.

## Estabilizacao CI apos #69
- Base obrigatoria 8834bf3; PR tecnico #71; #70 fechado/Draft preservado, sem migration 062 ou ingestao experimental.
- Falha 43045087835: DNS Ubuntu durante apt antes dos testes; Chromium agora instala sem apt, com smoke real obrigatorio.
- Revisao independente /root/ci_review favoravel ao codigo 2c4ef1d, sem P0/P1/P2; diff-check e validacao documental PASS.
- CI oficial e SHA final devem ser conferidos no PR #71; nenhum merge/deploy/DNS/SMTP externo/migration de producao autorizado.


## F13/F14 — avaliador shadow e perfil investigativo
- Base ab8c7bd (main após #68), branch feat/f13-f14-shadow; investigação ON/OFF separada do veto, v2/legado preservados.
- Código: operator-shadow-v1, perfil autenticado grupo/sessão, snapshots imutáveis/limitados e migration aditiva 061 apenas laboratorial.
- Prova focada: 5/5 PASS, zero falhas/skips, PostgreSQL16/Chromium156; upgrade/restore, v2, snapshots, tempo e locks reais. Regressão integral e CI final por SHA no PR.
- V3 apenas proposta interna opt-in; sem publicação/ativação. Rede/comportamento/geografia indisponíveis, sem coleta nova invasiva.
- F13/F14 permanecem bloqueadas por ausência de fonte operacional de sessão e calibração de campo; contagens da matriz preservadas.
- Revisão independente /root/shadow_review favorável ao delta final, sem P0/P1/P2 pendente; módulo SHA256 AC84C436, teste 8DE3D894. Métricas reais FP 0/6 e FN 4/4; fixture separada FN 3/4.
- Sem merge/deploy/DNS/custos novos/migrations de produção; contrato, reprodução e limitações em docs/F13-F14-SHADOW.md.
- **Frente 1:** PR #66, SHA 3683e5d, revisão independente favorável e CI oficial verde (42899056739); sem merge/deploy.
- **Frente 2 F27/F45:** SMTP privado TLS para CTA/saúde, tentativas duráveis, revisão auditada do backlog e worker/monitor local independente; base 3683e5d, branch feat/pre-vps-front2.
- **Prova focada:** provider-notifications 2/2 PASS, 0 falhas/skips/exit0; PostgreSQL/Chromium/SMTP TLS, retry/reinício, recuperação do backend, MFA/CSRF, concorrência e SIGTERM. UNKNOWN preservado sem takeover.
- **Gates:** regressão Linux 114 Node + 10 Python PASS, 0 falhas/skips; lint/typecheck/build/Docker/Compose exit0. /root/front2_review favorável a 032d9a4 e delta documental af38a3f; sem P0/P1/P2. CI oficial e estado pronto por SHA no PR #67.
- **Matriz:** 13 laboratório / 16 incompletas / 12 homologação externa / 4 bloqueadas; 1 crítica, 21 altas, 10 médias. F27/F45 aguardam recebimento externo, não declaradas concluídas integralmente.
- **Limites:** aceite SMTP não prova caixa postal; monitor observa apenas backend loopback. D05 invisibilidade, D07 formulários, auditoria completa F34 e compatibilidade continuam pendentes.
- **Operação:** migrations 057/058 apenas em teste isolado; sem deploy/DNS/segredos externos/migrations de produção. Provas e configuração em docs/PRE-VPS-FRONT2.md.

## Frente 3 - fechamento funcional pre-VPS
- Base f95e9da; branch unica feat/front3-pre-vps; sem merge/deploy/DNS/segredos/migrations de producao.
- Cadastro auditado/atomico, metadados de alteracoes 059/060, retencao, filtros/navegacao/CSS CSP desktop/mobile e chave webhook impar recusada.
- Foco 5/5 PASS, zero falhas/skips: HTML/React-Vite/WordPress real, canais/CSP/sandbox/file/offline, duas ofertas/superficies, carga, upgrade/restore/rollback f95e9da.
- Matriz:22 laboratorio/6 incompletas/13 homologacao/4 bloqueadas; pendencias1 critica/16 altas/6 medias. F18/F25/F29/F31/F37/F40 incompletas, D05/D07 preservadas.
- Revisao independente /root/front3_review favoravel a687f11d e delta CSP, sem P0/P1/P2 pendente; parecer final/checks por SHA no PR68.
- Regressao local39b0b14:118 Node+10 Python PASS,0 falhas/skips; lint/typecheck/build/Docker/Compose exit0. CI oficial do SHA final conferida no PR68; provas/limites em docs/PRE-VPS-FRONT3.md.

## F25/F18 — fechamento laboratorial após PR #73
- Base e8dd1c6; branch feat/f25-f18-closure; código 863be6d; um PR consolidado, sem merge/deploy/produção.
- F25: termos estruturados revisados, UNKNOWN, drift/alerta por ponto, legado e reaprovação auditada D15; F18: gate opt-in, deadline 150 ms e medidas reais desktop/mobile.
- Foco 6/6 PASS; integral 125 Node + 10 Python PASS, zero falhas/skips; lint/typecheck/build/Docker/Compose/PostgreSQL16/Chromium/HTTPS/restore/rollback exit0.
- Revisão independente /root/f25_f18_review favorável a 863be6d, sem P0/P1/P2 pendente; delta posterior de testes/documentação, revisão/CI final por SHA no PR.
- F18/F25 concluídas em laboratório: matriz 25 laboratório/2 incompletas/14 homologação/4 bloqueadas; pendências 1 crítica/15 altas/4 médias; agregado histórico corrigido pelas linhas Fxx.
- Homologar LPs, CSS/dispositivos/redes, checkout/WhatsApp e alertas externos reais; sem inferir oferta/preço hostil, sem formulário D07, sem invisibilidade prometida.
- CI main 43098539403 intocada; PR74: run43218675626 124PASS/1FAIL na sonda literal150, corrigida sem mudar Stealth; foco ampliado8PASS, nova CI final exigida. Provas/limites: docs/F25-F18-CLOSURE.md.
