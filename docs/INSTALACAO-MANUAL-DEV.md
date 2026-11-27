# Instalação manual em HTML no DEV

Na página protegida, abra **Instalação** e publique os endereços. Os cinco blocos apresentam os nomes e o conteúdo completos da revisão. Copie os três arquivos primeiro e publique a atualização da index.html por último.

| Bloco do painel | Arquivo | Local e função |
| --- | --- | --- |
| HEAD | `index.html` existente | Depois do charset. Preconnect, dois scripts assíncronos relativos e a folha CSS local. |
| BODY | `index.html` existente | Antes de fechar o BODY. Uma imagem dedicada envia o sinal HTML ao servidor. |
| JavaScript · Bootstrap | Arquivo `app` indicado em `js/` | Crie com o conteúdo integral. Carrega o Bootstrap publicado, que obtém o Core e consulta os endpoints da revisão. |
| JavaScript · Fallback | Arquivo `events` indicado em `js/` | Crie com o conteúdo integral. Carrega o Fallback publicado independentemente do Core. |
| CSS · Canário | Arquivo `signals` indicado em `css/` | Crie com o conteúdo integral. O seletor corresponde apenas à imagem dedicada e sua URL de fundo envia o sinal CSS ao servidor. |

Os nomes do contrato de arquivos usam o identificador de publicação do gateway. Para contratos anteriores, os nomes dos carregadores são derivados do SHA-256 do par de arquivos. O nome da folha CSS é derivado do SHA-256 do seu conteúdo. Os identificadores resolvem aliases e ajudam a atualizar arquivos locais. O gateway serve o runtime da versão instalada no servidor. A publicação preserva os aliases históricos e o navegador pode bloquear sinais com CSP, extensões ou configurações de privacidade.

Em uma atualização, substitua os dois blocos antigos pelos blocos da nova revisão. Se houver uma instalação anterior que exige classes no HTML comercial ou regras na folha de estilos existente, retire apenas esses trechos da instalação anterior. Compare os arquivos publicados com os códigos copiados e visite a URL oficial em um navegador para verificar as camadas.

## Auditoria da FlowMembers

A cópia histórica de `index.published.html` mostra dois scripts absolutos em `web-frame.net/assets/js/` e o preconnect para `static-layer.com`. O procedimento histórico também inseriu `anticlone-canary` no elemento principal e adicionou uma regra ao CSS da LP. O formato aprovado usa arquivos locais na pasta `js/`, com JavaScript que mantém as referências operacionais da revisão.

A cópia pública adquirida nesta rodada contém duas âncoras de checkout de teste e as marcações antigas de ponto e superfície. Os três endereços públicos foram abertos em Chromium. A LP atual não carregou scripts dos hosts operacionais examinados. Esse levantamento é a linha de base anterior à reinstalação.

O Blueprint prevê cinco camadas, observação passiva por HTTP, origem legítima preservada e planejamento de pontos de conversão pelo painel. A instalação anterior exigia uma classe em um elemento já existente. O contrato de arquivos desta alteração usa uma imagem dedicada. O fluxo antigo usa importação JSON ou captura de laboratório por loopback. Após a migração 081 e a atualização do gateway e do Admin, Conversões e CTAs mostra candidatos recebidos ao abrir a LP oficial em HTTPS. Políticas de proteção permite revisar os candidatos observados na cópia e configurar seus destinos. A captura da LP oficial é informativa e a regra é aprovada para a cópia selecionada. URLs podem aparecer sem parâmetros ou com o caminho omitido. Botões sem destino verificável aparecem para revisão. O fluxo antigo permanece disponível para instalações legadas.

Os três documentos históricos indicados em `SOURCES.md` não foram encontrados nas árvores locais consultadas. A comparação histórica se limita aos artefatos encontrados da FlowMembers e ao Blueprint.
