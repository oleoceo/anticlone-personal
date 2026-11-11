# F13/F14 — correlação autorizada, sem ativação operacional

Base: PR #69, `8834bf3c9f34cc699404705495bdb09daf53a110`. Esta entrega acrescenta ingestão e correlação funcional de operações observadas numa fonte controlada. Não conclui F13/F14, não identifica humanos e não autoriza veto v3.

## Fontes auditadas e limite de vínculo

| Informação disponível | Proveniência e uso |
|---|---|
| Logs de acesso ao original já importados | Administrador atesta recurso e horário; sem contexto de visitante autenticado, sustentam apenas investigação de grupo/LP. |
| Distribuição, Core, Fallback e canários | Recibo do gateway prova recebimento, não execução/download completo; host e sessão são alegações públicas. |
| Primeiro recebimento e sessões posteriores da cópia | Cronologia observada, não data de criação da cópia ou identidade. Sessões efêmeras não unem dispositivos automaticamente. |
| Drift de CTA e alterações de checkout | Drift alegado pelo browser não autentica quem editou. Nova fonte pode atestar alteração observada em ferramenta própria de exportação/teste. |
| Gateway e eventos de checkout | Recibos de decisão/ação e webhooks não provam que uma pessoa é operador. Dados de venda não entram neste classificador. |
| Rede/geografia aproximada | Somente categorias de rede e país declarados por fonte autorizada; ausência é `UNAVAILABLE`. Sem serviço externo conectado, GPS, IP bruto ou coleta automática. |

Logs comuns de CDN, mesmo assinados, não fornecem continuidade de sessão autenticada. O ganho demonstrado exige instrumentação de uma ferramenta própria que observe recursos e alteração de checkout e **emita seu próprio contexto efêmero de teste**. Nenhuma fonte externa real foi conectada ou homologada.

## Contrato de ingestão v1

`apps/authorized-activity.ts` aceita esquema fechado: versão 1, UUID do evento, projeto/LP/fonte autorizados, pseudônimo de contexto na fonte, horário declarado e tipo de evento. Tipos: `RESOURCE_REQUEST` com HTML/SCRIPT/STYLE/IMAGE, `CHECKOUT_CHANGED`, `ISSUED_TEST_CONTEXT`, `CONTRADICTION` e `SOURCE_GAP`. País de duas letras e rede RESIDENTIAL/HOSTING/UNKNOWN são opcionais, exclusivamente contextuais.

A assinatura HMAC-SHA256 cobre todos os campos, ordenados, com domínio `anticlone-authorized-activity-v1`. Chave nunca vem do evento/browser. O arquivo local de fontes autoriza explicitamente ID, projeto, página e capacidade de emitir contexto (`sessionContinuity: true`). Importação não cria conexão de conta, endpoint público nem busca URL arbitrária. Assinatura verifica a fonte; não verifica independentemente a verdade de seu registro. Fonte comprometida continua sendo risco.

`issueActivitySession` deriva o contexto de teste por HMAC em domínio separado, incluindo UUID de emissão, fonte, projeto, página, contexto de origem, horário e host. O importador verifica essa derivação: assinar uma sessão arbitrária de lead é rejeitado. O adaptador autorizado deve gerar o UUID e emitir o contexto do lado servidor, nunca aceitar sessão/UUID de emissão escolhidos por um cliente. A ferramenta transfere seu contexto emitido ao navegador de teste; nenhuma mudança no runtime público é necessária. Esse fluxo explícito não existe em uma visita comum sem instrumentação.

O ID público ainda pode ser copiado/compartilhado depois da emissão: **não é credencial nem prova de posse humana**. Esse risco, ausência de calibração e falta de fonte real homologada impedem tornar a proposta autoridade operacional.

