# Descoberta e substituição de CTA por cópia

Na tela **Políticas de proteção → Substituir CTAs**, selecione a URL exata da cópia. Abra a cópia com o runtime ativo para gerar observações. Expanda o cartão, confira o destino nativo disponível, escolha o novo destino e ajuste os percentuais. O nome pertence à configuração administrativa. Continuam valendo o escopo projeto/LP/cópia/caminho e a identidade técnica do CTA.

## Cobertura

- Âncoras HTTPS de checkout, compra, oferta e WhatsApp detectadas por destino ou indícios comerciais. Um marcador existente tem precedência. IDs do elemento ou de seu contêiner ajudam a distinguir âncoras com destino igual. Candidatos indistinguíveis ficam incompatíveis.
- Links em conteúdo inserido no DOM, incluindo diálogos de desconto e ofertas de saída. O inventário mantém até 50 pontos recentes por cópia por sete dias. O core observa mutações por até dois minutos, com varreduras agrupadas e orçamento de envio. A substituição depende da presença do elemento e da política preparada no momento do clique.
- Botões comuns fora de formulários com handler inline ativo que se limita a uma atribuição literal de location ou location.href. Abertura via window.open, atributos de checkout sem navegação verificável, funções arbitrárias e esquemas de app ficam como evidência para análise. A representação do handler pelo navegador pode levar a fail-open.
- O inventário reporta origem e caminhos públicos reconhecidos. Caminhos arbitrários, query, fragmento e números de WhatsApp ficam fora da apresentação. O SHA-256 local valida o destino completo.
- A marca **Execução observada no runtime** é uma evidência do cliente vinculada à cópia, ao CTA e à versão da regra. A URL final é verificada no navegador de teste. Cada regra usa quatro percentuais e cada edição registra uma nova versão.

## Compatibilidade e operação

- Um bootstrap carregado de uma origem remota atualizável recebe a descoberta e a substituição novas quando a origem começa a servir a versão. Um bootstrap congelado compatível com o contrato anterior continua podendo substituir suas âncoras marcadas. Se só o core remoto for atualizado, ele pode identificar CTAs novos e os mostrar como incompatíveis na ausência do bootstrap novo.
- A cópia de homologação serve /js/a.js localmente. A versão de laboratório foi injetada apenas na resposta do navegador isolado, mantendo o HTML público intacto. Os destinos foram simulados. Sem execução de runtime, a página segue sua navegação própria.
- O primeiro clique usa a decisão local após resposta do gateway e validação assíncrona do destino. Se o clique vier antes da preparação, a navegação nativa segue imediatamente. Páginas abertas renovam a decisão em aproximadamente 60 segundos. A política tem validade máxima local de 120 segundos.
- Abas novas via ativação normal de âncoras preservam o comportamento do link. Listeners que cancelam a ação ou navegam por conta própria e formas alternativas de abertura, como o menu de contexto, podem manter a navegação da página.

## Implantação e rollback

1. Em janela autorizada, salve o backup do banco e fixe os artefatos atuais de Admin e Gateway. Aplique a migração 073 pelo processo existente. Linhas antigas permanecem com alocação nula e o percentual antigo é aplicado às quatro classes.
2. Publique os executáveis de Gateway e Admin do mesmo SHA. Confira contrato 5 em /healthz, gateway operacional no painel, inventário e regra legada. O inventário continua usando o limite HTTP de 2 KiB dos proxies.
3. Para rollback, restaure o par de executáveis anterior e mantenha a migração aditiva. O executável anterior usa o menor dos quatro percentuais das regras criadas neste release, evitando ampliar a exposição em qualquer classe. Regras legadas mantêm o percentual original. CTAs descobertos automaticamente dependem de runtime e gateway compatíveis. Use o backup para recuperação de dados conforme o runbook.
