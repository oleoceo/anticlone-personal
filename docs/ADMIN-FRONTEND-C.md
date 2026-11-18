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

Para operar ofertas próprias, são indispensáveis o acesso administrativo privado, a provisão da chave do emissor quando houver checkout integrado e um caminho validado de backup/restauração. Linux/CLI/API privada também são necessários para configurar e verificar o monitor de saúde quando a operação depender dele. As LPs e os checkouts com vínculo por LP podem ser administrados no React. Durante a transição, podem permanecer em área avançada a captura CTA laboratorial, a troca do ponteiro de projeto, a migração de formato comercial, os vínculos sem LP e as métricas HMAC legadas, salvo se uma oferta em uso depender especificamente deles.

## Ordem de integração

A cadeia é #79 (base `main`) → #80 (base da Entrega A) → #81 (base da Entrega B). Com autorização futura, integrar na mesma ordem, preferindo o método que preserva os commits do PR caso a política da branch permita. Depois de cada integração, confirmar o destino do PR seguinte, conferir que o diff contém só a entrega esperada e exigir CI no resultado atualizado. Se o método de merge mudar os SHAs, reconciliar a base e o diff antes do próximo PR. A aprovação laboratorial dá evidência sobre o código testado. A abertura dos PRs não autoriza merge nem publicação em produção.

## Provas e homologação

Execute `npm run build` e `node --test dist/tests/admin-frontend.test.js` com PostgreSQL isolado em `TEST_DATABASE_URL`. Para capturas, indique a pasta de saída em `TEST_FRONTEND_C_CAPTURES`. Os casos usam Chromium com desktop e mobile emulado e dados sintéticos. A CI executa também as regressões de backend e infraestrutura de laboratório.

O relatório comercial separa moedas e mantém o horizonte das observações em até sete dias. A estimativa usa a premissa atual de cada projeto. O dashboard mostra estados de cadastro e diagnósticos de instalação disponíveis, sem afirmar mitigação efetiva. A publicação, a aprovação e a autorização conservam seus escopos. A exclusão de LP retira URLs e vínculos próprios e preserva âncora e histórico. A restauração de projeto retorna pausada.

## Checklist de prontidão

| Área | Testado em laboratório | Pendente de homologação externa |
|---|---|---|
| Acesso privado | Sessão compartilhada, MFA/TOTP, expiração, CSRF e isolamento do administrador | Confirmar acesso SSH privado, autenticação e ausência do admin nas rotas públicas reais |
| PostgreSQL e recuperação | Migrações da suíte, backup e restauração em ambiente isolado, conferência de integridade e regressão de rollback | Conferir backup, retenção e restauração em destino isolado com dados operacionais autorizados |
| Oferta e instalação | Cadastro de projeto/LP, publicação e diagnóstico, cenários do verificador controlado | Escolher uma oferta e LP autorizadas, confirmar URLs, códigos, carregamento e verificação na página real |
| SMTP | Configuração versionada, preferência, tratamento de falhas e fila de revisão em laboratório | Configurar o transporte privado e conferir o recebimento real na caixa de destino |
| Comércio | Modelos, contas, webhook autenticado com emissor sintético, vínculos e vendas reportadas | Provisionar a chave pelo canal privado, enviar evento de teste do provedor real e verificar modelo, moeda e vínculo |
| Proteção | Publicação, aprovação por LP, autorização separada e testes de PAGE_REDIRECT e REPLACE_CONVERSION | Validar ambas as ações em contexto controlado autorizado, incluindo destino efetivo e comportamento quando a proteção recusa a ação |
| Observabilidade | Histórico de investigação, sinais de instalação, tentativas de entrega e recuperação em cenários controlados | Confirmar cobertura do monitor e responsáveis por alertas e recuperação no ambiente real |
| Retorno ao painel anterior | Sessão compartilhada e operações legadas preservadas | Confirmar acesso por `/admin/ui/` no canal privado e ensaiar o retorno antes de depender do painel novo |

**Indisponível no backend:** atribuição comprovada de receita recuperada, confirmação automática de entrega na caixa postal, edição de nome/origem principal, restauração de LP excluída e purga física. Valide SMTP, webhook e instalação no ambiente autorizado. O retorno ao painel anterior conserva gravações e auditorias. A reversão de uma alteração administrativa segue o contrato daquela operação.
