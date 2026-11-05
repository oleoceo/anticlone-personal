# Interpretador comercial isolado — laboratório

O módulo `apps/commercial-interpreter.ts` é chamado explicitamente apenas pelos testes. Não integra runtime, API, importação comercial do PR #39, banco, alertas ou políticas. Interpretar valores **não comprova associação com oferta ou CTA**. F25/F41 e GS08/GS17 integrais continuam parciais/pendentes; o protótipo contextual permanece BLOCKED, separado desta branch.

## Contrato de interpretação

`interpretText` recebe um trecho de texto e evidência opcional de texto visual (`struck`: texto riscado). Retorna candidatos com texto bruto, moeda, escala, unidades mínimas em string decimal, estado de normalização, significado, evidência e motivo. RESOLVED refere-se apenas à moeda/quantia; o significado pode continuar UNKNOWN. UNRESOLVED não oferece quantia numérica. REJECTED documenta formato inválido. Nenhum resultado autoriza ação sobre conversões.

Registro extensível de moedas: BRL/USD/EUR/GBP com escala 2, JPY com escala 0 e KWD com escala 3. Códigos ISO são maiúsculos e sensíveis a caixa. Símbolos iniciais: R$, US$, €, £, ¥ e د.ك; $ isolado permanece ambíguo. Não há câmbio. Valores positivos ou zero; negativos, sinais explícitos e zeros iniciais são rejeitados. Até 18 algarismos inteiros; representação por concatenação de dígitos e BigInt, sem float monetário.

Inteiros sem separadores ou agrupados em trios por ponto, vírgula, espaço, NBSP, narrow NBSP ou apóstrofo. Decimais usam ponto/vírgula com exatamente a escala da moeda, sem misturar separadores de agrupamento. Exemplos equivalentes: `BRL 1.234,56`, `BRL 1,234.56`; `KWD 1,234.567`, `KWD 1.234,567`. Inteiros são permitidos sem parte decimal. `KWD 1.234` permanece UNRESOLVED (1,234 versus 1234). `JPY 12.50`, `USD 12,34.56`, `BRL 1.23,45`, `USD 01`, `USD 10%` são rejeitados. Não se extraem números sem moeda explícita, telefones, percentuais ou quantidades comuns.

A classificação usa frases completas e restritas, sem inferência de oferta: `Preço: @`, `Price: @`, `Agora @`, `Total @` → PRICE_CURRENT; `De @`, `Antes @`, `Was @` ou texto inteiramente riscado → PRICE_PREVIOUS; `Economize @`/`Save @` → SAVINGS; `12x de @ sem juros`/`Parcela @` → INSTALLMENT; `Assinatura: @/mês`, `@ per month` → RECURRING. `@` representa um único candidato. As expressões exatas reconhecidas estão nas regras do módulo. Não calcula total de parcelas nem presume que recorrência seja preço integral. Texto livre, frase incompleta, múltiplos candidatos no mesmo trecho ou sinais conflitantes permanecem UNKNOWN. `Preço @ por mês` é UNKNOWN, jamais preço atual integral. Texto riscado com frase de preço atual é conflitante.

## Extração e limites

`collectVisibleText` executa explicitamente no browser, somente leitura. Percorre texto renderizado no DOM comum, preserva texto inline no mesmo trecho e separa blocos. Descarta script/style/template/noscript, controles de formulário, conteúdo sem layout, display none, visibility hidden e opacity zero. Não lê atributos aria, marcadores, schema.org ou destinos. Não acessa iframes/shadow DOM, pseudo-elementos, canvas, imagens/OCR nem preços após interação. Visível significa renderizado por estes critérios; não garante ausência de sobreposição, clipping, transformação ou estar dentro do viewport.

Limites: 512 caracteres por trecho interpretado, 32 candidatos por trecho; controles, caracteres de formato e surrogates inválidos descartam o trecho. A coleta tem orçamento de 20.000 visitas/caracteres e 256 trechos; exceder retorna LIMIT_EXCEEDED sem resultados parciais. Não há persistência ou telemetria; evidência fica apenas no resultado em memória.

## Provas

`tests/commercial-interpreter.test.ts`: formatos e escalas, precisão além do limite seguro de Number, rejeições, ambiguidade, classificações e conflito, Chromium real em localhost, extração inline/riscado/oculto, múltiplos valores, orçamento, ausência de requisições/mutações e barreira estática contra importações/consumidores de produção. A suíte PostgreSQL/Chromium existente permanece sem alterações. SHA, revisão detached e CI final serão registrados no PR.

Preservação anterior: diff binário e arquivos não rastreados exportados para `C:/Projetos/anticlone-interpreter-preservation-20261105`, sem commit/push ou alteração na worktree bloqueada. Os testes adversariais anteriores foram conservados como evidência, não importados como código aprovado.
