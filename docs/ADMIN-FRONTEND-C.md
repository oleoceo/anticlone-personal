# Entrega C — painel administrativo

O painel React usa a sessão, o TOTP, a proteção CSRF e as rotas privadas já usadas nas Entregas A e B. As novas telas são servidas sob `/admin/ui/novo/`. Os comandos continuam com os contratos existentes. Para voltar à interface anterior, abra `/admin/ui/` pela conexão administrativa privada ou acesse Configurações → Saúde e operações. O retorno à interface anterior conserva os dados e as auditorias gravados.

## Paridade verificada no inventário

| Acesso | Cobertura |
|---|---|
| React A+B | Cadastro idempotente, LPs, publicação e diagnóstico de instalação, investigação, revisão e autorização de proteção, inventário e revisão de CTAs, premissas e vínculos por LP. As jornadas integradas anteriores continuam na suíte. |
| React C, jornadas desktop e mobile | Visão Geral com filtros de projeto/período e diagnóstico de LP, histórico retornado de incidentes, fila de revisão com cancelamento de tentativas futuras, estimativa e vendas por moeda; preferências SMTP; modelos comerciais, teste de amostra, contas e webhook; pausa/reativação, mudanças de URL, arquivo, exclusão, restauração de projeto e consultas de histórico. |
| React C, operações com regressão de contrato no servidor | Liberação e reconhecimento de resultado desconhecido com confirmação e revisão do item, rotação e ações de estado de conta, histórico comercial. Configuração salva, amostra aceita e tentativa de transporte têm significados distintos. |
| Painel anterior | Troca do ponteiro de política de entrada do projeto, captura CTA via iframe loopback no laboratório, métricas HMAC legadas e vínculos comerciais sem LP. As operações avançadas de migração de formato ficam acessíveis pelo fluxo administrativo existente conforme o contrato de cada ambiente. A prévia de purga mostra os bloqueadores. |
| CLI/API privada | Histórico e configuração completos de saúde, importação de evidências originais, chaves comerciais do emissor, operações de recuperação, retenção e configuração privada de infraestrutura. Uma ponte web futura deve usar sessão administrativa, permissões por operação e auditoria no servidor. Bearer e chaves permanecem no canal privado. |
| Backend sem contrato disponível | Renomear projeto/LP, editar a origem principal, restaurar LP excluída, purgar fisicamente projeto, validar entrega na caixa postal e atribuir receita recuperada à proteção. |

A conferência usa os contratos do painel antigo em `apps/admin-ui.ts`, a [matriz funcional](FUNCTIONAL-MATRIX.md) e o inventário local da V2.2 em `docs/design/proposal-v2-2/PARITY.md`. As lacunas mantêm a paridade parcial.

## Provas e homologação

Execute `npm run build` e `node --test dist/tests/admin-frontend.test.js` com PostgreSQL isolado em `TEST_DATABASE_URL`. Para capturas, indique a pasta de saída em `TEST_FRONTEND_C_CAPTURES`. Os casos usam Chromium com desktop e mobile emulado e dados sintéticos. A CI executa também as regressões de backend e infraestrutura de laboratório.

O relatório comercial separa moedas e mantém o horizonte das observações em até sete dias. A estimativa usa a premissa atual de cada projeto. O dashboard mostra estados de cadastro e diagnósticos de instalação disponíveis, sem afirmar mitigação efetiva. A publicação, a aprovação e a autorização conservam seus escopos. A exclusão de LP retira URLs e vínculos próprios e preserva âncora e histórico. A restauração de projeto retorna pausada.

Homologue SMTP, conta comercial e verificador com serviços e páginas autorizados antes do uso operacional. Confirme habilitação e origem do webhook no gateway autorizado já configurado. Reverter o frontend ou voltar ao painel anterior mantém os registros; reversão de alterações administrativas deve seguir o contrato da operação.
