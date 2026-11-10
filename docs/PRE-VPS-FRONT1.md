# Fechamento pré-VPS — Frente 1

Estado: IMPLEMENTADO PARCIALMENTE, testes/revisão final em andamento. Base `cb1242e`, merges #64/#65. Esta entrega não autoriza instalação VPS, migrações de produção, DNS, merge ou publicação do admin.

A [matriz única](FUNCTIONAL-MATRIX.md) contém F01–F45, uma classificação principal por função, comportamento pretendido/atual, evidência, lacuna, prioridade e dependência. Baseline corrigida pela revisão: 12 concluídas em laboratório, 23 incompletas, 5 implementadas com homologação externa pendente, 5 bloqueadas, 0 não implementadas. Pendências por função: 2 críticas, 21 altas, 10 médias. O rascunho 10/23/6/6 foi corrigido sem crédito de implementação: F35/F36 já provavam a função pretendida e F29 exige código, não só homologação. Não há reabertura dos comportamentos já demonstrados.

## Delta funcional verificável

G1 (F07/F17/F21/F43, ALTA): `infra/https/compose.yaml` fixava PILOT_OBSERVE, e installation-smoke aceitava somente esse modo. O overlay `infra/https/operational.yaml` seleciona OPERATIONAL explicitamente e mantém banco, rede, segredos, limites e hardening. Não cria autorização comercial de LP nem ignora aprovação/gerações. O teste compara os dois Compose renderizados e exige que modo seja o único delta. O smoke recebe modo esperado e UUID de instalação scoped para OPERATIONAL, mantém piloto como padrão seguro, recusa divergência e verifica scripts/TLS e fechamento de rotas admin no Nginx real. Isto prepara operação; não homologa destinos reais.

G2 (F34, ALTA): API bearer não compartilhava a validação Host/local do painel; admin usava defaults de HTTP para headers/corpos incompletos. Agora todo request exige peer/endereço local loopback e Host exato, recusa cabeçalhos de proxy e limita headers a 8 KiB, headers a 10 s, request a 15 s, conexões a 64 e requisições por socket a 100. Administração continua privada HTTP loopback via canal privado, nunca upstream público. Regressão usa sessão MFA real para rejeitar Host/Forwarded/X-Forwarded-*/X-Real-IP, preservando a sessão válida. Sockets reais exercitam 431 e 408 e disponibilidade posterior. Isso não promete resistência absoluta a DoS nem autoriza proxy/admin público.

F33/GS11 reutiliza as provas existentes: Nginx/body/rate/forwarding e queda de upstream em https-gateway; replay HMAC/idempotência em checkout-webhook, replay MFA em admin-totp, admissão limitada em investigation-volume; verify recusa loopback/metadata/não autorizados em runtime-distribution. O browser não fornece autoridade para elevar risco/autorizar mitigação. A nova fronteira privada complementa estes testes, sem chamar um teste unitário de homologação integral de segurança.

## G0 / F08: impedimento diagnosticado e verificador implementado

O impedimento inicial foi reproduzido: rede none tinha namespace próprio e somente loopback, mas Chromium sem ajuste seccomp falhava No usable sandbox. Diagnóstico independente /root/f08_sandbox_diagnosis mostrou user namespaces disponíveis, porém negados pelo perfil padrão. O perfil oficial Playwright + permissão restrita de chroot iniciou o sandbox mantendo network none/cap-drop ALL/no-new-privileges; chroot fora do user namespace permaneceu negado. Não se alterou firewall, AppArmor, sysctl ou serviço de terceiro.

O [verificador controlado](F08-CONTROLLED-VERIFIER.md) agora executa três passes num container descartável sem rede/segredos/binds, com mediação HTTPS limitada e URL proveniente exclusivamente da LP própria persistida. Prova de execução usa cobertura CDP no frame principal e hash igual aos bytes recebidos. Fallback é ensaiado sem Core; canários são ensaiados com scripts bloqueados por CSP adicional (não se afirma JavaScript globalmente desligado). O original não cria incidente e os POSTs Core/Fallback são persistidos no PostgreSQL real.

Foco fortalecido: 2/2 PASS, exit0, 47 s, em test-results/f08-focused/20261110T202040Z. Demonstrou FULL dos canais numa carga válida, PARTIAL com canários/CSP e com preload+POST forjados sem execução, UNSUPPORTED quando CSP bloqueia todos, NOT_VERIFIED na queda do gateway/documento ou alteração de geração. COEP/COOP/CORP não reproduzíveis retornam NOT_VERIFIED, com razão explícita; não são aprovações fictícias. TCP/UDP a partir do container não alcançam o host. Mitigação ativa, identidade/integridade futura e compatibilidade universal não são certificadas.

Migration aditiva 056 e painel existente por LP integram resultado/revisão/gerações, retenção de sete dias/dez registros e expiração periódica. A configuração privada do verificador permanece opt-in; gateway público não recebe Docker. F08 deixa o bloqueio crítico de código/isolamento para homologação externa pendente, preservando as limitações expressas. A certificação universal não é declarada concluída.

## Conflitos de produto que dependem do proprietário

O texto original `00- O anticlone.md`, trecho “Modo invisivel”, pretende que o operador veja sua página intacta mesmo quando os demais visitantes sofrem mitigação. `01- Decisoes Tecnicas.md` presume identidade de hardware e primeiros acessos como operador; Blueprint §11 corrige essas certezas e proíbe promessas desse tipo. `02- Observacoes Tecnicas.md` atribui sabotagem a canários; o contrato Personal mantém canários passivos e Fallback limitado. Não se importam essas garantias históricas impossíveis como implementação pronta.

