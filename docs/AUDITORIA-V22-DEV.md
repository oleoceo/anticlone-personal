# Auditoria operacional V2.2 no Dev

Base da auditoria `63a958f`. As telas React do admin privado na porta 3002 foram confrontadas com a proposta do proprietário em `/home/anticlone-dev/references/proposal-v2-2`. Os dados de ensaio ficam isolados do banco permanente. As 45 capacidades continuam registradas na [matriz funcional](FUNCTIONAL-MATRIX.md).

## Problemas e correções

| Área | Problema encontrado | Correção e prova |
|---|---|---|
| Atividade no dashboard | A visão usava barras por dia observado. A V2.2 pede a leitura da evolução no período e alternância com a tabela. | Gráfico de linha por dia UTC e tabela sobre a mesma série de fatos. Os dias sem registro aparecem como zero quando há atividade no intervalo. A interface preserva o estado vazio quando a métrica filtrada não tem registros. O teste usa o mesmo clique salvo para conferir gráfico e tabela. |
| Financeiro | A estimativa por projeto escondia projetos sem cliques e omitia as premissas usadas. | Tabela responsiva com cliques, ticket, taxa, versão, resultado e link para as premissas. Projetos sem cliques ou configuração exibem o motivo. Numeradores mantêm unidades inteiras e totais separados por moeda. O teste confere o ticket, a taxa, a versão e o resultado. |
| Compatibilidade financeira | A primeira implementação poderia quebrar uma aba já aberta com o JavaScript anterior ao retornar estimativas com numerador nulo. | O relatório mantém `estimate_projects` com a forma anterior e acrescenta `estimate_assumptions` em campo próprio. A revisão independente conferiu o delta. |
| SMTP | O painel mostrava configuração e preferência, sem um teste explícito de conexão. A primeira implementação também poderia confundir TLS com autenticação em um servidor sem `AUTH`. | **Configurações → Notificações → Testar conexão SMTP** verifica TLS e credenciais com o transporte privado correspondente à versão salva. A API exige sessão e CSRF, limita a frequência e verifica somente o destino definido pelo operador. O teste termina antes do envio. No ensaio, o React confirmou a conexão autenticada, o receptor TLS sem `AUTH` foi recusado e o worker demonstrou falha, nova tentativa e aceite de mensagens no receptor de teste. |
| Saúde e modo do gateway | A sonda podia indicar que o gateway respondia enquanto o perfil era apenas de observação. Isso dificultava entender por que ele não aplicava uma política. | A página Saúde e operações exibe o perfil confirmado em `/healthz`. O ensaio usa o modo operacional com aprovação e autorização específicas por LP e comprova suspensão. |
| Estabilidade do ensaio original/cópia | A execução agrupada podia tentar pausar o relógio do Chromium em um instante já ultrapassado pelo relógio simulado. | O teste instala o relógio com uma referência anterior e pausa no instante capturado. A mudança está restrita ao ensaio. |

## Fluxo desde o cadastro

- **Acesso e instalação.** Login MFA, publicação idempotente, snippets, diagnóstico e isolamento da URL oficial.
- **Original, cópia e investigação.** O Chromium carregou os snippets publicados no ambiente controlado. O gateway persistiu o incidente da cópia. O React exercitou triagem, recibos e importação de evidência autorizada.
- **Proteção e conversões.** Política publicada, aprovação da LP e autorização do contexto. Redirecionamento para destino aprovado, CTAs com destinos próprios, captura local com revisão e preservação do destino nativo após suspensão. O teste de drift confirma revisão e isolamento dos pontos.
- **Alertas, saúde e recuperação.** PostgreSQL persistiu rejeições e tentativas do worker. O receptor SMTP sintético confirmou o aceite de mensagens após a correção do cenário de falha. O ensaio de recuperação usa os clientes PostgreSQL 16 e verifica a restauração em um banco separado.
- **Comércio e ciclo.** Checkout Custom, amostra assinada, vínculo por LP, migração de formato, resultados e separação de moedas. Pausa, reativação e exclusão lógica usam os controles administrativos existentes.

## Provas e limites operacionais

Os logs e as capturas ficam em `test-results/auditoria-v22/`. As pastas `validado-painel` e `validado-jornada` contêm capturas do Chromium da execução com banco descartável. O build da porta 3002 é identificável pelo SHA exibido no painel.

A sessão independente `revisao` verificou o delta de `apps` e `tests` com SHA-256 `5a83bbdae50c3babe7f16dc64358305d58ff37c32bc98db4a6c109d562155a9e`. O achado sobre falso positivo na prova SMTP foi corrigido exigindo o erro de autenticação `EAUTH`.

Os ensaios de topologia HTTPS/NPM em Docker tiveram falhas na resolução de `gateway.test`, e o ensaio do verificador isolado retornou `CHECK_FAILED` na base. Esses resultados ficam nos logs `docker-namespace.log` e `fixtures-docker.log`. A CI do PR #82 para o delta depende de acesso de escrita no GitHub.

No banco permanente, a inspeção somente leitura encontrou três projetos, três LPs publicadas, zero incidentes e zero pedidos comerciais. A configuração permanente de SMTP está vazia. A conexão e o envio sintéticos demonstram o software. Envio e recebimento externos dependem de um provedor e um destinatário autorizados. DNS, HTTPS público, LPs externas, caixa postal, checkout externo e offsite mantêm as condições da matriz. O runtime e o Stealth conservam o comportamento anterior.
