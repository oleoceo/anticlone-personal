# Fechamento pré-VPS — Frente 1

Estado: IMPLEMENTADO PARCIALMENTE, testes/revisão final em andamento. Base `cb1242e`, merges #64/#65. Esta entrega não autoriza instalação VPS, migrações de produção, DNS, merge ou publicação do admin.

A [matriz única](FUNCTIONAL-MATRIX.md) contém F01–F45, uma classificação principal por função, comportamento pretendido/atual, evidência, lacuna, prioridade e dependência. Baseline corrigida pela revisão: 12 concluídas em laboratório, 23 incompletas, 5 implementadas com homologação externa pendente, 5 bloqueadas, 0 não implementadas. Pendências por função: 2 críticas, 21 altas, 10 médias. O rascunho 10/23/6/6 foi corrigido sem crédito de implementação: F35/F36 já provavam a função pretendida e F29 exige código, não só homologação. Não há reabertura dos comportamentos já demonstrados.

## Delta funcional verificável

G1 (F07/F17/F21/F43, ALTA): `infra/https/compose.yaml` fixava PILOT_OBSERVE, e installation-smoke aceitava somente esse modo. O overlay `infra/https/operational.yaml` seleciona OPERATIONAL explicitamente e mantém banco, rede, segredos, limites e hardening. Não cria autorização comercial de LP nem ignora aprovação/gerações. O teste compara os dois Compose renderizados e exige que modo seja o único delta. O smoke recebe modo esperado e UUID de instalação scoped para OPERATIONAL, mantém piloto como padrão seguro, recusa divergência e verifica scripts/TLS e fechamento de rotas admin no Nginx real. Isto prepara operação; não homologa destinos reais.

G2 (F34, ALTA): API bearer não compartilhava a validação Host/local do painel; admin usava defaults de HTTP para headers/corpos incompletos. Agora todo request exige peer/endereço local loopback e Host exato, recusa cabeçalhos de proxy e limita headers a 8 KiB, headers a 10 s, request a 15 s, conexões a 64 e requisições por socket a 100. Administração continua privada HTTP loopback via canal privado, nunca upstream público. Regressão usa sessão MFA real para rejeitar Host/Forwarded/X-Forwarded-*/X-Real-IP, preservando a sessão válida. Sockets reais exercitam 431 e 408 e disponibilidade posterior. Isso não promete resistência absoluta a DoS nem autoriza proxy/admin público.

F33/GS11 reutiliza as provas existentes: Nginx/body/rate/forwarding e queda de upstream em https-gateway; replay HMAC/idempotência em checkout-webhook, replay MFA em admin-totp, admissão limitada em investigation-volume; verify recusa loopback/metadata/não autorizados em runtime-distribution. O browser não fornece autoridade para elevar risco/autorizar mitigação. A nova fronteira privada complementa estes testes, sem chamar um teste unitário de homologação integral de segurança.

## F08: impedimento reproduzido, sem certificação inventada

`bash scripts/front1-isolation-probe.sh` executa imagem já existente com `--network none --cap-drop ALL --security-opt no-new-privileges:true`. Resultado observado: namespaces host/container distintos, somente `lo`, nenhuma rota IPv4. Essa fronteira de rede básica está demonstrada; a alegação histórica genérica de que toda a infraestrutura só permite host networking foi refinada.

`PROBE_BROWSER_SANDBOX=1 bash scripts/front1-isolation-probe.sh` acrescenta Chromium da imagem laboratorial existente `mcr.microsoft.com/playwright:v1.63.0-noble`, usuário pwuser, sem `--no-sandbox`. Resultado: `No usable sandbox`, saída 133/abort do Chromium. Apenas about:blank; nenhuma página hostil ou URL de terceiro aberta. A versão dessa imagem é diagnóstica e não é acrescentada às dependências do produto. Não se usou seccomp unconfined, privileged ou alteração de firewall para obter positivo.

Ainda faltam sandbox utilizável, mediação HTTPS por destino autorizado com DNS/rebinding/redirect, bloqueio UDP/WebRTC e ensaios adversariais dessa fronteira. `network none` sozinho impede também visitar a página alvo; não constitui verificador de instalação funcional. F08 permanece BLOQUEADA; controlledCheck null, NOT_VERIFIED e UNKNOWN são preservados. Infra necessária para esse verificador não foi instalada nem simulada. Próximo passo seguro: ambiente com sandbox de usuário funcional e mediador testável, antes de implementar navegação de verificação. Isso não bloqueia trabalho independente.

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

G1/G2: **2 lacunas altas de implementação → 0**, uma por mecanismo, sem multiplicar G1 pelas quatro funções. Na matriz: incompletas **23 → 19**, homologação externa **5 → 9**, concluídas em laboratório **12 → 12**, bloqueadas **5 → 5**, não implementadas **0 → 0**. Nenhuma função integralmente nova é promovida a concluída por este recorte.

Pendências globais por função: críticas **2 → 2**, altas **21 → 21**, médias **10 → 10**. O total inclui homologação externa. Não reduziu críticas porque F08 tem impedimento de sandbox/mediação e F14 tem conflito dependente do proprietário/evidência; nenhum código de configuração pode resolvê-los honestamente. F34 ainda requer trilha completa de alterações administrativas (o cadastro atual de projeto é INSERT sem auditoria correspondente); a nova fronteira HTTP não é apresentada como auditoria entregue. Frentes 2/3 continuam necessárias. Esta é uma entrega parcial funcional da Frente 1, não o fechamento definitivo pedido.

Revisão independente `/root/front1_review`, read-only sobre base cb1242e, favorável sem P0/P1/P2 de implementação remanescentes. Corrigiu referências da matriz e classificação F29/F35/F36. Typecheck e diff-check independentes PASS; delta adicional de smoke scoped, aviso Stealth, runbook e wrapper revisado favoravelmente (hash `bc764f130630ceee8913724df9aa52c184f3c871`; novo runbook `a76c47aceb0c05f1de6253427085edb8a5c3f35e`). Resultado final de testes e CI oficial vinculado ao SHA final no PR; antes dele não há declaração de Ready.

A primeira execução integrada encontrou o teste Host usando fetch (substituído por node:http) e o smoke global incompatível com OPERATIONAL multiprojeto (substituído por instalação scoped). Os testes do mecanismo corrigido passaram na segunda execução, incluindo admin, Compose e fluxo HTTPS operacional; o aviso de Stealth/delta documental posterior exige os gates finais. Logs persistidos em `test-results/front1/`, manifesto das fontes e resultado distinguem working copy do SHA de referência.