`apps/activity-import.ts` importa um envelope JSON `{event,signature}` de até 4096 bytes, usando configuração local de até 65536 bytes. Após build, executar `node dist/apps/activity-import.js /caminho/evento.json` com `DATABASE_URL` e `ACTIVITY_SOURCES_FILE` já configurados para ambiente autorizado. Configuração é um array de `{id,project,page,key,sessionContinuity}`; chave existente deve ter pelo menos 32 caracteres e permanecer fora do repositório. O comando só importa dados; não aplica migrations nem configura fontes/segredos. Erros não imprimem conteúdo, chave ou conexão.

Migration opcional 062: eventos vinculados a projeto/LP, horários de observação e recebimento separados, deduplicação por fonte/UUID, rejeição de replay conflitante, sete dias de retenção e teto de 10.000 eventos/projeto. Dados futuros ou com mais de sete dias são rejeitados. HMAC diário no importador impõe rotação ao contexto da fonte, mesmo que a fonte reutilize o mesmo valor. Valor recebido de actor e sessão pública não são persistidos no payload; hash/pseudônimo não significa anonimização. Limpeza também passa pela manutenção de projetos pausados. Migration executada exclusivamente em schemas descartáveis no ensaio.

## Avaliação e integração

`authorized-correlation-v1` consulta primeiro o índice do contexto atual, depois até 101 eventos da mesma fonte/contexto diário/LP em 30 minutos. Para propor `PROBABLE_COPY_TEST_SESSION`, exige contexto emitido válido há menos de cinco minutos, solicitações de ao menos três categorias de recurso incluindo HTML, alteração de checkout posterior a recursos e anterior à emissão. Conta autorizada e contexto emitido sustentam uma hipótese investigativa de sessão de teste da cópia, não uma identidade. Esta é uma regra explicável conservadora, não um modelo estatístico calibrado.

Ausência de vínculo, expiração, ordem incompatível, contradição, lacuna da fonte (inclusive de outro contexto) ou truncamento causam abstenção. A validade também termina ao sair a primeira evidência da janela. Sinais favoráveis e contrários conservam referências dos eventos; confiança é `UNCALIBRATED` e probabilidade é `null`. Sem dataset de campo suficiente não há porcentagem inventada. IP, país, User-Agent, UTM, primeira visita e coincidência de horário não têm peso decisivo.

`operator-correlated-v1` persiste essa avaliação pela fila complementar existente, continuamente ON/OFF. A resposta do gateway não aguarda ingestão/correlação; sem consulta externa, mudança de Core/Fallback ou fetch no clique. Alteração das evidências permite novo snapshot no mesmo minuto sem reescrever o anterior. A API autenticada de investigação apresenta também até 100 eventos autorizados de contexto de LP, separados das avaliações por sessão.

Proposta v3 conserva opt-in e aprovação obrigatórios: OFF nunca propõe veto; ON pode indicar que a hipótese adicional preservaria Page Redirect/CTA originais **se um contrato futuro for aprovado**. `operationalVeto` e `operationallyEligible` continuam falsos; publicação v3 continua rejeitada. V2/legado, classes, percentuais, destinos, versões, aprovações e demais gates permanecem independentes.

## Prova reproduzível e comparação

`tests/authorized-activity.test.ts`: servidor original privado com contas de teste, exportação HTML realmente recebida e servida como cópia controlada, solicitações de recursos, alteração material do checkout e emissão de contexto no servidor. O ensaio navega em Chromium com o runtime real, importa envelopes assinados por arquivo e verifica snapshots persistidos pelo gateway. Não injeta `HIGH`, fixture positiva ou rótulo de operador no avaliador. Os rótulos são usados somente para medir os resultados conhecidos do ensaio.

