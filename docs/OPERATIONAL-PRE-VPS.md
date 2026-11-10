# Perfil OPERATIONAL — preparação sem deploy

Estado: IMPLEMENTADO PARCIALMENTE, homologação externa pendente. Complementa HTTPS-OBSERVE-RUNBOOK.md; suas instruções históricas PILOT_OBSERVE continuam próprias do piloto. Não instalar VPS, mudar DNS, criar segredos ou executar migrations de produção nesta etapa.

O Compose base permanece em PILOT_OBSERVE. O opt-in explícito usa os mesmos serviços e imagem:

```bash
docker compose -f infra/https/compose.yaml -f infra/https/operational.yaml config --quiet
```

Forneça somente os caminhos privados e tag imutável exigidos no runbook existente. Use `--quiet`: o render completo pode mostrar ambiente privado. O overlay altera somente GATEWAY_MODE. Não autoriza páginas, não ativa destinos e não fornece LOW/HIGH operacional. Para voltar à configuração de piloto, selecione somente o arquivo base; piloto exige sua própria configuração PILOT_ORIGINS válida.

OPERATIONAL multiprojeto usa projetos/LPs persistidos: omita PROJECT_ID para esse modo. DATABASE_URL, PUBLIC_GATEWAY_HOST e RUNTIME_PUBLIC_ORIGIN devem corresponder ao ambiente privado aprovado; origens autorizadas e aprovações/gerações de cada LP permanecem no banco. Não reutilize ALLOWED_ORIGIN, SCOPED_LAB_* ou LAB_CONTROLLED_*; o servidor recusa configuração laboratorial. SMTP é configurado exclusivamente conforme CLONE-SMTP.md, nunca por credenciais no painel/browser. CTA/saúde e backlog têm prova controlada na [Frente 2](PRE-VPS-FRONT2.md); recebimento externo permanece sem homologação.

Pré-requisito antes de iniciar em qualquer ambiente futuro: banco com migrations compatíveis pelo fluxo autorizado, imagem do SHA validado, hostname/TLS, backup e rollback aprovados. A montagem initdb do Compose só inicializa volume novo; não é migrador de upgrade. Não usar down -v, não reaplicar SQL em volume existente, não publicar o admin privado. Este perfil não resolve o verificador F08 nem a lacuna de invisibilidade do operador.

Smoke em laboratório/futura operação autorizada:

```bash
node dist/apps/installation-smoke.js https://HOST-APROVADO OPERATIONAL UUID-DA-INSTALACAO
```

O UUID deve ser da instalação persistida da LP. O smoke usa `/i/<UUID>/runtime.js`, Core e Fallback na mesma origem; sem UUID não tenta descobrir páginas. Esse recurso público não é segredo nem autorização comercial. O caminho scoped evita depender de `/runtime.js` legado, ausente no modo multiprojeto. Certificados usam a trust store normal; somente testes sintéticos usam NODE_EXTRA_CA_CERTS com a CA própria. Não desabilitar verificação TLS.

O resultado exige healthz OPERATIONAL/SCOPED_AUTHORIZATION_REQUIRED, recursos JS disponíveis e `/admin`/`/login` fechados. O padrão sem argumento continua exigindo PILOT_OBSERVE e recusa OPERATIONAL. Transport ready não significa browser verificado: NOT_VERIFIED permanece nesse smoke. O [verificador controlado F08](F08-CONTROLLED-VERIFIER.md) é opt-in separado do admin privado, por LP/revisão, com resultado limitado à carga ensaiada; gateway público não recebe Docker. Para mitigar uma cópia controlada é necessário publicar políticas, aprovar o snapshot/gerações e autorizar explicitamente contexto HTTPS da LP no painel existente. Suspensão/lifecycle/gerações inválidas impedem novas admissões; snapshots já preparados seguem D09. Stealth ON conserva UNCERTAIN e pode revelar mitigação ao operador.

Prova prática: operational-authorization.test.ts com PostgreSQL, Chromium e Nginx/TLS sintéticos; compara os Compose renderizados e exercita sessão MFA/CSRF, publicação/rotação, autorização/suspensão, dois projetos, original intacto, cópia, Page Redirect/CTA e falha real do gateway. Não comprova DNS, TLS, provedor SMTP, firewall ou instalação de site real.
