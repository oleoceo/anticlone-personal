# F08 — verificação controlada de instalação

Estado: IMPLEMENTADO PARCIALMENTE no fechamento geral; verificador de canais demonstrado em laboratório isolado, homologação externa pendente. Nenhuma certificação de identidade, mitigação, integridade futura ou compatibilidade universal. Opt-in privado desabilitado por padrão. Não autoriza VPS, DNS, segredos ou migrações de produção.

## Comportamento e prova

O administrador usa Verificar instalação em navegador isolado na seção Distribuição e instalação por LP. A API recebe somente projeto/Page ID/ação; URL arbitrária é rejeitada. O alvo vem de uma única URL própria persistida, de projeto/LP ativos e distribuição publicada. Duas URLs em transição, página excluída/pausada, instalação não publicada ou verificador não configurado impedem o teste. O resumo legado do projeto continua mostrando alegações não verificadas; o resultado controlado pertence exclusivamente à LP/revisão/gerações ensaiadas.

`tests/installation-verifier.test.ts` executa Chromium com sandbox num container sem rede, servidor HTTPS real sintético com validação de CA, gateway scoped/distribuição e PostgreSQL reais. O broker de teste mapeia somente os dois hostnames sintéticos para seu socket TLS loopback; esse mapeamento não existe na configuração de produção. O broker público rejeita endereços privados, inclusive loopback/metadata. A prova de laboratório não é teste de DNS/TLS público.

| Contexto ensaiado | Resultado observado |
|---|---|
| Snippets reais, Core/Fallback e canários | FULL dos canais desta carga; Core/Fallback recebidos e persistidos no PostgreSQL; nenhum incidente no original |
| Preload/IMG dos scripts e POSTs manuais | PARTIAL; não comprova execução de Bootstrap/Core/Fallback |
| Scripts bloqueados por CSP, canários permitidos | PARTIAL, somente HTML/CSS canários |
| CSP bloqueia todos os canais | UNSUPPORTED nesta carga |
| COEP/COOP/CORP não reproduzível | NOT_VERIFIED, ISOLATION_POLICY_NOT_REPRODUCED |
| Documento ou gateway indisponível | NOT_VERIFIED, CHECK_FAILED; não inventa incompatibilidade |
| Geração/configuração alterada durante verificação | NOT_VERIFIED, CONFIGURATION_CHANGED; positivo anterior não valida nova configuração |

Foco fortalecido em `test-results/f08-focused/20261110T202040Z`: **2 PASS, 0 FAIL, 0 SKIP**, exit **0**, 47 s. Inclui origens/IDs de outro projeto recusados, URL metadata rejeitada, formulário nativo não enviado, retenção periódica e tentativa real TCP/UDP ao host a partir do container sem sucesso. O código desta execução é working copy sobre 08f553c; os gates finais precisam identificar o novo SHA. A primeira versão sem prova de execução passou casos básicos, mas a revisão encontrou falsos positivos e estes foram corrigidos antes do aceite. Um erro de teste de retenção e a incompatibilidade de Debugger com JavaScript globalmente desligado também foram reproduzidos/corrigidos; não se declara sucesso de execuções intermediárias com erro de wrapper/build.

## Isolamento e mediação