D05 atualizada: OFF ignora risco; ON suprime evidência forte, mas conserva a política em UNCERTAIN. O avaliador operacional disponível permanece UNCERTAIN, inclusive quando a cadeia de investigação tem contexto de LP/instalação/alias; recibos e timestamps declarados não vinculam uma pessoa à visita. Portanto Stealth ON pode mitigar a visita do provável operador e revelar o comportamento. O caso HIGH forte de optional-stealth é sintético, não solução operacional. F13/F14 não são concluídas.

O painel de proteção agora exibe essa limitação em texto visível, inclusive com Stealth ON: provável operador pode receber redirecionamento/CTA alterado; evidência forte foi demonstrada só em laboratório. Isso informa a decisão sem mudar a semântica de D05 nem concluir invisibilidade.

Alternativas seguras, sem alteração automática de D05:

1. Manter D05 e explicitar no painel/política que a invisibilidade do operador não foi demonstrada; manter autorização operacional restrita aos contextos aprovados.
2. Mediante nova decisão, suprimir mitigação em UNCERTAIN: conserva discrição, mas pode suprimir quase toda mitigação com o avaliador atual. Não é solução equivalente de proteção.
3. Avaliar fonte independente autorizada, minimizada e vinculável à visita, com falsos positivos/negativos mensurados. Não há fonte configurada nem garantia de identificação; fingerprint não prova pessoa.

D07 suspende interceptação de formulários após navegação antes de cancelamento reproduzida em Chromium. A intenção F22/GS07 inclui formulários compatíveis; atualmente só âncoras compatíveis são mitigadas. Reativar exige decisão explícita, contrato de campos/destino e prova do envio real, sem transmitir dados a destino novo por inferência. Nesta Frente 1 formulário nativo continua intacto; não é tratado como aprovado nem interceptado. D08/D09 e D15 permanecem iguais.

## Reprodução e gates

Use `scripts/local-ci.sh` conforme LOCAL-CI.md em checkout Linux com histórico, PostgreSQL 16, Chromium e HTTPS sintético. `scripts/front1-lab.sh` é somente wrapper desta máquina Windows/WSL para exportação de fontes ao laboratório existente; não cria worktree, não instala VPS nem usa banco operacional. Manifesto registra fontes efetivas e dirty state. O gate final deverá rodar em SHA committed; logs de uma exportação dirty não são CI oficial desse SHA.

O teste operational-authorization reutiliza original/cópia em hosts HTTPS distintos, dois projetos/três LPs, runtime v2, painel MFA/CSRF, publicação/rotação/autorização/suspensão, Page Redirect e CTA reais, clique sem fetch de decisão e fail-open com gateway parado. Negativo padrão piloto recusa servidor OPERATIONAL; positivo explícito passa mantendo validação da CA sintética. Nenhuma mudança de LOW/HIGH operacional, D05 ou D07.

## Contagem e revisão do recorte

Lacunas únicas: **G0 crítica 1 → 0** (verificador controlado), **G1/G2 altas 2 → 0** (perfil/smoke e fronteira HTTP privada). Não multiplicar G1 pelas quatro funções. Na matriz, concluídas em laboratório **12 → 13** (F33), incompletas **23 → 18**, homologação externa **5 → 10**, bloqueadas **5 → 4**, não implementadas **0 → 0**. Total 45.

Pendências globais por função: críticas **2 → 1**, altas **21 → 21**, médias **10 → 10**, total **33 → 32**. F08 tinha prioridade crítica pela ausência de isolamento/verificador; a implementação/prova permite prioridade alta para homologação real, mantendo NOT_VERIFIED em contextos não reproduzíveis. F33 encerra os controles laboratoriais GS11: HTTPS/body/rate/spoofing, replay/dedup/admissão limitada e SSRF/mediação/isolamento. Isso não significa segurança absoluta/DoS distribuído nem auditoria administrativa concluída.

F14 continua crítica por conflito de invisibilidade/evidência e depende do proprietário. F34 ainda requer trilha completa de alterações administrativas (cadastro atual de projeto é INSERT sem auditoria correspondente); a fronteira HTTP não é apresentada como auditoria. Compatibilidade F03, formulários D07, SMTP CTA/saúde, backlog e frentes 2/3 continuam registrados. Esta é entrega funcional da Frente 1, com limites; não é fechamento definitivo do produto.

Revisão independente /root/front1_review, read-only sobre cb1242e e deltas, sem P0/P1/P2 remanescentes após correções. Typecheck/diff-check independentes PASS. Revisão inicial perfil/admin: delta bc764f130630ceee8913724df9aa52c184f3c871. Revisão F08: delta 31071f7bf3d31dd1f692d79dc45e0be19fd6e395. Achados de falso positivo por download e COEP foram corrigidos com cobertura/hash e NOT_VERIFIED explícito. O positivo nunca certifica proteção ativa.

Gates: regressão completa Linux PostgreSQL/Chromium/Nginx HTTPS com F08: 112 PASS/0 FAIL/0 SKIP, lint/typecheck/build e 10 Python PASS, exit0 em 459 s; evidências test-results/front1/20261110T203031Z. Ajuste final de logging do container validado em foco 2/2 PASS/exit0 (test-results/f08-focused/20261110T204001Z). Código anterior 08f553c passou CI oficial run42888682186. A CI oficial precisa do novo SHA final antes de Ready; resultado/link ficam no PR #66, sem inferir verde do SHA anterior.

Correções práticas anteriores: Host via fetch não enviava o header pedido (prova passou com node:http); smoke global incompatível com multiprojeto foi substituído por instalação scoped. No F08, corrigiram-se erro de chamada no teste de retenção e o uso de Debugger com JavaScript globalmente desligado; CSP adicional permite medir canários sem scripts da página. Logs de execução com falha não foram chamados PASS. Fontes/evidências de working copy ficam separadas do SHA final.
