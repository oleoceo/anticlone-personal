# Frente 2 pré-VPS — notificações e backlog

Recorte F27/F45, GS08/GS13/GS21: transportar CTA e saúde pelo SMTP privado configurado e permitir revisão explícita dos itens retidos. Base `3683e5d` da Frente 1. Sem homologação de caixa postal externa, merge ou deploy.

As migrations aditivas 057/058 registram tentativas CTA/saúde e decisões administrativas. O painel privado existente oferece inspeção, liberação, cancelamento e reconhecimento de resultado desconhecido, com MFA/sessão/CSRF, justificativa, confirmação do item e revisão otimista. A liberação vale apenas para a geração de pausa inspecionada; nova pausa exige nova decisão. Nenhuma decisão zera tentativas ou reescreve resultados anteriores. CTA PROCESSING conserva seu token: nem lease vencida nem reconhecimento autorizam replay, cancelamento ou troca do dono.

O worker independente despacha clone, CTA e saúde operacional por projeto ativo. Falhas de uma fila/projeto têm espera de 60 segundos e não impedem os demais despachos. SIGTERM interrompe novas admissões, permitindo terminar a atual. O monitor consulta apenas `/healthz` do backend loopback a cada minuto, com timeout de dois segundos, limite de resposta e validação do contrato. Não mede disponibilidade pública, DNS, Nginx, disco ou saúde universal. Observações não são reaplicadas após pausa ou mudança da configuração de saúde.

## Configuração e limites

Use os campos SMTP privados e a correspondência administrativa descritos em [CLONE-SMTP.md](CLONE-SMTP.md). CTA/saúde usam o mesmo provedor e orçamento global. TLS e autenticação são obrigatórios; credenciais não entram no painel, runtime, histórico de tentativas ou mensagens de erro. `FAILED` é erro observado pelo cliente e não prova rejeição pelo servidor; retry pode duplicar entrega. Aceite SMTP não comprova recebimento na caixa postal.

Após migrations em ambiente autorizado, o perfil Compose `notifications` habilita o worker com `NOTIFICATION_WORKER_MODE=PROVIDER` e `MONITOR_LOCAL_GATEWAY=1`. Ele usa o mesmo arquivo privado do gateway; `PUBLIC_GATEWAY_HOST` deve coincidir com a fronteira HTTPS_PROXY. Não iniciar esse perfil sem configuração SMTP válida. Não aplicar migrations em produção por este procedimento.

## Evidência

`tests/provider-notifications.test.ts` usa PostgreSQL, Chromium, subprocessos reais e SMTP TLS com certificado efêmero. Cobre rejeição TLS/autenticação, retry e reinício, queda/recuperação do gateway, isolamento, MFA/CSRF, confirmação/revisão obsoleta, liberação/cancelamento e resultado desconhecido após queda do worker. O segundo cenário injeta falhas de persistência por projeto/fila e verifica ausência de admissões novas após SIGTERM.

Foco Linux em `test-results/front1/20261110T2213*/provider-focused-3.log` (origem `/tmp/anticlone-front1-source-z71c4o`): 2/2 PASS, 0 falhas/skips, exit 0, 15,1 s. Três aceites SMTP, tentativa CTA interrompida preservada UNKNOWN e decisões RELEASE/CANCEL/ACK_UNKNOWN persistidas. Duas falhas anteriores eram preparação da fixture: LP ausente e tabelas MFA inicializadas pelo entrypoint ausentes no servidor embutido; ambas corrigidas sem alterar código funcional.

Regressão completa e CI finais: pendentes. Revisão independente read-only `/root/front2_review`: favorável para o delta funcional de 17 arquivos sobre `3683e5d`, sem achados P0/P1/P2 confirmados, condicionada aos testes. Diagnóstico e revisão dos ajustes da fixture registrados na mesma sessão. Documentação posterior não altera esse contrato.
