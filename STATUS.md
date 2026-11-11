# STATUS — AntiClone Personal

## F13/F14 — ingestão e correlação autorizada (após #69)
- Base 8834bf3; branch feat/f13-f14-correlation; contexto de teste emitido/validado por fonte, recursos+checkout, snapshots por revisão.
- Foco real 3/3 PASS: PostgreSQL/Chromium/CLI assinado; TP2 FP0 FN2 TN6, oito abstenções; baseline #69 TP0/FN4. Sem HIGH injetado.
- Endereço loopback alterado, mobile, país autorizado, atraso/contradição/falha503/401; rotação diária imposta, minimização e retenção7d; fonte externa indisponível.
- Comparação com gateway #69 compilado: p95 entrada14,59→17,04ms; CTA17,60→15,78ms (30 amostras/endpoint/versão; sem SLO).
- Revisão independente favorável; SHA funcional80712b0:121 Node+10 Python PASS,0 falhas/skips,lint/typecheck/build/Docker/Compose exit0; CI oficial final por SHA no PR70 (duas falhas apt/DNS antes dos testes; mirrorlist temporária corrigida).
- V3 opt-in apenas proposto, veto operacional=false; v2/legado/comercial preservados. F13/F14 não concluídas: falta vínculo de visitas comuns e calibração de campo.
- Sem merge/deploy/DNS/contas externas/migration de produção; contrato, reprodução, riscos e limites em docs/F13-F14-CORRELATION.md.

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
