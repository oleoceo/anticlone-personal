# Painel administrativo em React — Entrega A

O painel abre em `/admin/ui/novo/` pela conexão privada já usada para `/admin/ui/`. O build do Vite em `dist/apps/admin-frontend/` é servido pelo processo administrativo existente. A mesma sessão web vale para os dois painéis. Senha, TOTP, cookies, expiração, CSRF e validações de origem continuam no servidor. O painel anterior também é a rota de retorno durante a migração.

## Base operacional

- **Meus Projetos.** Lista real com filtro por nome e estado, seleção de projeto e LP e URLs autorizadas. O endereço da tela identifica projeto e LP. O estado do navegador conserva busca e contexto do retorno.
- **Proteger oferta.** Revisão seguida de cadastro do projeto e da primeira LP em duas operações. Uma LP também pode ser cadastrada em um projeto existente. O formulário mantém os campos enquanto a aba estiver aberta. Após uma resposta incerta, a UI consulta a auditoria pelo UUID da tentativa ou a lista de LPs. O operador pode reenviar a mesma intenção de projeto com os dados originais. O checkpoint por aba guarda identificadores e resumos SHA-256, sem senha, TOTP, CSRF ou valores do formulário.
- **Instalar e conferir.** Publicação explícita por LP, HTML e CSS do servidor, três papéis com 12 recursos, rotação e histórico, diagnóstico e coleta na origem principal. Verificação controlada depende do verificador isolado configurado no admin. Sinais e tráfego de aliases conservam o nível de evidência do servidor.

## Cobertura a migrar

- **Entrega B.** Incidentes e evidências, políticas de página e CTA, aprovação e autorização operacional, inventário e revisões de CTA, conversões, estimativas e vínculos comerciais.
- **Entrega C.** Dashboard, notificações, integrações, saúde operacional, ciclo de vida avançado de projetos e LPs e histórico administrativo. Alterações de URL, pausa, arquivo, exclusão e restauração continuam acessíveis no painel anterior durante a migração.
- **Acesso privado por bearer ou CLI.** Configuração e histórico de saúde, importação de evidências originais, provisão de chaves comerciais, backup, restauração e retenção seguem pelos caminhos existentes. A exposição de uma operação hoje exclusiva dessas ferramentas precisa de avaliação do contrato e aprovação de escopo. O inventário local de referência está em `docs/design/proposal-v2-2/PARITY.md` na worktree de design.

## Teste

Com `TEST_DATABASE_URL` de laboratório, execute `npm run build` e `node --test dist/tests/admin-frontend.test.js`. O teste usa Chromium, o servidor administrativo real, TOTP e schemas PostgreSQL descartáveis, com URLs reservadas ao laboratório. As perdas de resposta são induzidas após o servidor real confirmar a gravação. O teste mobile usa toque e viewport reduzido. O verificador isolado continua coberto pela suíte de backend HTTPS quando habilitada.

### Idempotência e retransmissão

`POST /admin/ui/project-create` aceita o cabeçalho opcional `Idempotency-Key` com UUID v4. O painel novo guarda o UUID antes da primeira chamada e o reutiliza após erro ou atualização da página. O servidor usa a chave primária do projeto e a auditoria na mesma transação. Para um UUID já usado, nome normalizado e origem equivalentes retornam o projeto existente com HTTP 200. Uma divergência retorna HTTP 409. Clientes anteriores podem continuar enviando apenas nome e origem.

O teste `transport replay before headers` corta a conexão depois do commit e antes dos cabeçalhos da primeira resposta. O Chromium retransmite os dois cadastros. Projeto retorna 200 nas duas tentativas e mantém uma linha e uma criação auditada. A segunda tentativa de LP recebe 409 pela unicidade de origem e caminho. O teste confirma uma única LP e URL e abre a instalação do registro confirmado. O contrato de LP foi mantido. A mesma suíte cobre corpo truncado, retomada com o mesmo UUID, concorrência, payload divergente e rollback por falha de auditoria.