Dez casos repetidos ON/OFF: operador e lead PAID, contexto mobile, rede compartilhada, alteração real de endereço de origem entre `127.0.0.1`/`127.0.0.2`, mesmo país aproximado, visitas sem UTM, contexto não vinculado, contradição, recursos atrasados/importados fora de ordem e falhas 503/401 da fonte autorizada. São endereços de origem loopback distintos, país de teste declarado, contextos Chromium; não VPN/ISP real, geolocalização externa ou hardware físico. Também rejeita assinatura falsificada, campo IP, escopo errado, continuidade sem autorização, sessão arbitrária assinada e replay conflitante; verifica rotação diária, expiração, lacuna e retenção.

| Avaliação no conjunto controlado de 4 operadores/6 leads | TP | FP | FN | TN | Abstenções |
|---|---:|---:|---:|---:|---:|
| PR #69 sem fonte vinculada | 0 | 0 | 4 | 6 | 10 |
| Correlação com contexto emitido e sequência suficiente | 2 | 0 | 2 | 6 | 8 |

TP são dois contextos emitidos de teste, um mobile com alteração de rede e importação atrasada. FN são operador sem continuidade e operador com contradição. Toda avaliação insuficiente conta como abstenção e, se positiva no rótulo, também FN. O teste histórico `operator-shadow` permanece verde com seu próprio conjunto e resultado 0/4; os rótulos/variantes dos dois conjuntos são diferentes e não representam benchmark de campo pareado. A melhoria mede a nova capacidade de correlacionar fontes, não acurácia generalizável ou identidade.

Reprodução local no ambiente documentado em LOCAL-LAB-ENV: `bash scripts/operator-correlation-lab.sh`. Exporta arquivos rastreados da worktree, compila também o baseline exato #69 e usa PostgreSQL descartável. Resultado em `test-results/operator-correlation/<UTC>/authorized-activity/results.json`, sem credenciais nem sessões/actors crus. Foco: 3/3 PASS, zero falhas/skips. A comparação alterna ordem das versões, descarta cinco aquecimentos e mede 30 requisições por endpoint/versão no mesmo banco/host. Primeira execução: p95 entrada 14,59 ms baseline / 17,04 ms novo; CTA 17,60 / 15,78 ms. Amostra pequena, sem SLO/garantia; concorrência de fila e aquecimento podem explicar diferenças. A medição antes/depois de evidência é reportada separadamente por endpoint.

Revisão independente `/root/independent_review`: favorável ao delta de código `b30e65351cea2d59ffde6672323eabb39b07ab5c`, após correção de vínculo, rotação e comparação. Sem P0/P1/P2 pendente; aprovação limitada à investigação complementar. Gates integrais, delta final e CI oficial por SHA registrados no PR/STATUS.

Regressão local integral do SHA funcional `80712b0`: 121 Node + 10 Python PASS, zero falhas/skips, lint/typecheck/build/Docker/Compose exit0; evidências `test-results/front3/20261111T144312Z`. A primeira suíte teve expectativa de migration antiga (corrigida) e timeouts browser não repetidos na segunda execução completa; registros separados no PR. A CI oficial desse SHA falhou duas vezes antes dos testes por resolução de `azure.archive.ubuntu.com` durante apt/Playwright. Correção limitada à mirrorlist efêmera do runner, usando HTTPS Ubuntu direto e mantendo fontes/keyrings/gates: mecanismo do [runner GitHub](https://raw.githubusercontent.com/actions/runner-images/main/images/ubuntu/scripts/build/configure-apt-sources.sh) e [APT oficial](https://manpages.ubuntu.com/manpages/noble/man1/apt-transport-mirror.1.html). Não modifica DNS, stack ou produção. Revisão do delta e CI no SHA final permanecem gates do PR.

**Limite restante exato:** visita arbitrária sem contexto emitido por ferramenta autorizada não pode ser vinculada por estas fontes. Compartilhamento/replay de contexto público, uso comum de conta e comprometimento da fonte ainda podem produzir atribuição incorreta. F13/F14 permanecem bloqueadas para uso operacional; calibração de campo, vínculo adequado ao cenário real e aprovação explícita do proprietário continuam necessários. Sem ativação, merge ou deploy nesta entrega.
