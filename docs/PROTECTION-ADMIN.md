# Configuração da proteção no painel existente

## Redirecionamento de página

Em **Políticas de proteção → Redirecionar página**, salve **Para onde redirecionar** como destino padrão do projeto. Em **Redirecionamento por cópia**, informe a origem HTTPS e o caminho exato que está autorizado a testar, escolha os percentuais por classe e confirme a ativação. Cada cópia pode herdar o padrão ou ter seu próprio destino. Alterar o padrão publica novas versões para as regras ativas que o herdam; regras com destino específico mantêm sua versão.

O destino HTTPS pode estar em um domínio externo e é gravado no PostgreSQL após confirmação do administrador. Cada gravação, edição e desativação tem revisão imutável e auditoria. O gateway só usa destinos confirmados e nunca os consulta no backend. A validação recusa credenciais, fragmentos e destino na origem da cópia para evitar retorno à própria cópia. Alterar ou desativar uma regra dispensa alteração de ambiente ou deploy. A suspensão operacional existente desativa também uma regra específica da mesma origem e caminho. A LP oficial fica fora da mitigação.

A ativação por cópia requer migration 070, instalação publicada e gateway público OPERATIONAL que anuncie `X-AntiClone-Redirect-Contract: 2`. O Bootstrap inicia a decisão em paralelo com o Core. O Chromium só navega se receber e processar a decisão dentro de 150 ms e antes de interação ou mudança de contexto. `Server-Timing` informa os tempos de roteamento e de processamento do gateway. O tempo no navegador também inclui rede e execução local.

## Conversões e CTA


Na sessão administrativa com senha/TOTP, a seção **Proteção por projeto — laboratório** carrega o projeto, destinos e versões persistidos. Cadastre os destinos por oferta; publique PAGE_REDIRECT e REPLACE_CONVERSION com percentuais independentes para PAID_ATTRIBUTED, ORGANIC, REFERRAL e DIRECT_UNKNOWN, em passos de 10%. A publicação de página ativa exatamente o formulário enviado numa transação, sem consumir um rascunho compartilhado entre abas. Versões anteriores de página podem ser reativadas.

No inventário existente, consulte projeto/superfície, selecione uma observação identificada por marcador estável e escolha o destino da oferta. **Mapear CTA ao destino aprovado** cria o mapeamento funcional; **Confirmar seleção pendente** continua sendo apenas intenção, sem ativação. Pontos ambíguos permanecem sem substituição; a reaprovação confirma a observação atual e preserva auditoria e isolamento do drift.

Destinos da origem oficial permanecem disponíveis. Para destinos externos de CTA, configure **nos processos privados do admin e gateway** a variável `PROTECTION_APPROVED_EXTERNAL_URLS`: um objeto JSON cuja chave é a origem exata do projeto e cujo valor é uma lista de URLs HTTPS exatas. Exemplo sintético, sem autorização para serviço real:

```json
{"http://127.0.0.1:8080":["https://checkout.fixture.test/premium?offer=synthetic"]}
```

Não há wildcard, busca DNS, fetch do destino, cópia de parâmetros do visitante ou segredo no browser. A aprovação é revalidada em publicação e decisão; mudar caminho/query exige nova URL na lista privada. Credenciais, fragmentos, IPs e nomes locais externos são recusados. O painel registra a URL na oferta apenas se ela já estiver autorizada no ambiente. Uma URL aprovada pode, no destino, redirecionar novamente; o sistema não verifica nem promete controlar esse comportamento externo.

A configuração administrativa também aceita projetos HTTPS próprios; publicar não concede elegibilidade de execução. Inventário/mapeamento e execução continuam limitados ao laboratório: origem oficial/clone em loopback, LOW sintético explícito e cópia autorizada. HIGH, UNCERTAIN, falhas e PILOT_OBSERVE mantêm OBSERVE_ONLY. A preparação CTA conserva D08/D09: resposta até 5 s, validade até 120 s desde o início, renovação prevista em 60 s e clique local sem rede. PAGE_REDIRECT conserva o prazo de 150 ms e fail-open. Aprovar destinos não autoriza ativação operacional.

Prova integrada: `tests/protection-admin-ui.test.ts` usa schema PostgreSQL isolado com migrations 001–032, login e CSRF reais, Chromium, gateway Node e checkout HTTPS sintético servido em loopback com resolução local de `checkout.fixture.test`. Nenhum serviço comercial externo é acessado. Os testes existentes de GS06, GS08 e refresh continuam cobrindo timeout, falhas, drift e atualização de políticas.
