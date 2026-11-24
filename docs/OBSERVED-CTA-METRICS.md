# Métricas observadas de CTA

## Coleta e atribuição

A Visão Geral usa o horário de recebimento no gateway, em UTC, e oferece recortes de 24 horas e sete dias. As sessões são deduplicadas por projeto e identificador de sessão dentro do recorte. Se mais de uma LP ou cópia observou a mesma sessão, o primeiro registro no recorte determina a classe da sessão no gráfico e na distribuição. Cliques são eventos aceitos com recibo válido. Sessões com clique são deduplicadas no total por projeto e identificador, mesmo quando a mesma sessão ativa dois CTAs. Os totais por CTA não são aditivos para sessões.

O Bootstrap congela os sinais declarados no primeiro contato disponível no `sessionStorage` daquela origem e mantém o mesmo identificador ao recarregar e voltar. Uma sessão inicialmente direta que recebe `utm_medium=cpc` depois continua direta. Uma nova sessão com click ID aceito ou mídia paga declarada é paga, mesmo com referência de busca. Google, Bing e DuckDuckGo reconhecidos viram orgânico na ausência de sinal pago. Outros hosts externos válidos viram referência. A ausência de sinal suficiente vira direto ou desconhecido. UTMs e click IDs não autenticam campanhas. O Core conserva seu papel de observação de contexto, enquanto a decisão e a coleta de sessões recebem os mesmos sinais iniciais do Bootstrap.

O clique por elemento usa o marcador e a superfície validados no recibo. Para regras CTA 2.0, o vínculo com cópia e a versão da regra vêm do gateway. O alias é consultado na versão do último clique do elemento no recorte. O filtro por cópia exige projeto, LP, origem e caminho exatos. A primeira visita a uma cópia ainda fora do inventário pode produzir uma sessão sem vínculo com a cópia. Históricos sem vínculo permanecem nos totais mais amplos. Visualizações de página, chegada ao checkout e receita efetivamente recuperada ficam indisponíveis.

## Entrega de cliques

No Dev de referência, uma consulta somente leitura encontrou 108 recibos CTA preparados para quatro identificadores de sessão e zero fatos de clique ou de sessão correspondentes. A coluna de cópia existia e o banco consultado pelo Admin era o mesmo do Gateway. Isso localiza a lacuna após a emissão e antes da persistência. O código anterior descartava silenciosamente o retorno `false` de `sendBeacon()` e iniciava a navegação de CTAs por botão antes do envio. Não havia registro de rede para identificar qual falha respondeu pelos cliques históricos. Cliques de CTA e sessões agora usam POST CORS com `keepalive` e sem credenciais. A ativação de CTA por navegação explícita enfileira o evento antes de iniciar a navegação. Um snapshot novo após Voltar usa o recibo da decisão renovada. Cliques sintéticos de script em âncoras seguem o comportamento de destino existente e ficam fora da coleta.

Os recibos expiram em 120 segundos e as observações são idempotentes por projeto e ID de evento. Respostas de erro podem ser verificadas na aba Rede com o histórico preservado. Um 400 indica payload, ponto ou recibo incompatível ou expirado. 429 indica limite de tráfego. 503 abrange falhas de persistência, capacidade ou contexto indisponível. O navegador pode bloquear a entrega por CSP, política de rede, encerramento de aba ou saturação do orçamento de keepalive. Uma decisão sem recibo ainda pode substituir o CTA. A persistência do recibo e dos fatos mantém os tetos existentes de 10 mil por projeto em sete dias. Os registros são alegações de navegador e não autorizam mitigação, chegada ou venda.

## Estimativa

**Configurar estimativa** usa as premissas versionadas do projeto. As premissas atuais são aplicadas aos cliques do recorte. Receita potencial é o produto dos cliques aceitos, da taxa de conversão e do ticket médio. O painel exibe moeda, taxa, ticket, versão, data e quantidade de cliques usada. Totais permanecem separados por moeda.

## Publicação e rollback

1. Em janela autorizada, registre o SHA em execução, conserve os artefatos atuais de Gateway e Admin e faça um backup pelo procedimento vigente.
2. Aplique a migração aditiva `074_observed_session_copy.sql` após a 073 pelo fluxo versionado do ambiente. A coluna é opcional e não tem retropreenchimento.
3. Publique os artefatos do mesmo SHA para Gateway e Admin. Use o Bootstrap servido pelo Gateway na cópia controlada, abra uma sessão nova, confirme os recibos na Rede e compare cliques aceitos com a Visão Geral. Confirme também duas ativações após Voltar e F5, o recorte por cópia e o cálculo por projeto.
4. Para rollback, volte os artefatos de Gateway/Admin ao SHA anterior e mantenha a coluna aditiva e seus dados. Verifique saúde, sessão administrativa e substituição de CTA na cópia controlada.