O diagnóstico independente `/root/f08_sandbox_diagnosis` demonstrou que seccomp padrão negava user namespaces; não era impossibilidade comprovada do host. O perfil oficial permite a criação de namespaces usada pelo sandbox. O delta local permite o syscall chroot sem acrescentar capacidades ao container; o kernel continua negando chroot fora do user namespace. Fontes primárias: [Playwright Docker](https://playwright.dev/docs/docker) e [perfil oficial](https://raw.githubusercontent.com/microsoft/playwright/main/utils/docker/seccomp_profile.json).

`infra/verifier/seccomp.json` contém a cópia com SHA de origem `cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849`, default ERRNO, delta chroot e licença Apache-2.0 preservada. A imagem Playwright está fixada por digest no Dockerfile. Chromium usa chromiumSandbox:true; não se usa --no-sandbox, privileged, seccomp unconfined, rede host ou IPC host.

Cada execução recebe nome aleatório exclusivo e limite de 512 MiB/128 PIDs/1 CPU. Usuário 1000, filesystem read-only, nenhum bind do host, nenhuma credencial de banco/SMTP, capacidades ALL removidas, no-new-privileges e rede none. Apenas tmpfs de trabalho é gravável. Logging do container é desabilitado para não reter diagnósticos de página no daemon. O teste inspeciona a configuração real, CapEff zero e ausência de binds, e tenta conexões TCP/UDP para o host. WebSockets são fechados pelo browser; WebRTC/UDP não têm interface/rota de saída. O diagnóstico original também mostrou namespace separado e somente loopback.

O browser não abre sockets para páginas. Envia pedidos limitados por JSON/stdio ao mediador Node externo; cada resposta contém bytes de um request HTTPS real autorizado. Não há proxy HTTP genérico, socket Docker dentro do browser ou protocolo que aceite comandos do site. O processo privado externo tem autoridade Docker e deve ser operado como tal; não conceder Docker/socket ao gateway público nem publicar o admin. Não se altera firewall, sysctl ou serviços de terceiros.

O broker público aceita HTTPS, porta padrão, sem credenciais/fragmento, mantém validação TLS/SNI e fixa o IP após validar todos os resultados DNS como públicos. Não segue redirects, não usa proxies do ambiente, cookies, autenticação ou compressão. Limites: DNS 1,5 s, HTTPS 4 s, corpo 512 KiB e total 2 MiB; até 64 pedidos, uma verificação por processo, prazo externo de 25 s e watchdog interno de 22 s. Falha de cleanup mantém nova admissão fechada até reconciliação/reinício, com NOT_VERIFIED. Remoção atinge somente o nome aleatório criado pela chamada.

São permitidos o documento exato, seus assets de tipos limitados na mesma origem e recursos exatos da distribuição. POST é limitado aos dois endpoints Core/Fallback da instalação, origem/pathname exatos e sinais vazios, sem campos de formulário/dados de visitante. Métricas, decisões/ações, navegações, destinos de checkout e URLs de terceiros não são encaminhados. AbortSignal cancela os sockets do broker no encerramento. Requests recusados guardam somente contagem, nunca payload/URL hostil ou erro de provedor.

## O que FULL significa

O passe normal exige execução no frame principal: cobertura CDP e SHA-256 do script executado iguais aos bytes HTTPS recebidos dos recursos esperados. Download/preload ou sourceURL forjado sem bytes/execução correspondentes não basta. Core precisa emitir POST aceito pelo gateway. O segundo passe bloqueia Core e exige Fallback executado e POST próprio. O terceiro impõe uma política adicional script-src 'none', por interseção com a CSP existente, e exige recursos iniciados por IMG/CSS. CDP é instrumentação confiável; não é código do site.

Esse terceiro passe representa scripts da página bloqueados por CSP. Não afirma JavaScript globalmente desligado: conteúdo noscript pode diferir. Como route.fulfill não reproduz fielmente toda a fronteira COEP/CORP, políticas de isolamento ativas recebem NOT_VERIFIED em vez de FULL. Isto é limitação explícita do verificador, sem aprovação fictícia. Não existe teste de aplicação/formulário/checkout ou mitigação ativa neste diagnóstico; activeMitigation permanece NOT_TESTED. Canários continuam passivos.

Cada passe espera DOMContentLoaded (até seis segundos) e observa por mais 1,2 s, dentro do prazo global. Conteúdo que só aparece posteriormente não é certificado; PARTIAL/UNSUPPORTED descrevem essa janela, não impossibilidade permanente do site. Não se trata de benchmark p95/p99 nem homologação de SPA/formulário. Repita após corrigir instalação ou use a análise de compatibilidade aplicável, preservando o horário da prova anterior.

O resultado descreve aquela carga/horário, não saúde atual garantida, persistência futura dos scripts, identidade do operador ou efeito comercial. Não eleva risco, publica políticas nem autoriza mitigação. D05/D07/D09/D15 não mudam.

## Persistência, operação e reversão

Migration aditiva 056: resultado por projeto/LP/revisão/gerações, sete dias e dez registros por LP. O mediador libera conexão/locks antes do browser e revalida snapshot/estado ao gravar. Inspeção não usa resultado de geração/revisão antiga, projeto/LP pausado/excluído ou registro expirado. Manutenção periódica expira registros mesmo sem nova verificação. O resultado não substitui sinais não autenticados nem vira fonte independente de identidade.

Para laboratório autorizado: construir `docker build -f infra/verifier/Dockerfile -t anticlone-verifier:<SHA> .`, usar imagem validada em INSTALLATION_VERIFIER_IMAGE no ambiente privado do admin e manter perfil local aprovado. Não aplicar 056 em produção nesta entrega. A API pública não configura imagem, seccomp ou destinos. O gateway público não precisa de Docker.

Para desabilitar, remover o opt-in privado e reiniciar somente o admin pelo procedimento autorizado; consultas/dados históricos e runtime permanecem disponíveis. Não remover banco/volume, não reverter migrations destrutivamente. Homologação em site/conta real, provisionamento privado, recursos/monitoramento do host e acesso Docker requerem etapa operacional autorizada.
